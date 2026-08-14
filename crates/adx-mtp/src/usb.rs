//! Telling "no phone" apart from "phone in charging-only mode".
//!
//! `mtp-rs` lists MTP candidates only, by design. A phone whose USB mode is
//! charging-only exposes no MTP interface, so it is simply absent from that
//! list — and the user sees "no device connected" while looking at a plugged-in
//! phone. That is the single most confusing state this app can show, so it gets
//! its own detection: enumerate USB directly and report the phones that did not
//! make the MTP list.
//!
//! The vendor-ID list below is a heuristic and is honestly labelled as one. It
//! only ever produces a *hint* — never a device the user can browse — so a
//! false positive costs a stale row that disappears on refresh, and a false
//! negative costs the old confusing message. Neither can corrupt data.

use crate::DiscoveredDevice;

/// USB vendor IDs of the phone makers worth recognising. Sourced from the
/// public USB-IF vendor registry; not exhaustive and not meant to be.
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
    (0x2c7c, "Quectel"),
    (0x17ef, "Lenovo/Motorola"),
];

pub fn charging_only_candidates() -> Vec<DiscoveredDevice> {
    // `nusb::list_devices()` returns a `MaybeFuture`; `.wait()` is its
    // blocking arm. Enumeration is a fast, non-blocking syscall on every
    // supported platform, so this does not need to be async.
    use nusb::MaybeFuture;
    let Ok(devices) = nusb::list_devices().wait() else {
        // Enumeration failing is not worth surfacing: the MTP list is the
        // primary source, and this is only a hint on top of it.
        return Vec::new();
    };

    devices
        .filter_map(|d: nusb::DeviceInfo| {
            let vendor = PHONE_VENDORS.iter().find(|(id, _)| *id == d.vendor_id())?;
            let location = location_key(&d);
            Some(DiscoveredDevice {
                serial: d
                    .serial_number()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("loc:{location:08x}")),
                location_id: location,
                manufacturer: d.manufacturer_string().unwrap_or(vendor.1).to_string(),
                model: d.product_string().unwrap_or_default().to_string(),
                mtp_available: false,
            })
        })
        .collect()
}

/// A stable-per-port key, built the same way `mtp-rs` derives its
/// `location_id`: bus number plus the port chain. It has to line up with the
/// library's value, because the merge in `list_devices` deduplicates on it.
fn location_key(d: &nusb::DeviceInfo) -> u64 {
    let mut key = u64::from(d.bus_id().bytes().fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(u32::from(b)))) << 32;
    for (i, port) in d.port_chain().iter().enumerate().take(7) {
        key |= u64::from(*port) << (i * 4);
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumeration_never_panics_and_never_claims_mtp() {
        // Runs against whatever is plugged into the build machine, including
        // nothing at all. The invariant under test is the one that matters:
        // this path must never hand the UI a device it would treat as browsable.
        for d in charging_only_candidates() {
            assert!(!d.mtp_available);
            assert!(!d.serial.is_empty());
        }
    }
}
