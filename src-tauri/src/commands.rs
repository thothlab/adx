//! Tauri commands — the contract the frontend calls.
//!
//! Commands stay thin: shape conversion and error mapping only. Anything with
//! logic belongs in `adx-core` or `adx-mtp`, where it can be tested without a
//! running app.

use adx_core::AdxError;
use adx_mtp::{MtpBackend, MtpRsBackend};
use serde::Serialize;

/// One row of the device list, as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDto {
    pub serial: String,
    pub location_id: String,
    pub manufacturer: String,
    pub model: String,
    /// `"ready"` or `"unauthorized"` — the charging-only case. The frontend
    /// branches on this to pick between "open" and "pick file transfer mode on
    /// the phone", so it must never be inferred from an empty field.
    pub state: &'static str,
}

/// Enumerate attached devices.
///
/// An empty list is a normal, successful answer — nothing plugged in is not an
/// error. Only a real enumeration failure comes back as `Err`, so the UI's
/// error banner stays meaningful.
#[tauri::command]
pub async fn devices_list() -> Result<Vec<DeviceDto>, AdxError> {
    // Enumeration is a blocking syscall. On a Tauri command it runs off the
    // main thread already, but keeping it in `spawn_blocking` means a slow USB
    // stack can never stall the async runtime the transfers will share.
    let devices = tokio::task::spawn_blocking(|| MtpRsBackend.list_devices())
        .await
        .map_err(|e| AdxError::new(adx_core::ErrorKind::Io, e.to_string()))??;

    Ok(devices
        .into_iter()
        .map(|d| DeviceDto {
            serial: d.serial,
            // `location_id` is a u64; JSON numbers are f64, which silently
            // loses precision above 2^53. Sent as a string so the round trip
            // is exact.
            location_id: format!("{:016x}", d.location_id),
            manufacturer: d.manufacturer,
            model: d.model,
            state: if d.mtp_available { "ready" } else { "unauthorized" },
        })
        .collect())
}
