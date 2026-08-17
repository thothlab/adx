//! Application state: the one open device session, and the flag that stops a
//! transfer.
//!
//! The session lives behind an async mutex, and that mutex is load-bearing
//! rather than incidental. MTP carries one transaction at a time; two commands
//! reaching the device concurrently desynchronise the session, which surfaces
//! as the device "disconnecting" mid-copy. Holding every operation behind one
//! lock makes the per-device FIFO real before it has any UI, and makes it
//! impossible to add a command that forgets to queue.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use adx_mtp::Session;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    pub session: Mutex<Option<Session>>,
    /// Set by `upload_cancel`, read by the transfer loop. An `Arc` because the
    /// progress callback handed to `mtp-rs` outlives the borrow of state.
    pub cancel: Arc<AtomicBool>,
}
