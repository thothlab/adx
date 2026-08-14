//! Telling "no phone" apart from "phone in charging-only mode".
//!
//! `mtp-rs` lists MTP candidates only, by design. A phone whose USB mode is
//! charging-only exposes no MTP interface, so it is simply absent from that
//! list — and the user sees "no device connected" while looking at a plugged-in
//! phone. That is the single most confusing state this app can show, so it gets
//! its own detection: enumerate USB directly and report the phones that did not
//! make the MTP list.
//!
//! Everything here only ever produces a *hint* — never a device the user can
//! browse — so a misclassification costs a wrong message, never data.

use nusb::MaybeFuture;

use crate::DiscoveredDevice;

/// USB vendor IDs worth recognising as possible phones. Sourced from the public
/// USB-IF vendor registry; not exhaustive and not meant to be.
///
/// Several of these vendors also ship hubs, docks, mice and modems, so a vendor
/// match alone is not enough — see [`is_plausible_phone`].
const PHONE_VENDORS: &[(u16, &str)] = &[
    (0x18d1, "Google"),
    (0x04e8, "Samsung"),
    (0x2717, "Xiaomi"),
    (0x2a70, "OnePlus"),
    (0x22d9, "OPPO"),
    (0x2d95, "Vivo"),
    (0x12d1, "Huawei"),
    (0x0bb4, "HTC"),
    (0x2916, "Android"),
    (0x0e8d, "MediaTek"),
    (0x1004, "LG"),
    (0x0fce, "Sony"),
    (0x17ef, "Lenovo/Motorola"),
];

/// USB device classes that rule a device out. A phone in charging-only mode
/// exposes either a vendor-specific interface (ADB, tethering) or nothing at
/// all — never a hub, a keyboard or a disk. Without this filter a Lenovo dock,
/// a MediaTek dongle or a Huawei modem shows up as "Android device in
/// charging-only mode", and unlike a transient glitch it does not go away on
/// refresh: the thing is still plugged in.
const EXCLUDED_CLASSES: &[u8] = &[
    0x03, // HID — keyboards, mice
    0x07, // Printer
    0x08, // Mass storage — external drives, card readers
    0x09, // Hub
    0x0e, // Video — webcams
    0x01, // Audio — USB DACs, headsets
];

pub fn charging_only_candidates() -> Vec<DiscoveredDevice> {
    let Ok(devices) = nusb::list_devices().wait() else {
        // Enumeration failing is not worth surfacing: the MTP list is the
        // primary source, and this is only a hint layered on top of it.
        return Vec::new();
    };

    devices
        .filter_map(|d: nusb::DeviceInfo| {
            let vendor = PHONE_VENDORS.iter().find(|(id, _)| *id == d.vendor_id())?;
            if !is_plausible_phone(&d) {
                return None;
            }
            let location = location_id_from_topology(&d);
            Some(DiscoveredDevice {
                serial: d
                    .serial_number()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("loc:{location:016x}")),
                location_id: location,
                manufacturer: d.manufacturer_string().unwrap_or(vendor.1).to_string(),
                model: d.product_string().unwrap_or_default().to_string(),
                mtp_available: false,
            })
        })
        .collect()
}

/// Reject devices whose class says they cannot be a phone.
///
/// Checks the device descriptor class and every interface class. Composite
/// devices report class 0 at the device level and put the real class on the
/// interfaces, so checking only one of the two misses half the cases.
fn is_plausible_phone(d: &nusb::DeviceInfo) -> bool {
    if EXCLUDED_CLASSES.contains(&d.class()) {
        return false;
    }
    !d.interfaces().any(|i| EXCLUDED_CLASSES.contains(&i.class()))
}

/// The device's location key, computed **exactly** as `mtp-rs` computes its
/// `location_id`: FNV-1a 64 over the bus id bytes, a `0xFF` separator, then the
/// port chain bytes. Source: `mtp-rs-0.30.0/src/transport/nusb.rs:1146-1164`
/// (`location_id_from_topology`).
///
/// The two values must agree, because `MtpRsBackend::list_devices` deduplicates
/// the MTP list against this one by location. A key that merely *looks* stable
/// is not enough: if the derivations diverge, every phone in MTP mode is listed
/// twice — once browsable, once claiming to be in charging-only mode, which is
/// exactly the confusion this module exists to remove.
fn location_id_from_topology(d: &nusb::DeviceInfo) -> u64 {
    location_key(d.bus_id(), d.port_chain())
}

/// The pure part, split out so the algorithm can be pinned by a test without
/// constructing a `nusb::DeviceInfo` (which has no public constructor).
fn location_key(bus_id: &str, port_chain: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0100_0000_01b3;

    let mut hash = FNV_OFFSET;
    for byte in bus_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    // Separator, so bus "1" + ports [2,3] differs from bus "12" + ports [3].
    hash ^= 0xFF;
    hash = hash.wrapping_mul(FNV_PRIME);
    for byte in port_chain {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the algorithm to values computed independently of this code (a
    /// standalone FNV-1a implementation), not to whatever it currently returns.
    /// A tautological test here would defeat the point: the risk is that the
    /// derivation silently stops matching `mtp-rs`, and only fixed vectors
    /// catch that.
    #[test]
    fn location_key_matches_the_library_algorithm() {
        assert_eq!(location_key("1", &[2, 3]), 0x40ae_33ed_1e9b_a206);
        assert_eq!(location_key("12", &[3]), 0x222a_8ef1_0533_4d24);
        assert_eq!(location_key("1", &[]), 0x07f7_c907_b4b8_b319);
    }

    /// The separator exists for this case; without it both inputs hash the same
    /// and two devices on different buses would collapse into one row.
    #[test]
    fn bus_and_port_boundaries_do_not_blur() {
        assert_ne!(location_key("1", &[2, 3]), location_key("12", &[3]));
    }

    /// Port numbers above 15 must stay distinct. The first version of this
    /// function packed each port into 4 bits, which silently aliased them.
    #[test]
    fn high_port_numbers_stay_distinct() {
        assert_ne!(location_key("1", &[16]), location_key("1", &[0]));
        assert_ne!(location_key("1", &[17]), location_key("1", &[1]));
    }

    /// Runs against whatever is plugged into the build machine, including
    /// nothing at all. The invariant is the one that matters: this path must
    /// never hand the UI a device it would treat as browsable, and must never
    /// call a hub, a disk or a sound card a phone.
    #[test]
    fn enumeration_never_panics_and_never_claims_mtp() {
        for d in charging_only_candidates() {
            assert!(!d.mtp_available);
            assert!(!d.serial.is_empty());
        }
    }

    /// Guards the class filter against the hardware actually on this machine:
    /// a USB hub, a FIIO audio interface and two Toshiba mass-storage drives.
    /// None of them may be reported as an Android device.
    #[test]
    fn attached_non_phones_are_not_reported() {
        let names: Vec<String> = charging_only_candidates()
            .into_iter()
            .map(|d| format!("{} {}", d.manufacturer, d.model).to_lowercase())
            .collect();
        for banned in ["hub", "fiio", "toshiba", "keyboard", "mouse"] {
            assert!(
                !names.iter().any(|n| n.contains(banned)),
                "{banned} reported as a phone: {names:?}",
            );
        }
    }
}
