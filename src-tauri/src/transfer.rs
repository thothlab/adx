//! Uploading files and folders to the device.
//!
//! # One terminal outcome, always
//!
//! Every path out of [`upload_start`] returns exactly one [`UploadOutcome`], or
//! an `Err` — including the early exits: an empty plan, a conflict the user
//! must answer, a cancel. A branch that returned without a terminal signal
//! would leave the progress bar pinned at whatever it last showed, forever,
//! with no way back except restarting the app. That failure shipped once in a
//! neighbouring project (itrack-tsd) and is cheap to prevent and expensive to
//! find, so it is written down here rather than assumed.
//!
//! # Nothing is written before the user has answered
//!
//! Conflict detection runs entirely on reads: existing folders are resolved but
//! not created, so returning [`UploadOutcome::Conflicts`] leaves the device
//! exactly as it was. Creating the folder tree first and *then* asking would
//! mean a cancelled transfer still littered the phone with empty folders.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use adx_core::{plan_upload, AdxError, ErrorKind, SkipReason};
use adx_mtp::Session;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::token;
use crate::state::AppState;

/// How often progress reaches the UI during a single large file.
///
/// The callback fires per USB chunk — thousands of times a second on a fast
/// cable. Emitting each one would spend more time crossing the IPC boundary
/// than moving bytes, and no human reads a bar that redraws 2000 times a
/// second.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

/// Plain identifier, no scheme punctuation: Tauri validates event names and a
/// rejected one fails at emit time, in a background task, where nobody sees it.
pub const PROGRESS_EVENT: &str = "upload-progress";

/// What to do about a name that already exists on the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    /// Do not write anything; report the conflicts and let the user decide.
    Ask,
    Replace,
    Skip,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UploadOutcome {
    /// Nothing was written. The frontend asks, then calls again with a real
    /// policy.
    Conflicts { names: Vec<String> },
    Done {
        files: usize,
        folders: usize,
        replaced: usize,
        skipped: usize,
        bytes: u64,
        warnings: Vec<String>,
    },
    /// The user stopped it. Counts what did land, because "cancelled" without
    /// them leaves the user unsure what is now on the phone.
    Cancelled { files: usize, bytes: u64, warnings: Vec<String> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgress {
    done: usize,
    total: usize,
    bytes_done: u64,
    bytes_total: u64,
    name: String,
}

type Children = HashMap<String, (u64, bool)>;

/// Send files and folders to a folder on the device.
///
/// `parent = None` targets the root of the storage.
#[tauri::command]
pub async fn upload_start(
    app: AppHandle,
    state: State<'_, AppState>,
    storage_id: String,
    parent: Option<String>,
    paths: Vec<String>,
    policy: ConflictPolicy,
) -> Result<UploadOutcome, AdxError> {
    let storage = token(&storage_id)?;
    let target = parent.as_deref().map(token).transpose()?;

    // The walk touches the local filesystem thousands of times for a big tree;
    // off the async runtime it goes.
    let roots: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let plan = tokio::task::spawn_blocking(move || plan_upload(&roots))
        .await
        .map_err(|e| AdxError::new(ErrorKind::Io, e.to_string()))?
        .map_err(|e| AdxError::new(ErrorKind::Io, e.to_string()))?;

    let mut warnings: Vec<String> = plan
        .skipped
        .iter()
        .map(|(path, reason)| {
            let why = match reason {
                SkipReason::Symlink => "символическая ссылка не копируется",
                SkipReason::NotAFile => "не файл и не папка",
                SkipReason::UnusableName => "имя недопустимо для устройства",
            };
            format!("{}: {why}", path.display())
        })
        .collect();

    if plan.is_empty() {
        return Ok(UploadOutcome::Done {
            files: 0,
            folders: 0,
            replaced: 0,
            skipped: 0,
            bytes: 0,
            warnings,
        });
    }

    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or_else(|| {
        AdxError::new(ErrorKind::NoDevice, "устройство не открыто")
    })?;
    if !session.can_write() {
        return Err(AdxError::new(
            ErrorKind::Unsupported,
            "устройство не разрешает запись",
        ));
    }

    let mut cache: HashMap<Option<u64>, Children> = HashMap::new();

    // ---- Pass 1: read-only. Resolve what already exists. -------------------
    let mut dirs: HashMap<Vec<String>, Option<u64>> = HashMap::new();
    dirs.insert(Vec::new(), target);

    for dir in &plan.dirs {
        let (name, parent_key) = dir.split_last().expect("plan dirs are never empty");
        let Some(&parent_handle) = dirs.get(parent_key) else {
            // Its parent does not exist on the device yet, so neither can it.
            continue;
        };
        let existing = children(session, storage, parent_handle, &mut cache)
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
        let existing = children(session, storage, parent_handle, &mut cache)
            .await?
            .get(&item.name)
            .copied();
        if let Some((handle, is_folder)) = existing {
            conflicts.insert(index, (handle, is_folder));
            conflict_names.push(display_path(&item.rel_dir, &item.name));
        }
    }

    if policy == ConflictPolicy::Ask && !conflicts.is_empty() {
        // Terminal, and the device is untouched.
        return Ok(UploadOutcome::Conflicts { names: conflict_names });
    }

    // ---- Pass 2: write. ----------------------------------------------------
    let cancel = Arc::clone(&state.cancel);
    cancel.store(false, Ordering::SeqCst);

    let mut folders_created = 0usize;
    for dir in &plan.dirs {
        if dirs.contains_key(dir) {
            continue;
        }
        let (name, parent_key) = dir.split_last().expect("plan dirs are never empty");
        // Guaranteed present: `plan.dirs` lists parents before children, and
        // this loop fills them in the same order.
        let parent_handle = *dirs.get(parent_key).ok_or_else(|| {
            AdxError::new(ErrorKind::NotFound, format!("родительская папка для \"{name}\" не найдена"))
        })?;
        let handle = session.create_folder(storage, parent_handle, name).await?;
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
        if cancel.load(Ordering::Relaxed) {
            return Ok(UploadOutcome::Cancelled { files: files_done, bytes: bytes_done, warnings });
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
                    session.delete(storage, handle).await?;
                    replaced += 1;
                }
            }
        }

        let parent_handle = *dirs.get(&item.rel_dir).ok_or_else(|| {
            AdxError::new(ErrorKind::NotFound, format!("папка для \"{}\" не создана", item.name))
        })?;

        let sent = Arc::new(AtomicU64::new(0));
        let outcome = {
            let sent = Arc::clone(&sent);
            let cancel = Arc::clone(&cancel);
            let app = app.clone();
            let name = item.name.clone();
            let mut last = Instant::now();
            session
                .upload_file(storage, parent_handle, &item.local, &item.name, move |bytes| {
                    sent.store(bytes, Ordering::Relaxed);
                    if last.elapsed() >= PROGRESS_INTERVAL {
                        last = Instant::now();
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            UploadProgress {
                                done: files_done,
                                total: total_files,
                                bytes_done: bytes_done + bytes,
                                bytes_total: total_bytes,
                                name: name.clone(),
                            },
                        );
                    }
                    !cancel.load(Ordering::Relaxed)
                })
                .await
        };

        match outcome {
            Ok(_) => {
                files_done += 1;
                bytes_done += sent.load(Ordering::Relaxed);
                let _ = app.emit(
                    PROGRESS_EVENT,
                    UploadProgress {
                        done: files_done,
                        total: total_files,
                        bytes_done,
                        bytes_total: total_bytes,
                        name: item.name.clone(),
                    },
                );
            }
            Err(failure) => {
                // `mtp-rs` never deletes a partially written object, so if we
                // do not, every failed transfer leaves a truncated file behind
                // that looks like a real one in the listing.
                if let Some(partial) = failure.partial {
                    match session.delete(storage, partial).await {
                        Ok(()) => tracing::info!("removed the partial object left by a failed upload"),
                        Err(e) => warnings.push(format!(
                            "{}: не удалось удалить недописанный файл на устройстве ({e})",
                            item.name
                        )),
                    }
                }
                if failure.error.kind == ErrorKind::Cancelled || cancel.load(Ordering::Relaxed) {
                    return Ok(UploadOutcome::Cancelled { files: files_done, bytes: bytes_done, warnings });
                }
                return Err(failure.error);
            }
        }
    }

    Ok(UploadOutcome::Done {
        files: files_done,
        folders: folders_created,
        replaced,
        skipped,
        bytes: bytes_done,
        warnings,
    })
}

