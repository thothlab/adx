//! The MTP backend — and the only crate allowed to name `mtp_rs`.
//!
//! Everything above this crate talks to [`MtpBackend`] and to the model types
//! in `adx-core`. That boundary is checked, not just intended: T01's
//! definition of done greps the tree for `mtp_rs::` outside this crate. The
//! reason is concrete — `mtp-rs` is at 0.30.0 and ships breaking changes every
//! few days, so a version bump must not be able to reach the UI.
//!
//! T00 defines the trait; T01 lands `MtpRsBackend` behind it.

use adx_core::AdxError;

/// One attached device, before it is opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredDevice {
    /// Primary key across refreshes.
    pub serial: String,
    /// Fallback key when the device won't give a serial.
    pub location_id: u64,
    pub manufacturer: String,
    pub model: String,
}

/// The seam. Implementations: `MtpRsBackend` (T01) and an in-memory fake used
/// by the tests, which is what lets the queue and state machine be tested
/// without a phone on the desk.
pub trait MtpBackend: Send + Sync {
    /// Attached devices that speak MTP. Devices present on USB *without* an
    /// MTP interface — charging-only mode — are deliberately not returned
    /// here; they surface separately so the UI can tell the two apart.
    fn list_devices(&self) -> Result<Vec<DiscoveredDevice>, AdxError>;
}
