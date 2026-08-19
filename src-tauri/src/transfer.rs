//! Upload commands: the thin layer between the executor and the window.
//!
//! The work itself lives in `adx_mtp::upload_tree`, where it can be driven
//! against a real phone by `cargo run -p adx-mtp --example roundtrip`. What
//! stays here is what only makes sense inside a running app: throttling
//! progress so it does not flood the IPC bridge, reading the cancel flag, and
//! turning the executor's report into JSON the frontend can branch on.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use adx_core::{plan_upload, AdxError, ErrorKind};
use adx_mtp::{ConflictPolicy, DownloadPolicy, DownloadReport, DownloadRoot, UploadReport};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::token;
use crate::state::AppState;

/// How often progress reaches the UI during a single large file.
///
/// The executor reports per USB chunk — thousands of times a second on a fast
/// cable. Emitting each one would spend more time crossing the IPC boundary
/// than moving bytes, and no human reads a bar that redraws 2000 times a
/// second.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

/// Plain identifiers, no scheme punctuation: Tauri validates event names and a
/// rejected one fails at emit time, in a background task, where nobody sees it.
pub const PROGRESS_EVENT: &str = "upload-progress";
pub const DOWNLOAD_PROGRESS_EVENT: &str = "download-progress";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicyDto {
    Ask,
    Replace,
    Skip,
}

