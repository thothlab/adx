//! Tauri entry point: plugins, commands, app state.
//!
//! One rule holds for every background task added here from T02 onward:
//! spawn through `tauri::async_runtime::spawn`, never `tokio::spawn`. Tauri's
//! `setup()` runs on the main thread with no current-thread tokio runtime, so
//! `tokio::spawn` panics with "no reactor running"; across the extern "C" FFI
//! boundary that panic becomes `panic_cannot_unwind` and aborts the process.
//! On Pane it shipped as a launch crash on macOS in two consecutive releases
//! (commit 2df5e6c) because unit tests never launch the bundled app.

mod commands;
mod state;
mod stream;
mod transfer;

use tauri::{Emitter, Manager, RunEvent};

/// Emitted whenever the attached devices change. The frontend replaces its
/// list wholesale from the payload rather than re-asking, so a plug event costs
/// one enumeration, not two.
pub const DEVICES_EVENT: &str = "devices-changed";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "adx_app=info,adx_mtp=info".into()),
        )
        .init();

    tauri::Builder::default()
        // Media is served, not loaded: a `<video>` or `<audio>` element asks
        // this scheme for the byte ranges it wants. See `stream.rs` for why a
        // blob cannot do the job on files this size.
        .register_asynchronous_uri_scheme_protocol(stream::SCHEME, stream::handle)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                adx_mtp::watch_devices(move |devices| {
                    let dtos: Vec<_> = devices.into_iter().map(commands::to_device_dto).collect();
                    if let Err(e) = handle.emit(DEVICES_EVENT, dtos) {
                        tracing::warn!("could not deliver the device list to the window: {e}");
                    }
                })
                .await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::devices_list,
            commands::device_open,
            commands::device_close,
            commands::storages_refresh,
            commands::folder_list,
            commands::folder_create,
            commands::entry_delete,
            commands::entry_rename,
            commands::entry_read,
            transfer::upload_start,
            transfer::upload_cancel,
            transfer::download_start,
            transfer::download_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ADX")
        .run(|app, event| {
            // Closing the session on the way out, not just dropping it. A
            // dropped session leaves the phone believing it is still in one,
            // and the next open then fails until the device times it out —
            // which the user experiences as "it worked yesterday". Blocking
            // here is correct: the process is leaving anyway, and the whole
            // point is that the goodbye reaches the device first.
            if matches!(event, RunEvent::Exit) {
                let state = app.state::<state::AppState>();
                tauri::async_runtime::block_on(async {
                    if let Some(session) = state.session.lock().await.take() {
                        match session.close().await {
                            Ok(()) => tracing::info!("session closed on exit"),
                            Err(e) => tracing::warn!("closing the session on exit failed: {e}"),
                        }
                    }
                });
            }
        });
}