/// Ask the running transfer to stop.
///
/// Deliberately does not touch the session mutex — the transfer is holding it.
/// A cancel that waited for the lock would only be honoured after the thing it
/// is cancelling had finished.
#[tauri::command]
pub fn upload_cancel(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

async fn children<'a>(
    session: &Session,
    storage: u64,
    parent: Option<u64>,
    cache: &'a mut HashMap<Option<u64>, Children>,
) -> Result<&'a Children, AdxError> {
    if !cache.contains_key(&parent) {
        let listing = session.list(storage, parent).await?;
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

    /// The outcome is a tagged union so the frontend cannot mistake one
    /// terminal state for another — in particular, a cancel must never
    /// serialise into something that reads as success.
    #[test]
    fn outcomes_carry_a_discriminating_tag() {
        let done = serde_json::to_string(&UploadOutcome::Done {
            files: 1,
            folders: 0,
            replaced: 0,
            skipped: 0,
            bytes: 10,
            warnings: vec![],
        })
        .unwrap();
        assert!(done.contains("\"status\":\"done\""), "{done}");

        let cancelled = serde_json::to_string(&UploadOutcome::Cancelled {
            files: 1,
            bytes: 10,
            warnings: vec![],
        })
        .unwrap();
        assert!(cancelled.contains("\"status\":\"cancelled\""), "{cancelled}");

        let conflicts =
            serde_json::to_string(&UploadOutcome::Conflicts { names: vec!["a".into()] }).unwrap();
        assert!(conflicts.contains("\"status\":\"conflicts\""), "{conflicts}");
    }

    #[test]
    fn policies_arrive_from_the_frontend_in_camel_case() {
        assert_eq!(
            serde_json::from_str::<ConflictPolicy>("\"replace\"").unwrap(),
            ConflictPolicy::Replace
        );
        assert_eq!(
            serde_json::from_str::<ConflictPolicy>("\"ask\"").unwrap(),
            ConflictPolicy::Ask
        );
    }
}
