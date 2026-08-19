//! The `adx://` scheme: playing media straight off the device.
//!
//! # Why media does not go through the preview's byte read
//!
//! Every other preview reads the file into memory and hands the webview a blob.
//! That works because a photo is megabytes and a text file is capped. It does
//! not work for media, and not marginally: the phone this was built against has
//! `.m4b` audiobooks of 700-900 MB in `Audiobooks/`. Reading one into the
//! webview would spend minutes on USB before the first sound, allocate most of
//! a gigabyte, and still not let the user drag the position slider — a blob has
//! to be complete before it is anything.
//!
//! So media is served instead of loaded. The player asks for the byte ranges it
//! wants, when it wants them; playback starts after the first chunk, and a seek
//! is a request for a different offset rather than a re-read of the file.
//!
//! # Every response is bounded
//!
//! A player opening a file asks for `Range: bytes=0-` — "everything". Answering
//! that literally would put us back to reading 700 MB in one go, just through a
//! different door. So a response is capped at [`MAX_CHUNK`] regardless of what
//! was asked for, and reports what it actually sent in `Content-Range`. That is
//! ordinary HTTP: a server may always return less of a range than requested,
//! and the player simply asks for the next piece.
//!
//! The cap is also what keeps the device usable during playback. Each chunk is
//! one short read holding the session, on the same rule as the download
//! executor — the tree and the listing keep working while a video plays.
//!
//! # The exclusion with transfers is one-directional, on purpose
//!
//! A request arriving while a transfer runs is refused (see `transferring`
//! below). The reverse is *not* blocked: a download may start while media is
//! playing, and the frontend does not know a player exists. The asymmetry is
//! deliberate rather than an oversight, because the two failure modes are not
//! alike. A transfer interrupted or slowed by playback is a job the user is
//! waiting on getting slower for no visible reason; playback slowed by a
//! transfer just stutters, and the next range request still arrives — one
//! window later. Degrading is an acceptable answer for a player and not for a
//! copy, so only the copy gets protected.

use std::sync::atomic::Ordering;

// `tauri::http`, not the `http` crate directly: Tauri re-exports the exact
// version its runtime speaks, and a second copy in the tree would make the
// types here incompatible with the responder's.
use tauri::http;
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::commands::token;
use crate::state::AppState;

/// Registered as `adx://localhost/<storage>-<handle>.<ext>` (macOS, Linux) or
/// `http://adx.localhost/...` (Windows). The frontend builds it with Tauri's
/// `convertFileSrc(path, "adx")`, which knows which shape the platform needs.
pub const SCHEME: &str = "adx";

/// Most bytes one response may carry.
///
/// 2 MiB is several seconds of audio and about a second of video, so the player
/// always has a buffer ahead of it, and one chunk is ~70 ms of held session on
/// the measured device — short enough that a folder listing issued during
/// playback does not feel delayed.
const MAX_CHUNK: u64 = 2 * 1024 * 1024;

/// Serve a range of an object on the device.
///
/// Runs on the async runtime rather than blocking the caller: the responder is
/// exactly the "answer later" mechanism this needs, and a read that waited for
/// the session mutex on the webview's thread would freeze the window while a
/// download had the device.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let response = match serve(&app, &request).await {
            Ok(response) => response,
            Err(status) => http::Response::builder()
                .status(status)
                .header("Access-Control-Allow-Origin", "*")
                .body(Vec::new())
                .expect("a bodyless error response is always well formed"),
        };
        responder.respond(response);
    });
}

async fn serve<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: &http::Request<Vec<u8>>,
) -> Result<http::Response<Vec<u8>>, http::StatusCode> {
    let (storage_id, handle, ext) = parse_path(request.uri().path()).ok_or(http::StatusCode::BAD_REQUEST)?;

    let state = app.state::<AppState>();

    // A transfer in flight owns the device for as long as it runs, window by
    // window. Playback would interleave with it correctly but both would crawl,
    // and the user started the transfer on purpose. Refusing here is honest;
    // the player surfaces it as a media error rather than as a stall of unknown
    // length.
    if state.transferring.load(Ordering::Relaxed) {
        return Err(http::StatusCode::SERVICE_UNAVAILABLE);
    }

    // Asked of the device rather than taken from the URL: the total in
    // `Content-Range` is what the player seeks against.
    let total = {
        let guard = state.session.lock().await;
        let session = guard.as_ref().ok_or(http::StatusCode::NOT_FOUND)?;
        session
            .object_size(storage_id, handle)
            .await
            .map_err(|_| http::StatusCode::NOT_FOUND)?
    };

    let range = request
        .headers()
        .get(http::header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_range);

    // No `Range` header on a file that fits in one chunk is the only case that
    // answers 200: a short sound effect then arrives complete, and a player
    // that does not speak ranges can still play it.
    let (start, want, partial) = match range {
        Some((start, end)) => {
            if start >= total && total > 0 {
                return Err(http::StatusCode::RANGE_NOT_SATISFIABLE);
            }
            let end = end.unwrap_or(total.saturating_sub(1)).min(total.saturating_sub(1));
            (start, end.saturating_sub(start) + 1, true)
        }
        None if total <= MAX_CHUNK => (0, total, false),
        None => (0, total, true),
    };

    let want = want.min(MAX_CHUNK);
    let want32 = u32::try_from(want).map_err(|_| http::StatusCode::INTERNAL_SERVER_ERROR)?;

    let bytes = {
        let guard = state.session.lock().await;
        let session = guard.as_ref().ok_or(http::StatusCode::NOT_FOUND)?;
        session
            .read_range(storage_id, handle, start, want32)
            .await
            .map_err(|_| http::StatusCode::INTERNAL_SERVER_ERROR)?
    };

    // What the device actually returned, not what was asked for: a short read
    // is legal mid-file, and a `Content-Range` describing bytes that are not in
    // the body desynchronises the player.
    let sent = bytes.len() as u64;
    let mut builder = http::Response::builder()
        .header(http::header::CONTENT_TYPE, content_type(&ext))
        .header(http::header::ACCEPT_RANGES, "bytes")
        .header(http::header::CONTENT_LENGTH, sent.to_string())
        // The webview treats a custom scheme as a foreign origin; without this
        // the media element refuses the response it just received.
        .header("Access-Control-Allow-Origin", "*");

    builder = if partial && sent > 0 {
        builder.status(http::StatusCode::PARTIAL_CONTENT).header(
            http::header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, start + sent - 1, total),
        )
    } else {
        builder.status(http::StatusCode::OK)
    };

    builder.body(bytes).map_err(|_| http::StatusCode::INTERNAL_SERVER_ERROR)
}

