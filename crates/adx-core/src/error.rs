use serde::Serialize;

/// What went wrong, in terms the UI can branch on. The frontend never parses
/// message text — it switches on `kind` and renders its own localised string,
/// keeping `message` as the expandable technical detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// No MTP device is attached at all.
    NoDevice,
    /// The device is attached but another process holds it exclusively. On
    /// macOS this is the normal case, not an edge case: `ptpcamerad` and
    /// Android File Transfer both grab devices on connect.
    Occupied,
    /// The device is attached without an MTP interface — charging-only mode.
    /// Distinct from `NoDevice` because the remedy is different: the user
    /// picks file-transfer mode on the phone.
    Unauthorized,
    /// Nothing else holds the device — this user lacks permission to open it.
    /// On Linux that means missing udev rules, and the remedy is a command the
    /// UI can print, so it must not be folded into [`ErrorKind::Occupied`].
    PermissionDenied,
    /// The device is temporarily busy; retrying may succeed.
    Busy,
    /// The device vanished mid-session.
    Disconnected,
    /// The library reset the device in software to recover from a wedged
    /// cancel. The device is still physically present and reopenable — no
    /// replug needed, which is what separates this from `Disconnected`.
    DeviceReset,
    /// A cached object handle went stale because the device re-keyed it
    /// (Android does this after a media rescan). The fix is to re-list the
    /// parent and retry once, not to tell the user the file is gone.
    StaleHandle,
    Timeout,
    NotFound,
    NotWritable,
    Unsupported,
    NameTooLong,
    NameInvalid,
    NameTaken,
    NotEnoughSpace,
    Cancelled,
    Io,
    Protocol,
}

/// The process holding a device, when the OS will name it. Populated on macOS
/// from the IORegistry `UsbExclusiveOwner` key; `None` elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProcessRef {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdxError {
    pub kind: ErrorKind,
    pub message: String,
    /// Set only for [`ErrorKind::Occupied`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder: Option<ProcessRef>,
}

impl AdxError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), holder: None }
    }

    pub fn occupied(message: impl Into<String>, holder: Option<ProcessRef>) -> Self {
        Self { kind: ErrorKind::Occupied, message: message.into(), holder }
    }

    /// True when the operation could succeed on a later attempt without the
    /// user changing anything — the reconnect supervisor retries these and
    /// nothing else.
    pub fn is_transient(&self) -> bool {
        matches!(
            self.kind,
            ErrorKind::Io
                | ErrorKind::Busy
                | ErrorKind::Timeout
                | ErrorKind::Protocol
                | ErrorKind::DeviceReset
                | ErrorKind::StaleHandle
        )
    }
}

impl std::fmt::Display for AdxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AdxError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_recoverable_kinds_are_transient() {
        assert!(AdxError::new(ErrorKind::Io, "").is_transient());
        assert!(!AdxError::new(ErrorKind::NotWritable, "").is_transient());
        assert!(!AdxError::occupied("", None).is_transient());
    }

    #[test]
    fn holder_is_omitted_when_absent() {
        let json = serde_json::to_string(&AdxError::new(ErrorKind::NoDevice, "нет устройств")).unwrap();
        assert!(!json.contains("holder"), "{json}");
        assert!(json.contains("\"no_device\""), "{json}");
    }
}
