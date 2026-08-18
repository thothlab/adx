//! Copying files and folders off the device onto this computer.
//!
//! The mirror of [`crate::upload_tree`], and it keeps that module's two
//! contracts: exactly one terminal [`DownloadReport`] on every path out, and
//! nothing written until the user has answered the conflict question. What is
//! new here is the locking discipline, which is the reason this module exists
//! at all rather than a loop inside a Tauri command.
//!
//! # The session is held per window, not per file
//!
//! MTP allows one transaction at a time, so the whole app serialises on a
//! single [`SessionSlot`]. An upload can afford to hold that lock for its whole
//! run — the user who started it is watching it. A download cannot: pulling a
//! 4 GB video would freeze the folder tree for ten minutes, and "the interface
//! stays responsive during a transfer" is one of this product's three claimed
//! differences from Android File Transfer.
//!
//! So the file is read through `WindowedDownload`, which turns one long
//! transfer into a sequence of bounded reads, and this module takes the lock
//! **around each window and releases it between windows**. A listing issued by
//! the tree meanwhile waits for the current 8 MiB window — tens of milliseconds
//! — rather than for the file.
//!
//! Two things follow from that, and both are load-bearing:
//!
//! - `next_window()` talks to the transport directly; it does not go through
//!   [`Session`] and cannot take the lock itself. Holding the lock *across* the
//!   await is therefore the invariant, not an optimisation. Drop it early and
//!   two transactions overlap, which desynchronises the session and surfaces to
//!   the user as the device disconnecting mid-copy.
//! - Between two windows the session can legitimately be closed or swapped —
//!   the user unplugs the phone, or picks another one. So every re-acquire
//!   re-checks that the slot still holds *this* device, and gives up as
//!   `Disconnected` when it does not. Without that check the transfer keeps
//!   pulling from a backend whose device is gone.
//!
//! The walk that builds the plan follows the same rule: one lock per folder
//! listing, released in between. `collect_objects_recursive` would be one call
//! and would hold the session for the entire tree, which defeats the point.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use adx_core::{host_name, AdxError, ErrorKind};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, MutexGuard};

use crate::Session;

/// Where the one open session lives. The app owns it; this module borrows it
/// for the length of a single device transaction at a time.
pub type SessionSlot = Mutex<Option<Session>>;

/// What to do about a name that already exists in the destination folder.
///
/// Deliberately the same three answers as an upload: the dialog, the wording
/// and the reasoning are shared, and a fourth option on one side only would be
/// a difference the user has to learn for no reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadPolicy {
    /// Write nothing; report the conflicts and let the caller ask.
    Ask,
    Replace,
    Skip,
}

/// One thing the user selected in the listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadRoot {
    pub handle: u64,
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
}

/// One file to fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadItem {
    pub handle: u64,
    /// Folder chain below the destination, already safe for this filesystem.
    pub rel_dir: Vec<String>,
    pub name: String,
    pub size: u64,
}

/// What the selection expands into, resolved before a byte moves.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DownloadPlan {
    /// Folders to create, parents before children.
    pub dirs: Vec<Vec<String>>,
    pub items: Vec<DownloadItem>,
    pub total_bytes: u64,
    /// Objects the walk refused, with the reason. Carried into the report so a
    /// copy that did less than asked says which parts it left out.
    pub warnings: Vec<String>,
}

