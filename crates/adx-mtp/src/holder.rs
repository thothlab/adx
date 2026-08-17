//! Who is holding the device.
//!
//! Knowing that a device is held is only half the message; the user needs the
//! name of the process to act on it. macOS puts it in the IORegistry under
//! `UsbExclusiveOwner`, which `ioreg` will print. Other platforms have no
//! equivalent, so they get `None` and the UI falls back to generic wording.
//!
//! Two things about that dump were wrong in the first version of this file, and
//! both were only visible with a phone plugged in:
//!
//! 1. **It is a tree, not a list.** Every USB hub on the machine has a
//!    `UsbExclusiveOwner` too — `AppleUSB30Hub` and friends — and on this
//!    machine they come first. Taking the first match named a *hub* as the
//!    process holding the user's phone.
//! 2. **The value has more than one shape.** Darwin 25.5 writes
//!    `"pid 68495, adb"`; the form documented elsewhere is `"ptpcamerad(1234)"`.
//!    A parser that knows only the second turns the first into a process called
//!    "pid 68495, adb" with pid 0.

use adx_core::ProcessRef;

#[cfg(target_os = "macos")]
pub fn exclusive_owner(serial: &str) -> Option<ProcessRef> {
    use std::process::Command;

    // Shelling out rather than linking IOKit keeps a C dependency out of the
    // build for a string that is read once per failed open.
    let out = Command::new("ioreg").args(["-p", "IOUSB", "-w0", "-l"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    parse_exclusive_owner(&text, serial)
}

#[cfg(not(target_os = "macos"))]
pub fn exclusive_owner(_serial: &str) -> Option<ProcessRef> {
    None
}

/// Pull the `UsbExclusiveOwner` of the node whose USB serial number matches.
///
/// Split out from the command call so the parsing is testable on any platform
/// and without a device attached — the only part that can realistically be
/// wrong is the parse, and it was.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_exclusive_owner(text: &str, serial: &str) -> Option<ProcessRef> {
    let needle = format!("\"USB Serial Number\" = \"{serial}\"");
    let mut in_our_node = false;

    for line in text.lines() {
        // `+-o Name@addr <class …>` opens a node; everything until the next one
        // belongs to it. Cheaper and steadier than brace counting, because the
        // dump nests dictionaries inside single property lines.
        if line.contains("+-o ") {
            in_our_node = false;
        }
        if line.contains(&needle) {
            in_our_node = true;
        }
        if in_our_node && line.contains("UsbExclusiveOwner") {
            return owner_from_value(line.split('=').nth(1)?);
        }
    }
    None
}

/// Both observed shapes, plus a bare name.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn owner_from_value(raw: &str) -> Option<ProcessRef> {
    let value = raw.trim().trim_matches('"').trim();
    if value.is_empty() {
        return None;
    }

    // Darwin 25.5: "pid 68495, adb"
    if let Some(rest) = value.strip_prefix("pid ") {
        if let Some((pid, name)) = rest.split_once(',') {
            let name = name.trim();
            if !name.is_empty() {
                return Some(ProcessRef {
                    pid: pid.trim().parse().unwrap_or(0),
                    name: name.to_string(),
                });
            }
        }
    }

    // Older form: "ptpcamerad(1234)"
    if let Some((name, rest)) = value.rsplit_once('(') {
        let name = name.trim();
        if !name.is_empty() {
            return Some(ProcessRef {
                pid: rest.trim_end_matches(')').trim().parse().unwrap_or(0),
                name: name.to_string(),
            });
        }
    }

    // A name without a pid still beats "some other process".
    Some(ProcessRef { pid: 0, name: value.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real `ioreg -p IOUSB -w0 -l` on Darwin 25.5, with a phone
    /// attached. The hubs come first on purpose: that ordering is what made the
    /// first version of this parser name a hub as the holder.
    const DUMP: &str = r#"
  +-o AppleUSB30XHCIPort@01100000  <class AppleUSBHostPort, id 0x100000abc>
      {
        "UsbExclusiveOwner" = "AppleUSB30Hub"
        "USB Product Name" = "USB3 Gen2 Hub"
      }
  +-o USB2 Hub@02100000  <class IOUSBHostDevice, id 0x100000def>
      {
        "USB Serial Number" = "000000000"
        "UsbExclusiveOwner" = "AppleUSB20Hub"
      }
  +-o V2036@02110000  <class IOUSBHostDevice, id 0x100001c0b>
      {
        "kUSBSerialNumberString" = "155521910300A30"
        "USB Serial Number" = "155521910300A30"
        "USB Vendor Name" = "vivo"
        "idVendor" = 11669
        "UsbExclusiveOwner" = "pid 68495, adb"
        "locationID" = 34668544
      }
  +-o AppleUSB30XHCIPort@03100000  <class AppleUSBHostPort, id 0x100000fff>
      {
        "UsbExclusiveOwner" = "AppleUSB30Hub"
      }
"#;

    /// The bug this file exists to not repeat: several devices report an owner,
    /// and only one of them is the phone.
    #[test]
    fn picks_the_owner_of_the_matching_device_not_the_first_in_the_tree() {
        let owner = parse_exclusive_owner(DUMP, "155521910300A30").unwrap();
        assert_eq!(owner.name, "adb");
        assert_eq!(owner.pid, 68495);
    }

    #[test]
    fn a_serial_that_is_not_in_the_dump_has_no_owner() {
        assert!(parse_exclusive_owner(DUMP, "NOSUCHSERIAL").is_none());
    }

    /// A device present but held by nobody must not inherit the next node's
    /// owner — that would blame an innocent process for a failure it caused
    /// none of.
    #[test]
    fn a_node_without_an_owner_does_not_borrow_the_next_one() {
        let dump = r#"
  +-o V2036@02110000  <class IOUSBHostDevice>
      {
        "USB Serial Number" = "AAA"
      }
  +-o Other@03110000  <class IOUSBHostDevice>
      {
        "USB Serial Number" = "BBB"
        "UsbExclusiveOwner" = "pid 5, thief"
      }
"#;
        assert!(parse_exclusive_owner(dump, "AAA").is_none());
        assert_eq!(parse_exclusive_owner(dump, "BBB").unwrap().name, "thief");
    }

    #[test]
    fn understands_both_observed_value_shapes() {
        let a = owner_from_value(r#" "pid 68495, adb""#).unwrap();
        assert_eq!((a.name.as_str(), a.pid), ("adb", 68495));

        let b = owner_from_value(r#" "ptpcamerad(1234)""#).unwrap();
        assert_eq!((b.name.as_str(), b.pid), ("ptpcamerad", 1234));

        let c = owner_from_value(r#" "Android File Transfer""#).unwrap();
        assert_eq!((c.name.as_str(), c.pid), ("Android File Transfer", 0));
    }

    #[test]
    fn an_empty_owner_is_no_owner() {
        assert!(owner_from_value(r#" """#).is_none());
        assert!(owner_from_value("   ").is_none());
    }
}
