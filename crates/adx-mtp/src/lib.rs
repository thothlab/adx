//! The MTP backend — and the only crate allowed to name `mtp_rs`.
//!
//! Everything above this crate talks to [`MtpBackend`] and to the model types
//! in `adx-core`. That boundary is checked, not just intended: T01's
//! definition of done greps the tree for `mtp_rs::` outside this crate. The
//! reason is concrete — `mtp-rs` is at 0.30.0 and ships breaking changes every
//! few days, so a version bump must not be able to reach the UI.

mod error;
mod holder;
mod session;
mod transfer;
mod usb;
mod watch;

pub use error::map_error;
pub use holder::exclusive_owner;
pub use session::{Entry, Session, StorageRef, UploadFailure};
/// Exposed for `examples/probe`, not for the app: the merged list from
/// [`MtpBackend::list_devices`] is the only one the UI should ever see. The
/// probe needs the unmerged input to tell "dedup worked" apart from "there was
/// nothing to dedup", which the merged list alone cannot distinguish.
pub use usb::charging_only_candidates;
pub use transfer::{upload_tree, ConflictPolicy, UploadProgress, UploadReport};
pub use watch::{watch_devices, SETTLE_DELAY};

use adx_core::AdxError;

/// One attached device, before it is opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredDevice {
    /// Primary key across refreshes. Falls back to a location-derived string
    /// when the device reports no serial — some do not.
    pub serial: String,
    /// Physical USB port path. Stable while the cable stays in the same port,
    /// so it is the tiebreaker when two devices report the same serial.
    pub location_id: u64,
    pub manufacturer: String,
    pub model: String,
    /// False when the device is on USB without an MTP interface — the
    /// charging-only case. The UI shows a different instruction for it, which
    /// is the whole reason the flag exists rather than the device being
    /// silently absent.
    pub mtp_available: bool,
}

/// The seam. Implementations: [`MtpRsBackend`] and, in tests, an in-memory
/// fake — which is what lets the queue and the state machine be exercised
/// without a phone on the desk.
pub trait MtpBackend: Send + Sync {
    /// Attached devices, both the ones speaking MTP and the ones present on
    /// USB without an MTP interface (`mtp_available == false`).
    fn list_devices(&self) -> Result<Vec<DiscoveredDevice>, AdxError>;
}

/// Production backend, on `mtp-rs` 0.30.0.
#[derive(Debug, Default, Clone, Copy)]
pub struct MtpRsBackend;

impl MtpBackend for MtpRsBackend {
    fn list_devices(&self) -> Result<Vec<DiscoveredDevice>, AdxError> {
        let mtp = mtp_rs::mtp::MtpDevice::list_devices().map_err(|e| map_error(&e))?;

        let mut out: Vec<DiscoveredDevice> = mtp
            .into_iter()
            .map(|d| DiscoveredDevice {
                serial: d
                    .serial_number
                    .clone()
                    .unwrap_or_else(|| format!("loc:{:08x}", d.location_id)),
                location_id: d.location_id,
                manufacturer: d.manufacturer.clone().unwrap_or_default(),
                model: d.product.clone().unwrap_or_default(),
                mtp_available: true,
            })
            .collect();

        // Anything that looks like a phone but did not make the MTP list is
        // almost certainly sitting in charging-only mode. Matching by location
        // rather than by serial: a device in charging-only mode often reports
        // no serial at all, so a serial-keyed merge would double-list it the
        // moment the user switches the mode.
        let seen: Vec<u64> = out.iter().map(|d| d.location_id).collect();
        for cand in usb::charging_only_candidates() {
            if !seen.contains(&cand.location_id) {
                out.push(cand);
            }
        }

        out.sort_by(|a, b| a.location_id.cmp(&b.location_id));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fake every hardware-free test upstream will use. Its existence here
    /// is the point: if the trait ever grows a method that only a real device
    /// can answer, this stops compiling and the design problem surfaces at
    /// once instead of in a test that needs a phone.
    struct FakeBackend(Vec<DiscoveredDevice>);

    impl MtpBackend for FakeBackend {
        fn list_devices(&self) -> Result<Vec<DiscoveredDevice>, AdxError> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn fake_backend_satisfies_the_trait() {
        let dev = DiscoveredDevice {
            serial: "ABC123".into(),
            location_id: 0x1400_0000,
            manufacturer: "Google".into(),
            model: "Pixel".into(),
            mtp_available: true,
        };
        let b = FakeBackend(vec![dev.clone()]);
        assert_eq!(b.list_devices().unwrap(), vec![dev]);
    }

    /// Enumeration must not fail just because nothing is plugged in — an empty
    /// list is the normal state, and turning it into an error would light up
    /// the UI's error banner every time the user unplugs the cable.
    #[test]
    fn listing_with_no_device_is_ok_and_empty() {
        let devices = MtpRsBackend.list_devices().expect("enumeration must not error");
        for d in &devices {
            assert!(!d.serial.is_empty(), "serial fallback must never be empty");
        }
    }
}