impl DownloadPlan {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && self.dirs.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadReport {
    /// Nothing was written.
    Conflicts { names: Vec<String> },
    Done {
        files: usize,
        folders: usize,
        replaced: usize,
        skipped: usize,
        bytes: u64,
        warnings: Vec<String>,
    },
    /// Stopped by the user. Files already finished stay on the computer; the
    /// one in flight does not (see `partial` handling below).
    Cancelled { files: usize, bytes: u64, warnings: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadProgress {
    pub done: usize,
    pub total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub name: String,
}

fn cancelled_error() -> AdxError {
    AdxError::new(ErrorKind::Cancelled, "передача остановлена")
}

/// The session in the slot, if it is still the device this transfer started on.
///
/// A plain `as_ref()` would be wrong: between two windows the user can close
/// the device or select another, and the slot then holds either nothing or a
/// different phone. Continuing against the latter would write one device's file
/// with another device's bytes.
fn session_of<'a>(
    guard: &'a MutexGuard<'_, Option<Session>>,
    serial: &str,
) -> Result<&'a Session, AdxError> {
    match guard.as_ref() {
        Some(session) if session.serial() == serial => Ok(session),
        _ => Err(AdxError::new(
            ErrorKind::Disconnected,
            "устройство закрыто или заменено во время передачи",
        )),
    }
}

/// Expand the selection into the files it implies, reading the device.
///
/// Runs before any writing, for the same three reasons `plan_upload` does: a
/// real byte total so progress is a fraction, every device-side read error
/// surfaced before the first file lands, and a plan that can be inspected.
///
/// # Errors
///
/// [`ErrorKind::Cancelled`] when the caller stops it mid-walk — a large tree is
/// thousands of listings and must be interruptible.
pub async fn plan_download<C>(
    slot: &SessionSlot,
    serial: &str,
    storage_id: u64,
    roots: &[DownloadRoot],
    is_cancelled: C,
) -> Result<DownloadPlan, AdxError>
where
    C: Fn() -> bool + Send + Sync,
{
    let mut plan = DownloadPlan::default();
    // (folder on the computer, name in it). Two device objects can differ by a
    // character this filesystem cannot store — "a:b" and "a?b" both arrive as
    // "a_b" — and without this the second silently overwrites the first.
    let mut taken: HashSet<(Vec<String>, String)> = HashSet::new();

    for root in roots {
        if is_cancelled() {
            return Err(cancelled_error());
        }
        let Some(name) = host_name(&root.name) else {
            plan.warnings.push(format!("{}: имя нельзя записать на компьютер", root.name));
            continue;
        };
        note_rename(&mut plan.warnings, &root.name, &name);
        if !taken.insert((Vec::new(), name.clone())) {
            plan.warnings.push(format!("{}: в целевой папке уже занято именем выше", root.name));
            continue;
        }

        if root.is_folder {
            let base = vec![name];
            plan.dirs.push(base.clone());
            walk(slot, serial, storage_id, root.handle, base, &mut plan, &mut taken, &is_cancelled)
                .await?;
        } else {
            plan.total_bytes += root.size;
            plan.items.push(DownloadItem {
                handle: root.handle,
                rel_dir: Vec::new(),
                name,
                size: root.size,
            });
        }
    }

    Ok(plan)
}

/// Depth-first walk of a folder, one listing per lock acquisition.
///
/// Iterative rather than recursive: an `async fn` that calls itself needs
/// boxing at every level, and a phone's folder nesting is not bounded by
/// anything this code controls.
#[allow(clippy::too_many_arguments)]
async fn walk<C>(
    slot: &SessionSlot,
    serial: &str,
    storage_id: u64,
    root: u64,
    root_rel: Vec<String>,
    plan: &mut DownloadPlan,
    taken: &mut HashSet<(Vec<String>, String)>,
    is_cancelled: &C,
) -> Result<(), AdxError>
where
    C: Fn() -> bool + Send + Sync,
{
    let mut stack: Vec<(u64, Vec<String>)> = vec![(root, root_rel)];

    while let Some((handle, rel)) = stack.pop() {
        if is_cancelled() {
            return Err(cancelled_error());
        }

        // One folder, one lock. The tree in the other panel can read between
        // any two iterations of this loop.
        let entries = {
            let guard = slot.lock().await;
            session_of(&guard, serial)?.list(storage_id, Some(handle)).await?
        };

        let mut subdirs: Vec<(u64, Vec<String>)> = Vec::new();
        for entry in entries {
            let Some(name) = host_name(&entry.name) else {
                plan.warnings.push(format!(
                    "{}: имя нельзя записать на компьютер",
                    display_path(&rel, &entry.name)
                ));
                continue;
            };
            note_rename(&mut plan.warnings, &entry.name, &name);
            if !taken.insert((rel.clone(), name.clone())) {
                plan.warnings.push(format!(
                    "{}: на компьютере это имя уже занято другим объектом папки",
                    display_path(&rel, &entry.name)
                ));
                continue;
            }

            let mut child = rel.clone();
            child.push(name.clone());
            if entry.is_folder {
                // Recorded when found, so parents always precede their
                // children — an empty folder therefore survives the plan, same
                // as on the upload side.
                plan.dirs.push(child.clone());
                subdirs.push((entry.handle, child));
            } else {
                plan.total_bytes += entry.size;
                plan.items.push(DownloadItem {
                    handle: entry.handle,
                    rel_dir: rel.clone(),
                    name,
                    size: entry.size,
                });
            }
        }

        // Reversed, because the stack pops last-in first: this restores the
        // listing's own order, which is the order the user sees.
        for subdir in subdirs.into_iter().rev() {
            stack.push(subdir);
        }
    }

    Ok(())
}

/// Run a plan, writing into `dest`.
///
/// `on_progress` is called as bytes land — often, so throttling belongs to the
/// caller. `is_cancelled` is polled between windows and between files, which is
/// what makes a cancel take effect without waiting out the current file.
pub async fn download_tree<P, C>(
    slot: &SessionSlot,
    serial: &str,
    storage_id: u64,
    plan: &DownloadPlan,
    dest: &Path,
    policy: DownloadPolicy,
    mut on_progress: P,
    is_cancelled: C,
) -> Result<DownloadReport, AdxError>
where
    P: FnMut(DownloadProgress) + Send,
    C: Fn() -> bool + Send + Sync,
{
    let mut warnings = plan.warnings.clone();

    if plan.is_empty() {
        return Ok(DownloadReport::Done {
            files: 0,
            folders: 0,
            replaced: 0,
            skipped: 0,
            bytes: 0,
            warnings,
        });
    }

    // ---- Pass 1: local reads only. What is already there? ------------------
    //
    // Entirely on this computer, so it costs the device nothing and takes no
    // lock. Nothing is created yet — answering "cancel" to the conflict
    // question must leave the destination exactly as it was, empty folders
    // included.
    let mut conflicts: HashSet<usize> = HashSet::new();
    let mut conflict_names: Vec<String> = Vec::new();
    for (index, item) in plan.items.iter().enumerate() {
        let target = local_path(dest, &item.rel_dir, &item.name);
        if target.exists() {
            conflicts.insert(index);
            conflict_names.push(display_path(&item.rel_dir, &item.name));
        }
    }

    if policy == DownloadPolicy::Ask && !conflicts.is_empty() {
        return Ok(DownloadReport::Conflicts { names: conflict_names });
    }

    // ---- Pass 2: writes. ---------------------------------------------------
    let mut folders_created = 0usize;
    for dir in &plan.dirs {
        let path = local_path(dest, dir, "");
        if !path.exists() {
            folders_created += 1;
        }
        tokio::fs::create_dir_all(&path)
            .await
            .map_err(|e| AdxError::new(ErrorKind::Io, format!("{}: {e}", path.display())))?;
    }

    let total_files = plan.items.len();
    let mut files_done = 0usize;
    let mut bytes_done = 0u64;
    let mut replaced = 0usize;
    let mut skipped = 0usize;

    for (index, item) in plan.items.iter().enumerate() {
        if is_cancelled() {
            return Ok(DownloadReport::Cancelled { files: files_done, bytes: bytes_done, warnings });
        }

        let target = local_path(dest, &item.rel_dir, &item.name);
        if conflicts.contains(&index) {
            if target.is_dir() {
                // Replacing a folder with a file of the same name would delete
                // the folder and everything under it. Same reasoning as the
                // upload side, and the same answer.
                warnings.push(format!(
                    "{}: на компьютере это папка, файл пропущен",
                    display_path(&item.rel_dir, &item.name)
                ));
                skipped += 1;
                continue;
            }
            match policy {
                DownloadPolicy::Skip | DownloadPolicy::Ask => {
                    skipped += 1;
                    continue;
                }
                DownloadPolicy::Replace => replaced += 1,
            }
        }

        on_progress(DownloadProgress {
            done: files_done,
            total: total_files,
            bytes_done,
            bytes_total: plan.total_bytes,
            name: item.name.clone(),
        });

        match fetch_one(
            slot,
            serial,
            storage_id,
            item,
            &target,
            index,
            bytes_done,
            plan.total_bytes,
            total_files,
            files_done,
            &mut on_progress,
            &is_cancelled,
        )
        .await
        {
            Ok(Some(written)) => {
                files_done += 1;
                bytes_done += written;
                on_progress(DownloadProgress {
                    done: files_done,
                    total: total_files,
                    bytes_done,
                    bytes_total: plan.total_bytes,
                    name: item.name.clone(),
                });
            }
            // Cancelled mid-file: the partial file is already gone, and what
            // finished before it stays.
            Ok(None) => {
                return Ok(DownloadReport::Cancelled {
                    files: files_done,
                    bytes: bytes_done,
                    warnings,
                })
            }
            Err(e) => {
                if e.kind == ErrorKind::Cancelled || is_cancelled() {
                    return Ok(DownloadReport::Cancelled {
                        files: files_done,
                        bytes: bytes_done,
                        warnings,
                    });
                }
                return Err(e);
            }
        }
    }

    Ok(DownloadReport::Done {
        files: files_done,
        folders: folders_created,
        replaced,
        skipped,
        bytes: bytes_done,
        warnings,
    })
}

/// Fetch one file. `Ok(None)` means the user cancelled part-way through it.
///
/// Written to a `.part` sibling and renamed once complete, so an interrupted
/// download never leaves a file that looks finished — and a `Replace` that
/// fails half-way has not destroyed the copy that was already there.
#[allow(clippy::too_many_arguments)]
async fn fetch_one<P, C>(
    slot: &SessionSlot,
    serial: &str,
    storage_id: u64,
    item: &DownloadItem,
    target: &Path,
    index: usize,
    bytes_before: u64,
    bytes_total: u64,
    total_files: usize,
    files_done: usize,
    on_progress: &mut P,
    is_cancelled: &C,
) -> Result<Option<u64>, AdxError>
where
    P: FnMut(DownloadProgress) + Send,
    C: Fn() -> bool + Send + Sync,
{
    let io = |path: &Path, e: std::io::Error| AdxError::new(ErrorKind::Io, format!("{}: {e}", path.display()));

    // Indexed rather than named after the file: the device name may already be
    // at the filesystem's length limit, and a suffix would push it over.
    let partial = target.with_file_name(format!(".adx-{index}.part"));

    // The reader is opened under the lock like every other device call, then
    // outlives it — that is exactly what makes windowed reading possible.
    let mut reader = {
        let guard = slot.lock().await;
        session_of(&guard, serial)?
            .open_download(storage_id, item.handle)
            .await?
    };

    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| io(&partial, e))?;

