//! Tauri commands — the contract the frontend calls.
//!
//! Commands stay thin: shape conversion and error mapping only. Anything with
//! logic belongs in `adx-core` or `adx-mtp`, where it can be tested without a
//! running app.
//!
//! # Numbers and tokens
//!
//! Sizes travel as JSON numbers; handles and storage ids travel as strings.
//! The split is not cosmetic. Sizes are quantities the UI does arithmetic on
//! and none of them approaches 2^53. Handles are opaque tokens whose full u64
//! width belongs to the backend (the Windows WPD backend derives its own), and
//! a token silently rounded by a JSON `f64` addresses the wrong object.

use adx_core::{AdxError, ErrorKind};
use adx_mtp::{MtpBackend, MtpRsBackend, Session, StorageRef};
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDto {
    pub id: String,
    pub description: String,
    pub total_capacity: u64,
    pub free_space: u64,
    pub is_writable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDto {
    pub handle: String,
    pub name: String,
    pub size: u64,
    pub is_folder: bool,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDeviceDto {
    pub serial: String,
    pub model: String,
    pub can_write: bool,
    pub can_rename: bool,
    pub storages: Vec<StorageDto>,
}

pub fn to_device_dto(d: adx_mtp::DiscoveredDevice) -> DeviceDto {
    DeviceDto {
        serial: d.serial,
        // `location_id` is a u64; JSON numbers are f64, which silently loses
        // precision above 2^53. Sent as a string so the round trip is exact.
        location_id: format!("{:016x}", d.location_id),
        manufacturer: d.manufacturer,
        model: d.model,
        state: if d.mtp_available { "ready" } else { "unauthorized" },
    }
}

pub fn to_storage_dto(s: StorageRef) -> StorageDto {
    StorageDto {
        id: s.id.to_string(),
        description: s.description,
        total_capacity: s.total_capacity,
        free_space: s.free_space,
        is_writable: s.is_writable,
    }
}

/// Parse a handle or storage id back from its string form.
pub fn token(value: &str) -> Result<u64, AdxError> {
    value
        .parse::<u64>()
        .map_err(|_| AdxError::new(ErrorKind::Protocol, format!("некорректный идентификатор {value}")))
}

fn no_device() -> AdxError {
    AdxError::new(ErrorKind::NoDevice, "устройство не открыто")
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
        .map_err(|e| AdxError::new(ErrorKind::Io, e.to_string()))??;

    Ok(devices.into_iter().map(to_device_dto).collect())
}

/// Open a device and keep the session for the rest of the visit.
///
/// Re-opening the device that is already open is a no-op that returns fresh
/// storage figures. That matters because the UI calls this whenever the
/// selection changes, including changes it caused itself, and tearing down a
/// working session to rebuild an identical one is a two-second stall and a
/// window in which a transfer would have failed.
#[tauri::command]
pub async fn device_open(
    state: State<'_, AppState>,
    serial: String,
) -> Result<OpenedDeviceDto, AdxError> {
    let mut guard = state.session.lock().await;

    let already_open = guard.as_ref().is_some_and(|s| s.serial() == serial);
    if !already_open {
        if let Some(previous) = guard.take() {
            // Closing the old session before opening the new one, and ignoring
            // the result: the user has already moved on, and a phone that was
            // unplugged mid-session cannot acknowledge a close.
            if let Err(e) = previous.close().await {
                tracing::debug!("closing the previous session failed, continuing: {e}");
            }
        }
        *guard = Some(Session::open(&serial).await?);
    }

    let session = guard.as_mut().ok_or_else(no_device)?;
    let storages = session.refresh_storages().await?;

    Ok(OpenedDeviceDto {
        serial: session.serial().to_string(),
        model: session.model(),
        can_write: session.can_write(),
        can_rename: session.can_rename(),
        storages: storages.into_iter().map(to_storage_dto).collect(),
    })
}

#[tauri::command]
pub async fn device_close(state: State<'_, AppState>) -> Result<(), AdxError> {
    if let Some(session) = state.session.lock().await.take() {
        session.close().await?;
    }
    Ok(())
}

/// Re-read free space. Called after anything that writes.
#[tauri::command]
pub async fn storages_refresh(state: State<'_, AppState>) -> Result<Vec<StorageDto>, AdxError> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or_else(no_device)?;
    Ok(session
        .refresh_storages()
        .await?
        .into_iter()
        .map(to_storage_dto)
        .collect())
}

/// List a folder. `parent = None` means the root of the storage.
#[tauri::command]
pub async fn folder_list(
    state: State<'_, AppState>,
    storage_id: String,
    parent: Option<String>,
) -> Result<Vec<EntryDto>, AdxError> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or_else(no_device)?;

    let parent = parent.as_deref().map(token).transpose()?;
    let entries = session.list(token(&storage_id)?, parent).await?;

    Ok(entries
        .into_iter()
        .map(|e| EntryDto {
            handle: e.handle.to_string(),
            name: e.name,
            size: e.size,
            is_folder: e.is_folder,
            modified: e.modified,
        })
        .collect())
}

#[tauri::command]
pub async fn folder_create(
    state: State<'_, AppState>,
    storage_id: String,
    parent: Option<String>,
    name: String,
) -> Result<String, AdxError> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or_else(no_device)?;

    let parent = parent.as_deref().map(token).transpose()?;
    let handle = session.create_folder(token(&storage_id)?, parent, &name).await?;
    Ok(handle.to_string())
}

/// Delete a file or a folder.
///
/// A folder goes with its contents: MTP's delete is recursive for an
/// association, which is what the requirement asks for. The confirmation is the
/// frontend's job — it has the names, and a native dialog here would block the
/// session mutex while it waited for a human.
#[tauri::command]
pub async fn entry_delete(
    state: State<'_, AppState>,
    storage_id: String,
    handle: String,
) -> Result<(), AdxError> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or_else(no_device)?;
    session.delete(token(&storage_id)?, token(&handle)?).await
}

#[tauri::command]
pub async fn entry_rename(
    state: State<'_, AppState>,
    storage_id: String,
    handle: String,
    name: String,
) -> Result<(), AdxError> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or_else(no_device)?;
    session.rename(token(&storage_id)?, token(&handle)?, &name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip_through_their_string_form() {
        let big = u64::MAX;
        assert_eq!(token(&big.to_string()).unwrap(), big);
        assert_eq!(token("65537").unwrap(), 0x1_0001);
    }

    /// A malformed token is a protocol error, not a panic and not a silent 0 —
    /// a zero handle is the storage root, so coercing would delete or list the
    /// wrong thing.
    #[test]
    fn a_malformed_token_is_rejected() {
        assert_eq!(token("").unwrap_err().kind, ErrorKind::Protocol);
        assert_eq!(token("0x10").unwrap_err().kind, ErrorKind::Protocol);
        assert_eq!(token("-1").unwrap_err().kind, ErrorKind::Protocol);
    }

    #[test]
    fn charging_only_devices_are_marked_unauthorized() {
        let d = adx_mtp::DiscoveredDevice {
            serial: "A".into(),
            location_id: 0x10,
            manufacturer: "vivo".into(),
            model: "V2036".into(),
            mtp_available: false,
        };
        assert_eq!(to_device_dto(d).state, "unauthorized");
    }
}