impl From<PolicyDto> for ConflictPolicy {
    fn from(p: PolicyDto) -> Self {
        match p {
            PolicyDto::Ask => ConflictPolicy::Ask,
            PolicyDto::Replace => ConflictPolicy::Replace,
            PolicyDto::Skip => ConflictPolicy::Skip,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UploadOutcomeDto {
    Conflicts {
        names: Vec<String>,
    },
    Done {
        files: usize,
        folders: usize,
        replaced: usize,
        skipped: usize,
        bytes: u64,
        warnings: Vec<String>,
    },
    Cancelled {
        files: usize,
        bytes: u64,
        warnings: Vec<String>,
    },
}

impl From<UploadReport> for UploadOutcomeDto {
    fn from(r: UploadReport) -> Self {
        match r {
            UploadReport::Conflicts { names } => Self::Conflicts { names },
            UploadReport::Done { files, folders, replaced, skipped, bytes, warnings } => {
                Self::Done { files, folders, replaced, skipped, bytes, warnings }
            }
            UploadReport::Cancelled { files, bytes, warnings } => {
                Self::Cancelled { files, bytes, warnings }
            }
        }
    }
}

/// Marks the device as busy for exactly as long as a transfer runs.
///
/// A guard rather than a store at each exit: `upload_start` and
/// `download_start` leave through half a dozen `?`s and early returns, and a
/// flag cleared on only the happy path would leave media playback refused until
/// the app restarted — a failure that looks nothing like its cause.
struct Busy(Arc<AtomicBool>);

impl Busy {
    fn claim(flag: &Arc<AtomicBool>) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self(Arc::clone(flag))
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressDto {
    done: usize,
    total: usize,
    bytes_done: u64,
    bytes_total: u64,
    name: String,
}

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
    policy: PolicyDto,
) -> Result<UploadOutcomeDto, AdxError> {
    let _busy = Busy::claim(&state.transferring);
    let storage = token(&storage_id)?;
    let target = parent.as_deref().map(token).transpose()?;

    // The walk touches the local filesystem thousands of times for a big tree;
    // off the async runtime it goes.
    let roots: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let plan = tokio::task::spawn_blocking(move || plan_upload(&roots))
        .await
        .map_err(|e| AdxError::new(ErrorKind::Io, e.to_string()))?
        .map_err(|e| AdxError::new(ErrorKind::Io, e.to_string()))?;

    let mut guard = state.session.lock().await;

    // Does it fit? Asked before anything is written, and asked of the device
    // rather than of the figure the window happens to be showing — that one was
    // read when the storage list was last refreshed, and a transfer started
    // since then would make it a promise about the past.
    //
    // Only on the `Ask` pass, which is where every fresh upload begins. Once
    // the user has answered a conflict question the arithmetic no longer holds:
    // `Replace` reclaims the space of the objects it overwrites and `Skip`
    // never spends it, so checking the untouched plan total there would refuse
    // transfers that fit. A wrong refusal is worse than no check — the device
    // still fails honestly when it runs out, and the user cannot argue with a
    // dialog that is simply mistaken.
    if policy == PolicyDto::Ask {
        let session = guard
            .as_mut()
            .ok_or_else(|| AdxError::new(ErrorKind::NoDevice, "устройство не открыто"))?;
        let free = session
            .refresh_storages()
            .await?
            .into_iter()
            .find(|s| s.id == storage)
            .map(|s| s.free_space);
        // A storage that no longer appears is not a space problem, and calling
        // it one would send the user deleting files to fix an unplugged phone.
        // The write below fails with the real reason.
        if let Some(free) = free {
            if plan.total_bytes > free {
                return Err(AdxError::not_enough_space(plan.total_bytes, free));
            }
        }
    }

    let session = guard
        .as_ref()
        .ok_or_else(|| AdxError::new(ErrorKind::NoDevice, "устройство не открыто"))?;

    let cancel = Arc::clone(&state.cancel);
    cancel.store(false, Ordering::SeqCst);

    let mut last = Instant::now();
    let mut last_done = usize::MAX;
    let report = adx_mtp::upload_tree(
        session,
        storage,
        target,
        &plan,
        policy.into(),
        |p| {
            // A file boundary always gets through, whatever the throttle says:
            // it is the event that moves the "3 of 40" counter, and a dropped
            // one leaves the count a step behind until the next tick. Detected
            // by the counter changing rather than by comparing byte totals,
            // which are equal on any file that happens to finish a chunk.
            let boundary = p.done != last_done;
            if boundary || last.elapsed() >= PROGRESS_INTERVAL {
                last = Instant::now();
                last_done = p.done;
                let _ = app.emit(
                    PROGRESS_EVENT,
                    ProgressDto {
                        done: p.done,
                        total: p.total,
                        bytes_done: p.bytes_done,
                        bytes_total: p.bytes_total,
                        name: p.name,
                    },
                );
            }
        },
        || cancel.load(Ordering::Relaxed),
    )
    .await?;

    Ok(report.into())
}

/// Ask the running transfer to stop.
///
/// Deliberately does not touch the session mutex — the transfer is holding it.
/// A cancel that waited for the lock would only be honoured after the thing it
/// is cancelling had already finished.
#[tauri::command]
pub fn upload_cancel(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// One object the user selected in the listing, on its way to the computer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRootDto {
    pub handle: String,
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
}

/// Same three terminal states as an upload, and the same reason for the tag:
/// the frontend clears its progress row on `status` alone, so a cancel must
/// never serialise into something that reads as success.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DownloadOutcomeDto {
    Conflicts {
        names: Vec<String>,
    },
    Done {
        files: usize,
        folders: usize,
        replaced: usize,
        skipped: usize,
        bytes: u64,
        warnings: Vec<String>,
    },
    Cancelled {
        files: usize,
        bytes: u64,
        warnings: Vec<String>,
    },
}

impl From<DownloadReport> for DownloadOutcomeDto {
    fn from(r: DownloadReport) -> Self {
        match r {
            DownloadReport::Conflicts { names } => Self::Conflicts { names },
            DownloadReport::Done { files, folders, replaced, skipped, bytes, warnings } => {
                Self::Done { files, folders, replaced, skipped, bytes, warnings }
            }
            DownloadReport::Cancelled { files, bytes, warnings } => {
                Self::Cancelled { files, bytes, warnings }
            }
        }
    }
}

impl From<PolicyDto> for DownloadPolicy {
    fn from(p: PolicyDto) -> Self {
        match p {
            PolicyDto::Ask => DownloadPolicy::Ask,
            PolicyDto::Replace => DownloadPolicy::Replace,
            PolicyDto::Skip => DownloadPolicy::Skip,
        }
    }
}

/// Copy selected files and folders from the device into a folder on this
/// computer.
///
/// Note what this command does *not* do: it never takes the session lock
/// itself. The executor takes it per read window and releases it in between, so
/// while this command is running the folder tree and the listing keep working —
/// which is the one behaviour a user notices about a file manager that moves
/// gigabytes.
#[tauri::command]
pub async fn download_start(
    app: AppHandle,
    state: State<'_, AppState>,
    storage_id: String,
    roots: Vec<DownloadRootDto>,
    dest: String,
    policy: PolicyDto,
) -> Result<DownloadOutcomeDto, AdxError> {
    let _busy = Busy::claim(&state.transferring);
    let storage = token(&storage_id)?;
    let roots: Vec<DownloadRoot> = roots
        .into_iter()
        .map(|r| {
            Ok(DownloadRoot {
                handle: token(&r.handle)?,
                name: r.name,
                is_folder: r.is_folder,
                size: r.size,
            })
        })
        .collect::<Result<_, AdxError>>()?;

    // Pinned before the walk starts, so every later re-acquire can tell "the
    // same phone" from "a phone".
    let serial = {
        let guard = state.session.lock().await;
        guard
            .as_ref()
            .ok_or_else(|| AdxError::new(ErrorKind::NoDevice, "устройство не открыто"))?
            .serial()
            .to_string()
    };

    let cancel = Arc::clone(&state.cancel);
    cancel.store(false, Ordering::SeqCst);

    // Walking a folder tree is thousands of listings, so a cancel has to be
    // honoured here too — not only once bytes are moving. It comes back as an
    // error kind and is turned into the terminal `Cancelled` report right away.
    let plan = match adx_mtp::plan_download(&state.session, &serial, storage, &roots, || {
        cancel.load(Ordering::Relaxed)
    })
    .await
    {
        Ok(plan) => plan,
        Err(e) if e.kind == ErrorKind::Cancelled => {
            return Ok(DownloadOutcomeDto::Cancelled { files: 0, bytes: 0, warnings: vec![] })
        }
        Err(e) => return Err(e),
    };

    let mut last = Instant::now();
    let mut last_done = usize::MAX;
    let report = adx_mtp::download_tree(
        &state.session,
        &serial,
        storage,
        &plan,
        std::path::Path::new(&dest),
        policy.into(),
        |p| {
            // Same rule as the upload side: a file boundary always gets
            // through, everything else is throttled.
            let boundary = p.done != last_done;
            if boundary || last.elapsed() >= PROGRESS_INTERVAL {
                last = Instant::now();
                last_done = p.done;
                let _ = app.emit(
                    DOWNLOAD_PROGRESS_EVENT,
                    ProgressDto {
                        done: p.done,
                        total: p.total,
                        bytes_done: p.bytes_done,
                        bytes_total: p.bytes_total,
                        name: p.name,
                    },
                );
            }
        },
        || cancel.load(Ordering::Relaxed),
    )
    .await?;

    Ok(report.into())
}

/// Ask the running download to stop. Same flag as the upload, same reason for
/// not touching the session mutex.
#[tauri::command]
pub fn download_cancel(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The outcome is a tagged union so the frontend cannot mistake one
    /// terminal state for another — in particular, a cancel must never
    /// serialise into something that reads as success.
    #[test]
    fn outcomes_carry_a_discriminating_tag() {
        let done: UploadOutcomeDto = UploadReport::Done {
            files: 1,
            folders: 0,
            replaced: 0,
            skipped: 0,
            bytes: 10,
            warnings: vec![],
        }
        .into();
        assert!(serde_json::to_string(&done).unwrap().contains("\"status\":\"done\""));

        let cancelled: UploadOutcomeDto =
            UploadReport::Cancelled { files: 1, bytes: 10, warnings: vec![] }.into();
        assert!(serde_json::to_string(&cancelled)
            .unwrap()
            .contains("\"status\":\"cancelled\""));

        let conflicts: UploadOutcomeDto =
            UploadReport::Conflicts { names: vec!["a".into()] }.into();
        assert!(serde_json::to_string(&conflicts)
            .unwrap()
            .contains("\"status\":\"conflicts\""));
    }

    /// The download union is checked separately rather than assumed identical:
    /// the two directions serialise through different types, and a tag that
    /// only the upload side got right would leave a download's progress row
    /// pinned forever.
    #[test]
    fn download_outcomes_carry_the_same_discriminating_tag() {
        let cancelled: DownloadOutcomeDto =
            DownloadReport::Cancelled { files: 2, bytes: 10, warnings: vec![] }.into();
        assert!(serde_json::to_string(&cancelled)
            .unwrap()
            .contains("\"status\":\"cancelled\""));

        let conflicts: DownloadOutcomeDto =
            DownloadReport::Conflicts { names: vec!["a".into()] }.into();
        assert!(serde_json::to_string(&conflicts)
            .unwrap()
            .contains("\"status\":\"conflicts\""));

        let done: DownloadOutcomeDto = DownloadReport::Done {
            files: 1,
            folders: 0,
            replaced: 0,
            skipped: 0,
            bytes: 10,
            warnings: vec![],
        }
        .into();
        assert!(serde_json::to_string(&done).unwrap().contains("\"status\":\"done\""));
    }

    /// The listing sends handles as strings — a u64 does not survive a JSON
    /// number — and sizes as numbers. A DTO that got that backwards would
    /// address the wrong object on a device with high handles.
    #[test]
    fn a_download_root_arrives_with_a_string_handle() {
        let dto: DownloadRootDto = serde_json::from_str(
            r#"{"handle":"18446744073709551615","name":"DCIM","isFolder":true,"size":0}"#,
        )
        .unwrap();
        assert_eq!(token(&dto.handle).unwrap(), u64::MAX);
        assert!(dto.is_folder);
    }

    #[test]
    fn policies_arrive_from_the_frontend_in_camel_case() {
        assert_eq!(
            ConflictPolicy::from(serde_json::from_str::<PolicyDto>("\"replace\"").unwrap()),
            ConflictPolicy::Replace
        );
        assert_eq!(
            ConflictPolicy::from(serde_json::from_str::<PolicyDto>("\"ask\"").unwrap()),
            ConflictPolicy::Ask
        );
    }
}
