//! An open device session: the thing that stays alive for the whole visit.
//!
//! MTP allows exactly one session per device, and opening one is expensive
//! (hundreds of milliseconds on the phone this was measured against). So ADX
//! opens once, when the user picks a device, and keeps the handle until they
//! pick another or unplug — rather than opening per click, which is how a file
//! manager ends up "losing the connection" between two clicks.
//!
//! Serialisation is the caller's job and is not optional: the protocol has one
//! transaction in flight at a time. `src-tauri` holds the session behind a
//! mutex, which makes every operation on a device a queue of one — the FIFO the
//! design calls for, before it grows a UI.

use std::ops::ControlFlow;
use std::path::Path;

use adx_core::{AdxError, ErrorKind};
use mtp_rs::mtp::{MtpDevice, NewObjectInfo, ObjectHandle, Storage};

use crate::{map_error, MtpBackend, MtpRsBackend};

/// A storage volume on the device — internal memory, an SD card.
///
/// Phones routinely have two, and they are not interchangeable: one may be
/// full, one may be read-only, and a file put in the wrong one is a file the
/// user cannot find. So storages are a visible choice, never an implicit one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageRef {
    pub id: u64,
    pub description: String,
    pub total_capacity: u64,
    pub free_space: u64,
    pub is_writable: bool,
}

/// One row of a folder listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub handle: u64,
    pub name: String,
    pub size: u64,
    pub is_folder: bool,
    /// `YYYY-MM-DD HH:MM`, or `None` when the device reports no timestamp.
    /// Formatted here because MTP's date is a plain field struct with no time
    /// zone, and pretending it is an instant by shipping it as epoch millis
    /// would invite the frontend to shift it into a different day.
    pub modified: Option<String>,
}

/// What an upload left behind when it failed.
#[derive(Debug, Clone)]
pub struct UploadFailure {
    pub error: AdxError,
    /// The half-written object the device may still hold. `mtp-rs` does not
    /// delete it, so a caller that ignores this leaves zero-length junk on the
    /// phone after every failed transfer.
    pub partial: Option<u64>,
}

pub struct Session {
    /// The device's USB serial — the key the UI knows it by.
    serial: String,
    device: MtpDevice,
    storages: Vec<Storage>,
}

impl Session {
    /// Open the attached device with this serial.
    ///
    /// Resolves the serial through the same enumeration the list came from and
    /// opens by location. Opening by serial would look simpler and be wrong:
    /// the USB descriptor serial the list shows and the MTP `DeviceInfo` serial
    /// are different strings on real hardware (measured: `155521910300A30` vs
    /// `4C9682CC…` on a vivo Y31), so the two identities must not be crossed.
    pub async fn open(serial: &str) -> Result<Self, AdxError> {
        let devices = MtpRsBackend.list_devices()?;
        let Some(device) = devices.iter().find(|d| d.serial == serial) else {
            return Err(AdxError::new(
                ErrorKind::NoDevice,
                format!("устройство {serial} больше не подключено"),
            ));
        };
        if !device.mtp_available {
            return Err(AdxError::new(
                ErrorKind::Unauthorized,
                "на устройстве не выбран режим передачи файлов",
            ));
        }

        let opened = match MtpDevice::open_by_location(device.location_id).await {
            Ok(opened) => opened,
            Err(e) => {
                let mut err = map_error(&e);
                // Naming the process is the difference between "устройство
                // занято" — which the user can do nothing with — and "закройте
                // Android File Transfer". Looked up only on this failure, and
                // only for this device: the IORegistry lists an owner for every
                // hub on the machine too.
                if err.kind == ErrorKind::Occupied {
                    err.holder = crate::exclusive_owner(serial);
                }
                return Err(err);
            }
        };
        let storages = opened.storages().await.map_err(|e| map_error(&e))?;
        tracing::info!(
            "session open: {} {} ({} storage(s))",
            opened.device_info().manufacturer,
            opened.device_info().model,
            storages.len()
        );

        Ok(Self { serial: serial.to_string(), device: opened, storages })
    }

    pub fn serial(&self) -> &str {
        &self.serial
    }

    pub fn model(&self) -> String {
        let info = self.device.device_info();
        format!("{} {}", info.manufacturer, info.model).trim().to_string()
    }

    pub fn can_write(&self) -> bool {
        self.device.supports_upload()
    }

