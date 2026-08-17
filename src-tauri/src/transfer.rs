//! Upload commands: the thin layer between the executor and the window.
//!
//! The work itself lives in `adx_mtp::upload_tree`, where it can be driven
//! against a real phone by `cargo run -p adx-mtp --example roundtrip`. What
//! stays here is what only makes sense inside a running app: throttling
//! progress so it does not flood the IPC bridge, reading the cancel flag, and
//! turning the executor's report into JSON the frontend can branch on.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use adx_core::{plan_upload, AdxError, ErrorKind};
use adx_mtp::{ConflictPolicy, UploadReport};
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

/// Plain identifier, no scheme punctuation: Tauri validates event names and a
/// rejected one fails at emit time, in a background task, where nobody sees it.
pub const PROGRESS_EVENT: &str = "upload-progress";

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
    let storage = token(&storage_id)?;
    let target = parent.as_deref().map(token).transpose()?;

    // The walk touches the local filesystem thousands of times for a big tree;
    // off the async runtime it goes.
    let roots: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let plan = tokio::task::spawn_blocking(move || plan_upload(&roots))
        .await
        .map_err(|e| AdxError::new(ErrorKind::Io, e.to_string()))?
        .map_err(|e| AdxError::new(ErrorKind::Io, e.to_string()))?;

    let guard = state.session.lock().await;
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