/// `/<storage>-<handle>.<ext>` into its three parts.
///
/// The separator is `-` and not `/` on purpose: `convertFileSrc` percent-encodes
/// its argument, so a slash arrives as `%2F` and would have to be decoded back
/// before anything could be parsed. A separator the encoder leaves alone means
/// the path that arrives is the path that was built.
fn parse_path(path: &str) -> Option<(u64, u64, String)> {
    let path = path.trim_start_matches('/');
    let (stem, ext) = match path.rsplit_once('.') {
        Some((stem, ext)) => (stem, ext.to_ascii_lowercase()),
        None => (path, String::new()),
    };
    let (storage, handle) = stem.split_once('-')?;
    Some((token(storage).ok()?, token(handle).ok()?, ext))
}

/// `bytes=START-END`, `bytes=START-`. A multi-range request (`bytes=0-99,200-`)
/// is deliberately not supported: no media element sends one, and answering it
/// wrongly is worse than answering only the first range, which is what this
/// does by ignoring everything after the comma.
fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let spec = value.strip_prefix("bytes=")?;
    let spec = spec.split(',').next()?.trim();
    let (start, end) = spec.split_once('-')?;

    // A suffix range (`bytes=-500`, "the last 500 bytes") has an empty start.
    // Not supported for the same reason as multi-range, and returning `None`
    // makes it a plain read from zero rather than a wrong offset.
    if start.is_empty() {
        return None;
    }

    let start: u64 = start.trim().parse().ok()?;
    let end = if end.trim().is_empty() {
        None
    } else {
        Some(end.trim().parse().ok()?)
    };
    if end.is_some_and(|e| e < start) {
        return None;
    }
    Some((start, end))
}

/// Content type from the extension.
///
/// The player needs this to pick a decoder; served with the wrong type, a
/// perfectly good MP4 shows as an unplayable file. Only the formats the preview
/// offers are listed — anything else never reaches this scheme.
fn content_type(ext: &str) -> &'static str {
    match ext {
        "mp4" => "video/mp4",
        "m4v" => "video/x-m4v",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "3gp" => "video/3gpp",
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "oga" | "ogg" | "opus" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_carries_storage_handle_and_extension() {
        assert_eq!(parse_path("/1-65537.mp4"), Some((1, 65537, "mp4".to_string())));
        assert_eq!(
            parse_path("/18446744073709551615-2.M4B"),
            Some((u64::MAX, 2, "m4b".to_string())),
            "the extension is matched case-insensitively"
        );
    }

    #[test]
    fn a_malformed_url_is_refused_rather_than_coerced() {
        assert_eq!(parse_path("/nonsense"), None);
        assert_eq!(parse_path("/1.mp4"), None, "no handle");
        assert_eq!(parse_path("/-1-2.mp4"), None, "a negative id is not an id");
        assert_eq!(parse_path("/"), None);
    }

    #[test]
    fn ranges_are_read_in_both_the_bounded_and_open_forms() {
        assert_eq!(parse_range("bytes=0-"), Some((0, None)));
        assert_eq!(parse_range("bytes=100-199"), Some((100, Some(199))));
        assert_eq!(parse_range("bytes=100-199, 300-399"), Some((100, Some(199))));
    }

    /// Each of these would otherwise become a read from some other offset, and
    /// a player handed the wrong bytes reports a corrupt file.
    #[test]
    fn a_range_that_cannot_be_honoured_exactly_is_not_guessed_at() {
        assert_eq!(parse_range("bytes=-500"), None, "suffix range is not supported");
        assert_eq!(parse_range("bytes=200-100"), None, "end before start");
        assert_eq!(parse_range("items=0-10"), None, "not a byte range");
        assert_eq!(parse_range("bytes=abc-"), None);
        assert_eq!(parse_range(""), None);
    }

    /// A type the player does not recognise is the difference between a video
    /// that plays and one that reports itself broken.
    #[test]
    fn every_offered_format_has_a_real_content_type() {
        for ext in ["mp4", "m4v", "mov", "webm", "mp3", "m4a", "m4b", "aac", "wav", "flac", "ogg"] {
            let ct = content_type(ext);
            assert_ne!(ct, "application/octet-stream", "{ext} has no type");
            assert!(ct.starts_with("video/") || ct.starts_with("audio/"), "{ext} -> {ct}");
        }
    }
}