    pub fn can_rename(&self) -> bool {
        self.device.supports_rename()
    }

    pub fn storages(&self) -> Vec<StorageRef> {
        self.storages.iter().map(|s| storage_ref(s)).collect()
    }

    /// Re-read free space from the device.
    ///
    /// Called after anything that writes: a storage panel still claiming the
    /// pre-transfer free space is the kind of stale number a user notices and
    /// stops trusting the whole app over.
    pub async fn refresh_storages(&mut self) -> Result<Vec<StorageRef>, AdxError> {
        for storage in &mut self.storages {
            storage.refresh().await.map_err(|e| map_error(&e))?;
        }
        Ok(self.storages())
    }

    /// List a folder. `parent == None` is the root of the storage.
    pub async fn list(&self, storage_id: u64, parent: Option<u64>) -> Result<Vec<Entry>, AdxError> {
        let storage = self.storage(storage_id)?;
        let collection = storage
            .collect_objects(parent.map(ObjectHandle))
            .await
            .map_err(|e| map_error(&e))?;

        if !collection.skipped.is_empty() {
            // Logged, not hidden and not fatal: the folder's membership is
            // known, one entry's metadata was not readable. Turning this into
            // an error would blank a folder of 500 files over one of them.
            tracing::warn!(
                "storage {storage_id:#x}: {} object(s) unreadable in this folder",
                collection.skipped.len()
            );
        }

        let mut entries: Vec<Entry> = collection
            .objects
            .into_iter()
            .map(|o| Entry {
                handle: o.handle.0,
                is_folder: o.is_folder(),
                name: o.filename,
                size: o.size,
                modified: o.modified.map(|d| {
                    format!(
                        "{:04}-{:02}-{:02} {:02}:{:02}",
                        d.year, d.month, d.day, d.hour, d.minute
                    )
                }),
            })
            .collect();

        sort_entries(&mut entries);
        Ok(entries)
    }

    pub async fn create_folder(
        &self,
        storage_id: u64,
        parent: Option<u64>,
        name: &str,
    ) -> Result<u64, AdxError> {
        validate_name(name)?;
        let storage = self.storage(storage_id)?;
        storage
            .create_folder(parent.map(ObjectHandle), name)
            .await
            .map(|h| h.0)
            .map_err(|e| map_error(&e))
    }

    pub async fn delete(&self, storage_id: u64, handle: u64) -> Result<(), AdxError> {
        let storage = self.storage(storage_id)?;
        storage.delete(ObjectHandle(handle)).await.map_err(|e| map_error(&e))
    }

    pub async fn rename(&self, storage_id: u64, handle: u64, name: &str) -> Result<(), AdxError> {
        validate_name(name)?;
        if !self.can_rename() {
            return Err(AdxError::new(
                ErrorKind::Unsupported,
                "устройство не поддерживает переименование",
            ));
        }
        let storage = self.storage(storage_id)?;
        storage
            .rename(ObjectHandle(handle), name)
            .await
            .map_err(|e| map_error(&e))
    }

    /// Send one file, streaming it from disk.
    ///
    /// `on_progress` receives bytes written so far and returns `false` to
    /// cancel. The file is re-stat'ed here rather than trusting the size the
    /// plan recorded: MTP commits to a length before the data phase, and a file
    /// that grew since the walk would overrun that commitment and desynchronise
    /// the session — which looks to the user like the device dropping out.
    pub async fn upload_file<F>(
        &self,
        storage_id: u64,
        parent: Option<u64>,
        local: &Path,
        name: &str,
        mut on_progress: F,
    ) -> Result<u64, UploadFailure>
    where
        F: FnMut(u64) -> bool + Send,
    {
        let fail = |e: AdxError| UploadFailure { error: e, partial: None };

        validate_name(name).map_err(fail)?;
        let storage = self.storage(storage_id).map_err(fail)?;

        let file = tokio::fs::File::open(local)
            .await
            .map_err(|e| fail(AdxError::new(ErrorKind::Io, format!("{}: {e}", local.display()))))?;
        let size = file
            .metadata()
            .await
            .map_err(|e| fail(AdxError::new(ErrorKind::Io, format!("{}: {e}", local.display()))))?
            .len();

        let stream = tokio_util::io::ReaderStream::new(file);
        let info = NewObjectInfo::file(name, size);

        storage
            .upload_with_progress(parent.map(ObjectHandle), info, stream, |p| {
                if on_progress(p.bytes_transferred) {
                    ControlFlow::Continue(())
                } else {
                    ControlFlow::Break(())
                }
            })
            .await
            .map(|h| h.0)
            .map_err(|e| UploadFailure {
                error: map_error(&e.source),
                partial: e.partial.map(|h| h.0),
            })
    }

