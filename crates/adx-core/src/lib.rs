//! Domain model shared by the Tauri commands and the MTP layer.
//!
//! Nothing here knows about `mtp-rs` or about Tauri: `adx-mtp` maps the
//! library's types into these, and `src-tauri` serialises them to the
//! frontend. Keeping the model in the middle is what makes swapping the MTP
//! backend a change that stops at one crate.

pub mod download;
pub mod error;
pub mod model;
pub mod name;
pub mod upload;

pub use download::host_name;
pub use error::{AdxError, ErrorKind, ProcessRef, SpaceNeed};
pub use model::{DeviceState, TransferDirection, TransferState};
pub use name::{check_name, NameProblem, MAX_NAME_CHARS};
pub use upload::{plan_upload, SkipReason, UploadItem, UploadPlan};
