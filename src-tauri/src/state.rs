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

use adx_mtp::SessionSlot;

#[derive(Default)]
pub struct AppState {
    /// The one open device. A download borrows this per read window rather than
    /// for its whole run, which is what keeps the tree and the listing usable
    /// while a large file is coming off the phone — see `adx_mtp::download`.
    pub session: SessionSlot,
    /// Set by `upload_cancel` / `download_cancel`, read by the transfer loops.
    /// One flag for both directions because the session mutex already makes
    /// them mutually exclusive: a second transfer cannot start while the first
    /// holds the device, so there is never a second one to cancel by mistake.
    /// An `Arc` because the progress callback handed to `mtp-rs` outlives the
    /// borrow of state.
    pub cancel: Arc<AtomicBool>,
}