    let mut written = 0u64;
    loop {
        if is_cancelled() {
            drop(file);
            let _ = tokio::fs::remove_file(&partial).await;
            return Ok(None);
        }

        // The lock covers the device read and nothing else: the disk write
        // below happens with the session free, so a slow disk does not hold the
        // phone hostage either.
        let window = {
            let guard = slot.lock().await;
            session_of(&guard, serial)?;
            reader.next_window().await
        };

        let Some(chunk) = window else { break }; // clean EOF, empty file included
        let chunk = match chunk {
            Ok(bytes) => bytes,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&partial).await;
                return Err(crate::map_error(&e));
            }
        };

        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(io(&partial, e));
        }
        written += chunk.len() as u64;

        on_progress(DownloadProgress {
            done: files_done,
            total: total_files,
            bytes_done: bytes_before + written,
            bytes_total,
            name: item.name.clone(),
        });
    }

    // Flushed explicitly before the rename: `File`'s own drop cannot report a
    // failure, and a rename over a buffer that never reached the disk publishes
    // a truncated file under the final name.
    file.flush().await.map_err(|e| io(&partial, e))?;
    drop(file);

    tokio::fs::rename(&partial, target)
        .await
        .map_err(|e| io(target, e))?;

    Ok(Some(written))
}

/// `dest/rel_dir…/name`, joined one component at a time.
///
/// Never by formatting a string with separators: each component has been
/// through `host_name`, and joining them individually is what keeps that
/// guarantee — one component in, one component appended.
fn local_path(dest: &Path, rel_dir: &[String], name: &str) -> PathBuf {
    let mut path = dest.to_path_buf();
    for part in rel_dir {
        path.push(part);
    }
    if !name.is_empty() {
        path.push(name);
    }
    path
}

