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
    /// The device is busy with another operation from this app.
    Busy,
    NotFound,
    NotWritable,
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
        matches!(self.kind, ErrorKind::Io | ErrorKind::Busy | ErrorKind::Protocol)
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
