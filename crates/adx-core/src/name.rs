//! What a name has to look like before it is worth sending to a device.
//!
//! One rule, in one place, for three callers that would otherwise each invent
//! their own: the upload planner naming a file on the device, `folder_create`,
//! and `entry_rename`. The rule is checked here rather than at the device
//! because the device's answer to a bad name is a protocol error mid-operation
//! — during an upload that means a half-copied tree, and during a rename it
//! means the user learns the name was impossible only after the round trip.
//!
//! The device stays the final authority: it can refuse a name this accepts
//! (reserved names, its own filesystem's rules), and that refusal still travels
//! back as an error. What this removes is the class of names *nothing* could
//! store.
//!
//! The frontend carries the same rule a second time, in `src/lib/names.ts`, so
//! the dialog can grey out its button while the user types instead of waiting
//! for a round trip. Two copies of one rule is an invariant, not a coincidence:
//! both are pinned by the same vectors — see `names_the_frontend_also_pins`
//! here and `matches the Rust rule` there.

/// Why a name cannot be used. Maps 1:1 onto the error kinds the UI already
/// knows how to say in two languages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameProblem {
    /// Empty, or nothing but whitespace.
    Empty,
    /// More than [`MAX_NAME_CHARS`] characters.
    TooLong,
    /// Contains a path separator or a null byte.
    Invalid,
}

/// Counted in characters, not bytes: MTP names travel as UTF-16, so a
/// byte-length limit would reject a Cyrillic name half as long as an ASCII one
/// that passes.
pub const MAX_NAME_CHARS: usize = 254;

/// Check a name a user typed, or one derived from a local path.
///
/// Whitespace is trimmed before the check but *not* returned trimmed — trimming
/// silently would rename `"photo "` to `"photo"` without telling anyone, and
/// the caller that wants the trimmed form should trim it itself.
pub fn check_name(name: &str) -> Result<(), NameProblem> {
    if name.trim().is_empty() {
        return Err(NameProblem::Empty);
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(NameProblem::Invalid);
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(NameProblem::TooLong);
    }
    Ok(())
}

impl From<NameProblem> for crate::AdxError {
    fn from(p: NameProblem) -> Self {
        use crate::ErrorKind;
        match p {
            // No separate "empty" kind: to the user both are the same sentence
            // — this name cannot be used — and an empty name is unreachable
            // from the dialog anyway, which keeps its button disabled.
            NameProblem::Empty => Self::new(ErrorKind::NameInvalid, "пустое имя"),
            NameProblem::Invalid => {
                Self::new(ErrorKind::NameInvalid, "имя содержит разделитель пути или нулевой байт")
            }
            NameProblem::TooLong => Self::new(
                ErrorKind::NameTooLong,
                format!("имя длиннее {MAX_NAME_CHARS} символов"),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_names_pass() {
        assert_eq!(check_name("photo.jpg"), Ok(()));
        assert_eq!(check_name("Отпуск 2026"), Ok(()));
        assert_eq!(check_name("."), Ok(()), "the device decides about dot names, not us");
    }

    #[test]
    fn empty_and_blank_names_are_refused() {
        assert_eq!(check_name(""), Err(NameProblem::Empty));
        assert_eq!(check_name("   "), Err(NameProblem::Empty));
        assert_eq!(check_name("\t\n"), Err(NameProblem::Empty));
    }

    #[test]
    fn separators_and_nulls_are_refused() {
        assert_eq!(check_name("a/b"), Err(NameProblem::Invalid));
        assert_eq!(check_name("a\\b"), Err(NameProblem::Invalid));
        assert_eq!(check_name("a\0b"), Err(NameProblem::Invalid));
    }

    /// The limit is in characters. A 254-character Cyrillic name is 508 bytes
    /// and must pass; a byte-length check would have refused it.
    #[test]
    fn the_limit_counts_characters_not_bytes() {
        assert_eq!(check_name(&"x".repeat(254)), Ok(()));
        assert_eq!(check_name(&"x".repeat(255)), Err(NameProblem::TooLong));

        let cyrillic = "я".repeat(254);
        assert_eq!(cyrillic.len(), 508, "the fixture must actually be multi-byte");
        assert_eq!(check_name(&cyrillic), Ok(()));
        assert_eq!(check_name(&"я".repeat(255)), Err(NameProblem::TooLong));
    }

    /// A separator in an over-long name reports the separator. Not arbitrary:
    /// the length is fixable by trimming, the separator is not, and telling the
    /// user the shorter truth first sends them to retype rather than to think.
    #[test]
    fn the_unfixable_problem_is_reported_first() {
        let long_with_slash = format!("{}/{}", "x".repeat(200), "y".repeat(200));
        assert_eq!(check_name(&long_with_slash), Err(NameProblem::Invalid));
    }

    /// These exact strings are pinned in `src/lib/names.test.ts` as well. The
    /// two implementations are allowed to exist; disagreeing is not.
    #[test]
    fn names_the_frontend_also_pins() {
        for (name, expected) in [
            ("ok.txt", Ok(())),
            ("", Err(NameProblem::Empty)),
            ("   ", Err(NameProblem::Empty)),
            ("a/b", Err(NameProblem::Invalid)),
            ("a\\b", Err(NameProblem::Invalid)),
        ] {
            assert_eq!(check_name(name), expected, "{name:?}");
        }
        assert_eq!(check_name(&"x".repeat(254)), Ok(()));
        assert_eq!(check_name(&"x".repeat(255)), Err(NameProblem::TooLong));
    }
}
