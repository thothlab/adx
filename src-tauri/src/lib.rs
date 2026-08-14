//! Tauri entry point: plugins, commands, app state.
//!
//! One rule holds for every background task added here from T02 onward:
//! spawn through `tauri::async_runtime::spawn`, never `tokio::spawn`. Tauri's
//! `setup()` runs on the main thread with no current-thread tokio runtime, so
//! `tokio::spawn` panics with "no reactor running"; across the extern "C" FFI
//! boundary that panic becomes `panic_cannot_unwind` and aborts the process.
//! On Pane it shipped as a launch crash on macOS in two consecutive releases
//! (commit 2df5e6c) because unit tests never launch the bundled app.

/// Health check for the IPC channel — proves the frontend can reach Rust
/// before any real command exists. Superseded by `devices_list` in T01.
#[tauri::command]
fn ping() -> &'static str {
    "adx"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "adx_app=info,adx_mtp=info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running ADX");
}
