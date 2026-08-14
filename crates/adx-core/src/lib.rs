//! Domain model shared by the Tauri commands and the MTP layer.
//!
//! Nothing here knows about `mtp-rs` or about Tauri: `adx-mtp` maps the
//! library's types into these, and `src-tauri` serialises them to the
//! frontend. Keeping the model in the middle is what makes swapping the MTP
//! backend a change that stops at one crate.

pub mod error;
pub mod model;

pub use error::{AdxError, ErrorKind, ProcessRef};
pub use model::{DeviceState, TransferDirection, TransferState};
