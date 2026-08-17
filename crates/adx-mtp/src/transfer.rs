//! Executing an upload plan against a device.
//!
//! Lives here rather than in the Tauri command layer for two reasons. The
//! project rule is that commands do shape conversion and nothing else — but the
//! concrete reason is that this is the code most in need of being run against a
//! real phone, and an executor buried in `src-tauri` can only be reached by
//! launching the app and clicking. Here, `examples/roundtrip.rs` drives it end
//! to end on real hardware.
//!
//! # One terminal outcome, always
//!
//! Every path out of [`upload_tree`] produces exactly one [`UploadReport`], or
//! an `Err` — including the early exits: an empty plan, a conflict the user
//! must answer, a cancel. A branch that returned without a terminal signal
//! would leave the caller's progress bar pinned forever with no way back except
//! restarting the app. That shipped once in a neighbouring project
//! (itrack-tsd) and is cheap to prevent, expensive to find.
//!
//! # Nothing is written before the user has answered
//!
//! Conflict detection runs entirely on reads: existing folders are resolved but
//! never created, so returning [`UploadReport::Conflicts`] leaves the device
//! exactly as it was. Building the folder tree first and *then* asking would
//! mean a cancelled transfer still littered the phone with empty folders.

use std::collections::HashMap;

use adx_core::{AdxError, ErrorKind, UploadPlan};

use crate::Session;