    /// Close the session cleanly. Worth awaiting rather than dropping: an
    /// abandoned session leaves the device believing it is still in one, and
    /// the next open then fails until the phone times it out.
    pub async fn close(self) -> Result<(), AdxError> {
        self.device.close().await.map_err(|e| map_error(&e))
    }

    fn storage(&self, id: u64) -> Result<&Storage, AdxError> {
        self.storages
            .iter()
            .find(|s| s.id().0 == id)
            .ok_or_else(|| {
                AdxError::new(ErrorKind::NotFound, format!("накопитель {id:#x} не найден"))
            })
    }
}

fn storage_ref(s: &Storage) -> StorageRef {
    let info = s.info();
    StorageRef {
        id: s.id().0,
        description: info.description.clone(),
        total_capacity: info.total_capacity,
        free_space: info.free_space,
        is_writable: info.is_writable,
    }
}

/// Folders first, then by name, case-insensitively.
///
/// Devices return handles in creation order — the measured root listing came
/// back with folders and files interleaved and no ordering at all. Sorting on
/// this side rather than in the UI keeps every consumer (listing, tree,
/// recursive walk) agreeing on what "first" means.
fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        b.is_folder
            .cmp(&a.is_folder)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// Reject a name the device cannot store, before asking it to.
fn validate_name(name: &str) -> Result<(), AdxError> {
    if name.trim().is_empty() {
        return Err(AdxError::new(ErrorKind::NameInvalid, "имя не может быть пустым"));
    }
    if name.chars().count() > 254 {
        return Err(AdxError::new(ErrorKind::NameTooLong, "имя длиннее 254 символов"));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(AdxError::new(
            ErrorKind::NameInvalid,
            "имя не может содержать / \\ или нулевой байт",
        ));
    }
    if name == "." || name == ".." {
        return Err(AdxError::new(ErrorKind::NameInvalid, "недопустимое имя"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, is_folder: bool) -> Entry {
        Entry { handle: 1, name: name.into(), size: 0, is_folder, modified: None }
    }

    #[test]
    fn folders_come_first_then_names_case_insensitively() {
        let mut e = vec![
            entry("beta.txt", false),
            entry("Zeta", true),
            entry("Alpha.txt", false),
            entry("apps", true),
        ];
        sort_entries(&mut e);
        let names: Vec<&str> = e.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["apps", "Zeta", "Alpha.txt", "beta.txt"]);
    }

    /// Two names differing only in case must still have a stable order, or the
    /// listing reshuffles between two identical reads.
    #[test]
    fn case_only_differences_still_order_deterministically() {
        let mut a = vec![entry("File", false), entry("file", false)];
        let mut b = vec![entry("file", false), entry("File", false)];
        sort_entries(&mut a);
        sort_entries(&mut b);
        assert_eq!(a, b);
    }

    #[test]
    fn names_are_checked_before_the_device_sees_them() {
        assert!(validate_name("photo.jpg").is_ok());
        assert_eq!(validate_name("").unwrap_err().kind, ErrorKind::NameInvalid);
        assert_eq!(validate_name("   ").unwrap_err().kind, ErrorKind::NameInvalid);
        assert_eq!(validate_name("a/b").unwrap_err().kind, ErrorKind::NameInvalid);
        assert_eq!(validate_name("..").unwrap_err().kind, ErrorKind::NameInvalid);
        assert_eq!(
            validate_name(&"x".repeat(255)).unwrap_err().kind,
            ErrorKind::NameTooLong
        );
    }

    /// 254 *characters*, not bytes: a Cyrillic name is two bytes per character
    /// and a byte-length check would reject names the device accepts.
    #[test]
    fn the_length_limit_counts_characters_not_bytes() {
        assert!(validate_name(&"я".repeat(254)).is_ok());
        assert!(validate_name(&"я".repeat(255)).is_err());
    }
}
