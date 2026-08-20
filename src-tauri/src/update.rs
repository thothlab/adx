//! «Проверить наличие обновлений…» — asking GitHub what the newest release is.
//!
//! # Why this is not `tauri-plugin-updater`
//!
//! That plugin downloads and installs, and to do it safely it verifies a
//! signature against a public key baked into the bundle. This project has no
//! signing key — the releases are unsigned, which the README and the release
//! notes both say out loud. An updater that fetched and ran an unverified
//! binary would be a worse thing than no updater: it would turn "we don't sign"
//! from an inconvenience into a remote code execution path.
//!
//! So this checks and tells. Installing stays a thing the user does knowingly,
//! from a page they can look at.
//!
//! # Why it is in Rust rather than in the web view
//!
//! The window's CSP is `connect-src 'self' ipc:` — deliberately, so that a bug
//! in the interface cannot become an outbound connection. `fetch` to
//! api.github.com from the front end is refused by the browser engine, and
//! widening the CSP to let one feature reach one host would widen it for
//! everything in the window.

use serde::{Deserialize, Serialize};

/// The one endpoint. `/releases/latest` skips drafts and prereleases, which is
/// the correct behaviour here: the release workflow publishes a draft first and
/// only undrafts it once all three systems have reported, so a half-built
/// release must not be offered to anyone.
const LATEST: &str = "https://api.github.com/repos/thothlab/adx/releases/latest";

/// GitHub refuses requests without one, with a 403 that looks nothing like the
/// missing header that caused it.
const USER_AGENT: &str = concat!("ADX/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// The running version, as built.
    pub current: String,
    /// The newest published release, without the `v`.
    pub latest: String,
    /// Where a human goes to get it.
    pub url: String,
    /// True only when `latest` is genuinely newer. A build ahead of the newest
    /// release — which is every development build — reports `false` rather than
    /// offering to "update" the user backwards.
    pub outdated: bool,
}

/// Compare two dotted version strings numerically.
///
/// Not string comparison: `"1.10.0" < "1.9.0"` is true alphabetically and false
/// in every way that matters. Missing or non-numeric components count as zero,
/// so a tag this scheme does not understand degrades to "not newer" instead of
/// producing a confident wrong answer.
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            // A prerelease suffix (`1.2.0-rc1`) compares by its numeric part.
            .split(['.', '-', '+'])
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };

    let (a, b) = (parse(latest), parse(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

#[tauri::command]
pub async fn check_update() -> Result<UpdateCheck, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let response = reqwest::Client::builder()
        // Bounded on purpose: this runs from a menu click and the user is
        // watching a spinner. A hung connection has to end in a sentence they
        // can read, not in a dialog that never resolves.
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?
        .get(LATEST)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        // The status is the useful half — 403 means rate limit, 404 means no
        // published release yet — so it travels rather than being flattened
        // into "could not check".
        return Err(format!("GitHub ответил {}", response.status()));
    }

    let release: GithubRelease = response.json().await.map_err(|e| e.to_string())?;
    let latest = release.tag_name.trim_start_matches('v').to_string();

    Ok(UpdateCheck {
        outdated: is_newer(&latest, &current),
        current,
        latest,
        url: release.html_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The case that makes string comparison wrong, and the reason this
    /// function exists at all.
    #[test]
    fn ten_is_newer_than_nine() {
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(!is_newer("1.9.0", "1.10.0"));
        assert!("1.10.0" < "1.9.0", "the alphabetical answer really is wrong");
    }

    #[test]
    fn equal_versions_are_not_an_update() {
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("v1.0.0", "1.0.0"), "the leading v is not part of the number");
    }

    /// A development build sits ahead of the newest release. Offering it an
    /// "update" would walk the developer backwards into the last tag.
    #[test]
    fn a_build_ahead_of_the_release_is_not_outdated() {
        assert!(!is_newer("1.0.0", "1.1.0"));
    }

    #[test]
    fn shorter_versions_compare_by_the_missing_zero() {
        assert!(is_newer("1.1", "1.0.9"));
        assert!(!is_newer("1.0", "1.0.0"));
        assert!(is_newer("2", "1.9.9"));
    }

    /// An unparseable tag must not read as newer — the safe direction is
    /// "nothing to do", because the alternative sends the user to a page for a
    /// release this code did not understand.
    #[test]
    fn a_tag_this_scheme_does_not_understand_is_not_newer() {
        assert!(!is_newer("nightly", "1.0.0"));
        assert!(!is_newer("", "1.0.0"));
    }

    /// A prerelease compares on its numbers: `1.1.0-rc1` is ahead of `1.0.0`
    /// and behind `1.1.1`.
    #[test]
    fn a_prerelease_compares_by_its_numeric_part() {
        assert!(is_newer("1.1.0-rc1", "1.0.0"));
        assert!(!is_newer("1.1.0-rc1", "1.1.1"));
    }
}
