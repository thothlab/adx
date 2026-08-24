//! Automatic device discovery: the list follows the cable, not a button.
//!
//! A refresh button is a confession that the app does not know what is plugged
//! in. Worse, it is the *only* way to notice the case that matters most here —
//! the user picking file-transfer mode on the phone, which happens seconds
//! after the cable goes in, long after any startup enumeration.
//!
//! # Why this watches raw USB rather than `mtp_rs::mtp::watch_devices`
//!
//! The library's watch reports MTP devices only, by design. A phone sitting in
//! charging-only mode is not an MTP device, so it produces no event at all —
//! and that is exactly the state ADX must show and explain. Watching USB
//! itself sees both, and the same enumeration that already merges the two
//! sources ([`MtpBackend::list_devices`]) turns an event into a list.
//!
//! # The startup enumeration is required, not redundant
//!
//! `nusb::watch_devices()` reports *changes* and nothing else: on macOS it
//! drains the already-connected devices at construction, deliberately, to arm
//! the IOKit notification (`nusb-0.2.7/src/platform/macos_iokit/hotplug.rs:170`).
//! So a phone plugged in before ADX started produces no event, and an app that
//! relied on this watcher alone would show an empty list until the user touched
//! the cable. The one-shot enumeration the window runs at startup is what
//! covers that, and removing it as "the watcher handles it" would break the
//! most common case there is.
//!
//! This also means silence at startup is correct behaviour, not a dead watcher
//! — which is why the watcher logs a line when it starts.
//!
//! # Why re-enumerating here cannot disturb an open session
//!
//! Enumeration reads USB descriptors and never opens a device: `mtp-rs` gets
//! its list from `nusb::list_devices()` (`transport/nusb.rs:245`), and the
//! charging-only scan does the same. So a watcher firing while a transfer is
//! running does not race it for the device. That property is what makes an
//! automatic refresh safe at all — an implementation that re-*opened* devices
//! on hotplug would break sessions exactly when a cable is jostled, which is
//! the failure this whole product exists to avoid.

use std::time::Duration;

use futures::StreamExt;

use crate::{DiscoveredDevice, MtpBackend, MtpRsBackend};

/// Quiet period after the last USB event before enumerating.
///
/// One user-visible action is many USB events: a composite phone announces
/// itself once per interface, and switching charging-only -> file transfer is a
/// disconnect followed by a reconnect with different descriptors. Enumerating
/// per event would show the list flickering through half-built states. 700 ms
/// is long enough to swallow those bursts and short enough that the list
/// updates while the user is still looking at the phone.
pub const SETTLE_DELAY: Duration = Duration::from_millis(700);

/// Watch USB and call `on_change` with the full device list after every settled
/// burst of events.
///
/// After *every* burst, not only when the list differs, and that is the whole
/// difference between a list that follows the cable and a session that does.
/// A device replugged into the same port comes back with the same serial, the
/// same location and the same capabilities — identical in every field this
/// crate reports — while the session behind it is dead. Suppressing that as
/// "no change" left the app showing a device it could no longer read, with
/// nothing on screen to say so. The list comparison stays, but only to decide
/// what to write in the log.
///
/// Never returns while the watch is alive. Errors setting up the watch are
/// logged and swallowed: hotplug is an enhancement over the Refresh button, and
/// an app that refuses to start because the OS declined a notification
/// subscription would be worse than one that just needs a click.
pub async fn watch_devices<F>(mut on_change: F)
where
    F: FnMut(Vec<DiscoveredDevice>) + Send + 'static,
{
    let mut watch = match nusb::watch_devices() {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("USB hotplug unavailable, falling back to manual refresh: {e}");
            return;
        }
    };

    // Logged on success, not only on failure. Without it the only evidence the
    // watcher exists is the absence of a warning, and "no warning" looks
    // identical to "never started" — which is exactly the ambiguity that made
    // this feature unverifiable the first time it shipped.
    tracing::info!("USB hotplug watch started; the device list follows the cable");

    let mut last: Option<Vec<DiscoveredDevice>> = None;

    loop {
        // Block until something happens. No polling: an idle ADX must not wake
        // the USB stack every N seconds just to find the same phone.
        if watch.next().await.is_none() {
            tracing::warn!("USB hotplug stream ended; device list is manual from here");
            return;
        }

        // Swallow the rest of the burst, restarting the timer on each event so
        // the enumeration happens once, after things have settled.
        loop {
            match tokio::time::timeout(SETTLE_DELAY, watch.next()).await {
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }

        let devices = match tokio::task::spawn_blocking(|| MtpRsBackend.list_devices()).await {
            Ok(Ok(devices)) => devices,
            Ok(Err(e)) => {
                tracing::warn!("enumeration after a hotplug event failed: {e}");
                continue;
            }
            Err(e) => {
                tracing::warn!("enumeration task failed: {e}");
                continue;
            }
        };

        if changed(last.as_deref(), &devices) {
            tracing::info!("device list changed: {} attached", devices.len());
        } else {
            // Same devices, new connections: a replug into the same port looks
            // exactly like this, and it is the case the app has to recover from.
            tracing::info!("bus settled, list unchanged: {} attached", devices.len());
        }
        last = Some(devices.clone());
        on_change(devices);
    }
}

/// Whether the new list differs from the previous one.
///
/// Only the log line depends on this now — the UI is told either way. It stays
/// because the two cases read very differently when something has gone wrong:
/// "device list changed" after a cable event is ordinary, while the same event
/// producing an unchanged list is the signature of a replug into the same port,
/// which is when a session dies quietly.
///
/// Compares whole devices, not just identity. A phone switching from
/// charging-only to file transfer keeps its location and often its serial while
/// `mtp_available` flips — an identity-only comparison would call that "no
/// change".
fn changed(prev: Option<&[DiscoveredDevice]>, next: &[DiscoveredDevice]) -> bool {
    prev != Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(serial: &str, mtp: bool) -> DiscoveredDevice {
        DiscoveredDevice {
            serial: serial.into(),
            location_id: 0x1234,
            manufacturer: "vivo".into(),
            model: "V2036".into(),
            mtp_available: mtp,
        }
    }

    #[test]
    fn first_enumeration_is_always_a_change() {
        assert!(changed(None, &[]));
        assert!(changed(None, &[device("A", true)]));
    }

    #[test]
    fn an_identical_list_is_not_a_change() {
        let list = vec![device("A", true)];
        assert!(!changed(Some(&list), &list));
    }

    /// The case the whole module exists for: the user picks file-transfer mode
    /// and nothing about the device's identity changes, only its usability.
    #[test]
    fn switching_out_of_charging_only_is_a_change() {
        let before = vec![device("A", false)];
        let after = vec![device("A", true)];
        assert!(changed(Some(&before), &after));
    }

    #[test]
    fn unplugging_the_last_device_is_a_change() {
        let before = vec![device("A", true)];
        assert!(changed(Some(&before), &[]));
    }
}
