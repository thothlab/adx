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
use mtp_rs::mtp::{MtpDevice, NewObjectInfo, ObjectHandle, Storage, WindowedDownload};

use crate::{map_error, MtpBackend, MtpRsBackend, SessionSlot};

/// Ask the open device for its storages, reopening the session if it cannot
/// answer or answers with nothing.
///
/// This is what "Спросить снова" and «Обновить» run, and the reopen is the half
/// that makes them worth pressing. Two situations reach here, and re-asking
/// over the existing session fixes only one of them:
///
/// - The device had nothing to show when the session opened — a locked screen,
///   or file transfer not yet confirmed on the phone — and has something now.
///   Re-asking is enough.
/// - The user changed the USB mode on the phone. That **re-enumerates the USB
///   device**: the configuration this session is bound to no longer exists, so
///   every request on it fails or returns nothing, while the device list still
///   shows the same serial and looks perfectly healthy. Nothing short of
///   opening again recovers it, and nothing emits an event to say so — which is
///   why the app could sit there insisting a plugged-in, file-transfer-mode
///   phone had no storage.
///
/// Reopening costs a session close and open (hundreds of milliseconds) and only
/// happens when the cheap path already failed, so the common case pays nothing.
pub async fn storages_or_reopen(slot: &SessionSlot) -> Result<Vec<StorageRef>, AdxError> {
    let mut guard = slot.lock().await;
    let session = guard
        .as_mut()
        .ok_or_else(|| AdxError::new(ErrorKind::NoDevice, "устройство не открыто"))?;
    let serial = session.serial().to_string();

    match session.refresh_storages().await {
        Ok(list) if !list.is_empty() => return Ok(list),
        Ok(_) => tracing::info!("{serial}: накопителей не показано, переоткрываем сессию"),
        Err(e) => tracing::warn!("{serial}: не удалось перечитать накопители ({e}), переоткрываем"),
    }

    // The old session is dropped before the new one is opened: the device
    // allows exactly one, and asking for a second while holding the first is
    // how "устройство занято" gets reported against ourselves.
    if let Some(previous) = guard.take() {
        if let Err(e) = previous.close().await {
            tracing::debug!("closing the stale session failed, continuing: {e}");
        }
    }

    let reopened = Session::open(&serial).await?;
    let storages = reopened.storages();
    *guard = Some(reopened);
    Ok(storages)
}

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

    /// Ask the device again which storages it has, and how much is free.
    ///
    /// The whole list, not just fresh numbers for the list we already hold.
    /// That distinction is the difference between a working "try again" and one
    /// that cannot possibly work: a phone whose screen is locked opens a session
    /// perfectly and reports **zero** storages, so the cached list is empty, and
    /// refreshing each of its zero entries in a loop returns empty forever.
    /// Unlocking the screen changes nothing on the USB bus, so no event arrives
    /// to correct it either — asking again is the only way back, and it has to
    /// be a real question.
    ///
    /// Also called after anything that writes: a storage panel still claiming
    /// the pre-transfer free space is the kind of stale number a user notices
    /// and stops trusting the whole app over. Re-reading the list covers that
    /// too, because each entry comes back with its current numbers.
    pub async fn refresh_storages(&mut self) -> Result<Vec<StorageRef>, AdxError> {
        self.storages = self.device.storages().await.map_err(|e| map_error(&e))?;
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

    /// Start reading an object as a sequence of bounded windows.
    ///
    /// `pub(crate)` on purpose: the returned type is `mtp-rs`'s, and the rule
    /// this crate exists to enforce is that no signature above it names a
    /// library type. The public way in is [`crate::download_tree`].
    ///
    /// The reader that comes back owns its own handle on the transport and
    /// borrows nothing from this session, which is what lets the caller drop
    /// the session lock between two windows — see the module docs of
    /// `download.rs` for why that is the whole point.
    pub(crate) async fn open_download(
        &self,
        storage_id: u64,
        handle: u64,
    ) -> Result<WindowedDownload, AdxError> {
        let storage = self.storage(storage_id)?;
        storage
            .download_windowed_default(ObjectHandle(handle))
            .await
            .map_err(|e| map_error(&e))
    }

    /// Size of one object, straight from the device.
    ///
    /// The listing already carries a size, so this exists for the one caller
    /// that must not trust it: the streaming protocol answers `Content-Range`
    /// with a total, and a player seeks against that number. A stale total from
    /// a listing read minutes ago makes the last seek land past the end of the
    /// file, which the player reports as a broken stream rather than as a stale
    /// number.
    pub async fn object_size(&self, storage_id: u64, handle: u64) -> Result<u64, AdxError> {
        let storage = self.storage(storage_id)?;
        storage
            .get_object_info(ObjectHandle(handle))
            .await
            .map(|info| info.size)
            .map_err(|e| map_error(&e))
    }

    /// Read a bounded slice of an object into memory.
    ///
    /// For previews and thumbnails, where the whole point is to read the first
    /// N bytes and stop. A whole-file read goes through [`crate::download_tree`]
    /// instead, which streams to disk and can be cancelled.
    pub async fn read_range(
        &self,
        storage_id: u64,
        handle: u64,
        offset: u64,
        len: u32,
    ) -> Result<Vec<u8>, AdxError> {
        let storage = self.storage(storage_id)?;
        storage
            .read_range(ObjectHandle(handle), offset, len)
            .await
            .map_err(|e| map_error(&e))
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

    /// With nothing open there is no serial to reopen *by*, so this has to stop
    /// rather than reach for a device. Everything past the guard needs real
    /// hardware and is exercised by hand — see the note in the module docs.
    #[tokio::test]
    async fn asking_with_no_open_device_is_not_an_attempt_to_reopen() {
        let slot: SessionSlot = tokio::sync::Mutex::new(None);
        let err = storages_or_reopen(&slot).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::NoDevice);
    }

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
