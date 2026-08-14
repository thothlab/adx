//! Who is holding the device.
//!
//! Knowing that a device is held is only half the message; the user needs the
//! name of the process to act on it. macOS puts it in the IORegistry under
//! `UsbExclusiveOwner`, which `ioreg` will print. Other platforms have no
//! equivalent, so they get `None` and the UI falls back to generic wording.

use adx_core::ProcessRef;

#[cfg(target_os = "macos")]
pub fn exclusive_owner() -> Option<ProcessRef> {
    use std::process::Command;

    // `ioreg -l` prints the whole property tree; the owner shows up as
    // `"UsbExclusiveOwner" = "ptpcamerad(1234)"`. Shelling out rather than
    // linking IOKit keeps a C dependency out of the build for a string that is
    // read once per failed open.
    let out = Command::new("ioreg").args(["-p", "IOUSB", "-w0", "-l"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    parse_exclusive_owner(&text)
}

#[cfg(not(target_os = "macos"))]
pub fn exclusive_owner() -> Option<ProcessRef> {
    None
}

/// Pull the first `UsbExclusiveOwner` value out of an `ioreg` dump.
///
/// Split out from the command call so the parsing is testable on any platform
/// and without a device attached — the only part that can realistically be
/// wrong is the parse.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_exclusive_owner(text: &str) -> Option<ProcessRef> {
    let line = text.lines().find(|l| l.contains("UsbExclusiveOwner"))?;
    let value = line.split('=').nth(1)?.trim().trim_matches('"');
    if value.is_empty() {
        return None;
    }

    // Observed form is `name(pid)`. Anything else still yields a usable name,
    // because a name without a pid beats "some other process".
    match value.rsplit_once('(') {
        Some((name, rest)) => {
            let pid = rest.trim_end_matches(')').trim().parse().unwrap_or(0);
            Some(ProcessRef { pid, name: name.trim().to_string() })
        }
        None => Some(ProcessRef { pid: 0, name: value.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_and_pid() {
        let dump = r#"
        | |   "IOUserClientClass" = "IOUSBDeviceUserClientV2"
        | |   "UsbExclusiveOwner" = "ptpcamerad(1234)"
        "#;
        let owner = parse_exclusive_owner(dump).unwrap();
        assert_eq!(owner.name, "ptpcamerad");
        assert_eq!(owner.pid, 1234);
    }

    #[test]
    fn survives_a_value_without_a_pid() {
        let dump = r#""UsbExclusiveOwner" = "Android File Transfer""#;
        let owner = parse_exclusive_owner(dump).unwrap();
        assert_eq!(owner.name, "Android File Transfer");
        assert_eq!(owner.pid, 0);
    }

    #[test]
    fn absent_or_empty_owner_yields_none() {
        assert!(parse_exclusive_owner("nothing here").is_none());
        assert!(parse_exclusive_owner(r#""UsbExclusiveOwner" = """#).is_none());
    }
}
