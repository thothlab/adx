//! Turning a name the device reported into a name this computer can store.
//!
//! This is the mirror of [`crate::upload::plan_upload`]'s `file_name_of`, and
//! it is the security-relevant half. Upload names come from the local
//! filesystem, so they are already legal here; download names come from the
//! *device*, which is a separate machine whose filesystem rules are not ours
//! and whose contents this app did not create. A name arriving as `../../.ssh`
//! or `..` and being joined onto the destination folder writes outside the
//! folder the user picked. Android will not normally produce such a name, but
//! "normally" is not a property the destination path can rely on.
//!
//! Two independent jobs, both here because both are pure:
//!
//! - **Containment.** Whatever comes back is exactly one path component. No
//!   separators, no `.`/`..`, so `dest.join(component)` cannot leave `dest`.
//! - **Portability.** Windows rejects `\/:*?"<>|`, rejects trailing dots and
//!   spaces, and reserves `CON`, `NUL`, `COM1`… — a folder copied on a Mac and
//!   later opened on Windows should not contain names that machine cannot open.
//!   Applied on every platform on purpose: an SD card or an exFAT drive carries
//!   the same restrictions on macOS.

/// Longest name most filesystems accept, in bytes. ext4, APFS and NTFS all sit
/// at or above 255; truncation happens on the stem so the extension — which is
/// what opens the file — survives.
const MAX_NAME_BYTES: usize = 255;

/// Names Windows resolves to devices rather than to files, in any case and with
/// any extension: `CON.txt` is still the console.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// The name to write on this computer for a device object called `name`.
///
/// Returns `None` only when nothing usable is left — an empty name, or one made
/// entirely of characters that cannot be stored. The caller reports those
/// rather than inventing a name: a file that lands as `_` tells the user
/// nothing about what it was.
///
/// A returned name that differs from the input is still a successful copy, but
/// the caller should say so — a file the user cannot find by the name they saw
/// in the listing is, to them, a file that did not copy.
pub fn host_name(name: &str) -> Option<String> {
    // Control characters and the Windows-illegal set become `_`. Done first so
    // the emptiness checks below see the final shape.
    let mut cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 || c == '\u{7f}' => '_',
            c => c,
        })
        .collect();

    // Trailing dots and spaces: Windows silently strips them when creating a
    // file, so "report." becomes "report" and a second object genuinely named
    // "report" then collides with it. Stripped here, where the collision is
    // still visible to the conflict check.
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    let cleaned = cleaned.trim_start().to_string();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return None;
    }

    // `CON` and friends, with or without an extension. Prefixed rather than
    // replaced so the original name is still readable.
    let stem = cleaned.split('.').next().unwrap_or("");
    let reserved = RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r));
    let cleaned = if reserved { format!("_{cleaned}") } else { cleaned };

    Some(truncate_to_bytes(&cleaned, MAX_NAME_BYTES))
}