fn display_path(rel_dir: &[String], name: &str) -> String {
    if rel_dir.is_empty() {
        name.to_string()
    } else {
        format!("{}/{name}", rel_dir.join("/"))
    }
}

/// A file that landed under a different name is a file the user cannot find by
/// the name they saw in the listing, so it is reported rather than assumed
/// harmless.
fn note_rename(warnings: &mut Vec<String>, device: &str, host: &str) {
    if device != host {
        warnings.push(format!("{device}: сохранено как \"{host}\" - имя недопустимо на компьютере"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_built_component_by_component() {
        let dest = Path::new("/tmp/dest");
        assert_eq!(local_path(dest, &[], "a.txt"), PathBuf::from("/tmp/dest/a.txt"));
        assert_eq!(
            local_path(dest, &["trip".into(), "raw".into()], "b.dng"),
            PathBuf::from("/tmp/dest/trip/raw/b.dng")
        );
        // An empty name addresses the folder itself — that is how `plan.dirs`
        // entries are turned into directories to create.
        assert_eq!(local_path(dest, &["trip".into()], ""), PathBuf::from("/tmp/dest/trip"));
    }

    #[test]
    fn conflict_names_show_where_the_file_would_land() {
        assert_eq!(display_path(&[], "a.txt"), "a.txt");
        assert_eq!(display_path(&["trip".into(), "raw".into()], "b.dng"), "trip/raw/b.dng");
    }

    #[test]
    fn a_renamed_file_is_reported_and_an_untouched_one_is_not() {
        let mut warnings = Vec::new();
        note_rename(&mut warnings, "photo.jpg", "photo.jpg");
        assert!(warnings.is_empty());

        note_rename(&mut warnings, "a:b.jpg", "a_b.jpg");
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("a_b.jpg"), "the new name must be in the message");
    }

    /// An empty plan is a terminal `Done`, not an error and not a hang: the
    /// caller's progress row clears on the report, so a branch that returned
    /// without one would pin it forever.
    #[tokio::test]
    async fn an_empty_plan_finishes_immediately_without_touching_the_device() {
        let slot: SessionSlot = Mutex::new(None);
        let plan = DownloadPlan::default();

        let report = download_tree(
            &slot,
            "no-such-device",
            0,
            &plan,
            Path::new("/nonexistent"),
            DownloadPolicy::Ask,
            |_| panic!("an empty plan reports no progress"),
            || false,
        )
        .await
        .unwrap();

        assert_eq!(
            report,
            DownloadReport::Done {
                files: 0,
                folders: 0,
                replaced: 0,
                skipped: 0,
                bytes: 0,
                warnings: vec![]
            }
        );
    }

    /// The slot being empty (device closed) must surface as `Disconnected`,
    /// not as a panic and not as a silent success.
    #[tokio::test]
    async fn a_closed_device_stops_the_walk_with_disconnected() {
        let slot: SessionSlot = Mutex::new(None);
        let roots = [DownloadRoot {
            handle: 7,
            name: "DCIM".into(),
            is_folder: true,
            size: 0,
        }];

        let err = plan_download(&slot, "RFCY60SXJBF", 1, &roots, || false)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Disconnected);
    }

    #[tokio::test]
    async fn cancelling_during_the_walk_is_reported_as_cancelled() {
        let slot: SessionSlot = Mutex::new(None);
        let roots = [DownloadRoot { handle: 7, name: "DCIM".into(), is_folder: true, size: 0 }];

        let err = plan_download(&slot, "RFCY60SXJBF", 1, &roots, || true)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Cancelled);
    }

    /// Conflict detection is pure local filesystem work, so it can be exercised
    /// with no device at all — and it must report without creating anything,
    /// including the folders the plan asks for.
    #[tokio::test]
    async fn conflicts_are_reported_before_anything_is_created() {
        let dir = std::env::temp_dir().join(format!("adx-download-conflict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"already here").unwrap();

        let plan = DownloadPlan {
            dirs: vec![vec!["sub".to_string()]],
            items: vec![DownloadItem { handle: 1, rel_dir: vec![], name: "a.txt".into(), size: 5 }],
            total_bytes: 5,
            warnings: vec![],
        };

        let slot: SessionSlot = Mutex::new(None);
        let report = download_tree(
            &slot,
            "RFCY60SXJBF",
            1,
            &plan,
            &dir,
            DownloadPolicy::Ask,
            |_| {},
            || false,
        )
        .await
        .unwrap();

        assert_eq!(report, DownloadReport::Conflicts { names: vec!["a.txt".to_string()] });
        assert!(!dir.join("sub").exists(), "asking must not create the folder tree");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `Skip` on a plan whose only file is a conflict does no device work at
    /// all, so it is testable without hardware — and it must still create the
    /// empty folders, which are content the user asked for.
    #[tokio::test]
    async fn skip_leaves_the_existing_file_alone_but_still_makes_the_folders() {
        let dir = std::env::temp_dir().join(format!("adx-download-skip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"original").unwrap();

        let plan = DownloadPlan {
            dirs: vec![vec!["sub".to_string()], vec!["sub".to_string(), "deep".to_string()]],
            items: vec![DownloadItem { handle: 1, rel_dir: vec![], name: "a.txt".into(), size: 5 }],
            total_bytes: 5,
            warnings: vec![],
        };

        let slot: SessionSlot = Mutex::new(None);
        let report = download_tree(
            &slot,
            "RFCY60SXJBF",
            1,
            &plan,
            &dir,
            DownloadPolicy::Skip,
            |_| {},
            || false,
        )
        .await
        .unwrap();

        assert!(matches!(report, DownloadReport::Done { skipped: 1, files: 0, folders: 2, .. }));
        assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"original");
        assert!(dir.join("sub/deep").is_dir());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
