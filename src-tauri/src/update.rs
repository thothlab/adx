//! «Проверить наличие обновлений…» — asking GitHub what the newest release is.
//!
//! # Why this exists next to `tauri-plugin-updater`
//!
//! Since 1.0.5 the app can install updates itself: every release is signed with
//! the project's update key (minisign — the public half is in
//! `tauri.conf.json`, the private half is a repository secret used by CI), and
//! the plugin refuses anything that does not match. That is what makes the
//! button safe; an updater that ran an unverified binary would turn "our builds
//! carry no Apple signature" from an inconvenience into a remote code execution
//! path.
//!
//! This check stays because it answers a question the plugin cannot. The plugin
//! reads a manifest attached to the newest release, so a release published
//! before the updater existed, or one whose signing step failed, is simply
//! invisible to it — and "no update available" is exactly the wrong thing to
//! tell someone running a version from six months ago. Asking GitHub what the
//! newest release *is* has no such blind spot, and the dialog uses the two
//! together: this one decides whether there is news, the plugin decides whether
//! it can be installed from here or has to be fetched from the page by hand.
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
const USER_AGENT: &str = "ADX";

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
pub async fn check_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UpdateCheck, String> {
    // The version the *bundle* carries, not `CARGO_PKG_VERSION`.
    //
    // They are two different fields — `src-tauri/Cargo.toml` and
    // `tauri.conf.json` — and this project has already been bitten by them
    // disagreeing: the 1.0.0 tag would have shipped installers named 0.1.0 if
    // only one had been bumped. Here the cost of the same slip is worse than a
    // filename: a user on 1.1.0 would be told they are on 1.0.0 and offered an
    // "update" to the build already running. `package_info()` reads what the
    // installer and the About panel read.
    let current = app.package_info().version.to_string();

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