/// What to do about a name that already exists on the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictPolicy {
    /// Write nothing; report the conflicts and let the caller ask.
    Ask,
    Replace,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadReport {
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
    /// The caller stopped it. Carries what did land, because "cancelled"
    /// without those numbers leaves the user unsure what is now on the phone.
    Cancelled { files: usize, bytes: u64, warnings: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadProgress {
    pub done: usize,
    pub total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub name: String,
}

/// name -> (handle, is_folder)
type Children = HashMap<String, (u64, bool)>;

/// Run a plan.
///
/// `on_progress` is called as bytes move — often, so throttling belongs to the
/// caller, which knows what it costs to deliver one. `is_cancelled` is polled
/// between chunks and between files.
pub async fn upload_tree<P, C>(
    session: &Session,
    storage_id: u64,
    parent: Option<u64>,
    plan: &UploadPlan,
    policy: ConflictPolicy,
    mut on_progress: P,
    is_cancelled: C,
) -> Result<UploadReport, AdxError>
where
    P: FnMut(UploadProgress) + Send,
    C: Fn() -> bool + Send + Sync,
{
    let mut warnings: Vec<String> = plan
        .skipped
        .iter()
        .map(|(path, reason)| format!("{}: {}", path.display(), reason_text(*reason)))
        .collect();

    if plan.is_empty() {
        return Ok(UploadReport::Done {
            files: 0,
            folders: 0,
            replaced: 0,
            skipped: 0,
            bytes: 0,
            warnings,
        });
    }
    if !session.can_write() {
        return Err(AdxError::new(
            ErrorKind::Unsupported,
            "устройство не разрешает запись",
        ));
    }

    let mut cache: HashMap<Option<u64>, Children> = HashMap::new();

    // ---- Pass 1: reads only. What already exists? --------------------------
    let mut dirs: HashMap<Vec<String>, Option<u64>> = HashMap::new();
    dirs.insert(Vec::new(), parent);

    for dir in &plan.dirs {
        let (name, parent_key) = dir.split_last().expect("plan dirs are never empty");
        let Some(&parent_handle) = dirs.get(parent_key) else {
            // Its parent does not exist on the device yet, so neither can it.
            continue;
        };
        let existing = children(session, storage_id, parent_handle, &mut cache)
            .await?
            .get(name)
            .copied();
        match existing {
            Some((handle, true)) => {
                dirs.insert(dir.clone(), Some(handle));
            }
            Some((_, false)) => {
                return Err(AdxError::new(
                    ErrorKind::NameTaken,
                    format!("на устройстве уже есть файл с именем \"{name}\" - папку с таким именем создать нельзя"),
                ));
            }
            None => {}
        }
    }

    let mut conflicts: HashMap<usize, (u64, bool)> = HashMap::new();
    let mut conflict_names: Vec<String> = Vec::new();
    for (index, item) in plan.items.iter().enumerate() {
        let Some(&parent_handle) = dirs.get(&item.rel_dir) else {
            continue; // lands in a folder that does not exist yet
        };
        let existing = children(session, storage_id, parent_handle, &mut cache)
            .await?
            .get(&item.name)
            .copied();
        if let Some(found) = existing {
            conflicts.insert(index, found);
            conflict_names.push(display_path(&item.rel_dir, &item.name));
        }
    }

    if policy == ConflictPolicy::Ask && !conflicts.is_empty() {
        // Terminal, and the device is untouched.
        return Ok(UploadReport::Conflicts { names: conflict_names });
    }

    // ---- Pass 2: writes. ---------------------------------------------------
    let mut folders_created = 0usize;
    for dir in &plan.dirs {
        if dirs.contains_key(dir) {
            continue;
        }
        let (name, parent_key) = dir.split_last().expect("plan dirs are never empty");
        // Present by construction: `plan.dirs` lists parents before children,
        // and this loop fills them in the same order.
        let parent_handle = *dirs.get(parent_key).ok_or_else(|| {
            AdxError::new(
                ErrorKind::NotFound,
                format!("родительская папка для \"{name}\" не найдена"),
            )
        })?;
        let handle = session.create_folder(storage_id, parent_handle, name).await?;
        dirs.insert(dir.clone(), Some(handle));
        folders_created += 1;
    }

    let total_files = plan.items.len();
    let total_bytes = plan.total_bytes;
    let mut files_done = 0usize;
    let mut bytes_done = 0u64;
    let mut replaced = 0usize;
    let mut skipped = 0usize;

    for (index, item) in plan.items.iter().enumerate() {
        if is_cancelled() {
            return Ok(UploadReport::Cancelled { files: files_done, bytes: bytes_done, warnings });
        }

        if let Some(&(handle, is_folder)) = conflicts.get(&index) {
            if is_folder {
                // Replacing a folder with a file of the same name would delete
                // the folder and everything under it. Nobody drags a file
                // meaning that.
                warnings.push(format!(
                    "{}: на устройстве это папка, файл пропущен",
                    display_path(&item.rel_dir, &item.name)
                ));
                skipped += 1;
                continue;
            }
            match policy {
                ConflictPolicy::Skip | ConflictPolicy::Ask => {
                    skipped += 1;
                    continue;
                }
                ConflictPolicy::Replace => {
                    session.delete(storage_id, handle).await?;
                    replaced += 1;
                }
            }
        }

        let parent_handle = *dirs.get(&item.rel_dir).ok_or_else(|| {
            AdxError::new(ErrorKind::NotFound, format!("папка для \"{}\" не создана", item.name))
        })?;

        let mut sent_in_file = 0u64;
        let outcome = {
            let name = item.name.clone();
            let on_progress = &mut on_progress;
            let sent_in_file = &mut sent_in_file;
            session
                .upload_file(storage_id, parent_handle, &item.local, &item.name, |sent| {
                    *sent_in_file = sent;
                    on_progress(UploadProgress {
                        done: files_done,
                        total: total_files,
                        bytes_done: bytes_done + sent,
                        bytes_total: total_bytes,
                        name: name.clone(),
                    });
                    !is_cancelled()
                })
                .await
        };

        match outcome {
            Ok(_) => {
                files_done += 1;
                bytes_done += sent_in_file;
                on_progress(UploadProgress {
                    done: files_done,
                    total: total_files,
                    bytes_done,
                    bytes_total: total_bytes,
                    name: item.name.clone(),
                });
            }
            Err(failure) => {
                // `mtp-rs` never deletes a partially written object, so if we
                // do not, every failed transfer leaves a truncated file behind
                // that is indistinguishable from a real one in the listing.
                if let Some(partial) = failure.partial {
                    match session.delete(storage_id, partial).await {
                        Ok(()) => tracing::info!("removed the partial object left by a failed upload"),
                        Err(e) => warnings.push(format!(
                            "{}: не удалось удалить недописанный файл на устройстве ({e})",
                            item.name
                        )),
                    }
                }
                if failure.error.kind == ErrorKind::Cancelled || is_cancelled() {
                    return Ok(UploadReport::Cancelled { files: files_done, bytes: bytes_done, warnings });
                }
                return Err(failure.error);
            }
        }
    }

    Ok(UploadReport::Done {
        files: files_done,
        folders: folders_created,
        replaced,
        skipped,
        bytes: bytes_done,
        warnings,
    })
}

async fn children<'a>(
    session: &Session,
    storage_id: u64,
    parent: Option<u64>,
    cache: &'a mut HashMap<Option<u64>, Children>,
) -> Result<&'a Children, AdxError> {
    if !cache.contains_key(&parent) {
        let listing = session.list(storage_id, parent).await?;
        let map = listing
            .into_iter()
            .map(|e| (e.name, (e.handle, e.is_folder)))
            .collect();
        cache.insert(parent, map);
    }
    Ok(cache.get(&parent).expect("just inserted"))
}

fn display_path(rel_dir: &[String], name: &str) -> String {
    if rel_dir.is_empty() {
        name.to_string()
    } else {
        format!("{}/{name}", rel_dir.join("/"))
    }
}

fn reason_text(reason: adx_core::SkipReason) -> &'static str {
    match reason {
        adx_core::SkipReason::Symlink => "символическая ссылка не копируется",
        adx_core::SkipReason::NotAFile => "не файл и не папка",
        adx_core::SkipReason::UnusableName => "имя недопустимо для устройства",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_names_show_where_the_file_lands() {
        assert_eq!(display_path(&[], "a.txt"), "a.txt");
        assert_eq!(
            display_path(&["trip".into(), "raw".into()], "b.dng"),
            "trip/raw/b.dng"
        );
    }

    /// Every skip reason must produce a sentence a user can act on. A reason
    /// that fell through to an empty string would show as a blank warning line,
    /// which reads as a glitch rather than as "this file was not copied".
    #[test]
    fn every_skip_reason_says_something() {
        for reason in [
            adx_core::SkipReason::Symlink,
            adx_core::SkipReason::NotAFile,
            adx_core::SkipReason::UnusableName,
        ] {
            assert!(!reason_text(reason).is_empty());
        }
    }
}