/// Shorten to at most `limit` bytes on a character boundary, keeping the last
/// extension if one fits.
fn truncate_to_bytes(name: &str, limit: usize) -> String {
    if name.len() <= limit {
        return name.to_string();
    }

    // `rfind` on the byte string is safe for '.', which is ASCII and cannot
    // appear inside a multi-byte sequence.
    let ext = match name.rfind('.') {
        // A "extension" longer than a quarter of the budget is not an
        // extension, it is the name — dropping the tail of that is better than
        // keeping it and having no stem left.
        Some(dot) if dot > 0 && name.len() - dot <= limit / 4 => &name[dot..],
        _ => "",
    };

    let mut stem_budget = limit - ext.len();
    while stem_budget > 0 && !name.is_char_boundary(stem_budget) {
        stem_budget -= 1;
    }
    format!("{}{ext}", &name[..stem_budget])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Component, Path, PathBuf};

    #[test]
    fn an_ordinary_name_survives_unchanged() {
        assert_eq!(host_name("photo.jpg").as_deref(), Some("photo.jpg"));
        assert_eq!(host_name("Отчёт за 2026.pdf").as_deref(), Some("Отчёт за 2026.pdf"));
        assert_eq!(host_name(".hidden").as_deref(), Some(".hidden"));
    }

    /// The one that matters: nothing the device can say may produce a path that
    /// leaves the folder the user picked. Checked by joining, not by reading
    /// the string — a join is what the executor actually does.
    #[test]
    fn no_device_name_can_escape_the_destination() {
        let dest = PathBuf::from("/tmp/dest");
        for hostile in ["..", "../..", "../../.ssh", "/etc/passwd", "a/b", "a\\b", ".", "..."] {
            let Some(name) = host_name(hostile) else { continue };
            let joined = dest.join(&name);

            assert!(joined.starts_with(&dest), "{hostile:?} escaped as {joined:?}");
            assert_eq!(
                Path::new(&name).components().count(),
                1,
                "{hostile:?} produced more than one path component: {name:?}"
            );
            assert!(
                !Path::new(&name)
                    .components()
                    .any(|c| matches!(c, Component::ParentDir | Component::RootDir)),
                "{hostile:?} produced a traversing component: {name:?}"
            );
        }
    }

    #[test]
    fn names_with_nothing_usable_left_are_refused_rather_than_invented() {
        assert_eq!(host_name(""), None);
        assert_eq!(host_name("."), None);
        assert_eq!(host_name(".."), None);
        assert_eq!(host_name("   "), None);
        assert_eq!(host_name("..."), None, "trailing dots stripped down to \"..\"");
    }

    #[test]
    fn characters_windows_refuses_become_underscores() {
        assert_eq!(host_name("a:b*c?.txt").as_deref(), Some("a_b_c_.txt"));
        assert_eq!(host_name("q\"u<o>t|e").as_deref(), Some("q_u_o_t_e"));
        assert_eq!(host_name("tab\there").as_deref(), Some("tab_here"));
    }

    /// Windows strips these on create, so two device objects that differ only
    /// by a trailing dot would land on the same file with no warning.
    #[test]
    fn trailing_dots_and_spaces_are_stripped() {
        assert_eq!(host_name("report.").as_deref(), Some("report"));
        assert_eq!(host_name("report ").as_deref(), Some("report"));
        assert_eq!(host_name("report. . ").as_deref(), Some("report"));
    }

    #[test]
    fn windows_device_names_are_moved_out_of_the_way() {
        assert_eq!(host_name("CON").as_deref(), Some("_CON"));
        assert_eq!(host_name("nul.txt").as_deref(), Some("_nul.txt"));
        assert_eq!(host_name("COM9.log").as_deref(), Some("_COM9.log"));
        // Not reserved: the check is on the stem, not on a prefix.
        assert_eq!(host_name("CONTRACT.pdf").as_deref(), Some("CONTRACT.pdf"));
        assert_eq!(host_name("COM10").as_deref(), Some("COM10"));
    }

    #[test]
    fn an_over_long_name_is_cut_on_a_character_boundary_and_keeps_its_extension() {
        let long = format!("{}.jpg", "я".repeat(300));
        let out = host_name(&long).unwrap();

        assert!(out.len() <= MAX_NAME_BYTES, "{} bytes", out.len());
        assert!(out.ends_with(".jpg"), "the extension is what opens the file");
        // Cut on a boundary: an invalid UTF-8 tail would not survive `String`,
        // so this asserts the characters are whole rather than replaced.
        assert!(out.trim_end_matches(".jpg").chars().all(|c| c == 'я'));
    }

    #[test]
    fn a_long_name_with_no_real_extension_still_fits() {
        let out = host_name(&"x".repeat(400)).unwrap();
        assert!(out.len() <= MAX_NAME_BYTES);
        assert!(!out.is_empty());
    }
}
