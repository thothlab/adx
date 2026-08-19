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

/// How much a transfer needs against how much the storage has.
///
/// Carried as numbers rather than baked into `message`, for the same reason
/// `kind` exists: the sentence around them is the frontend's to write in the
/// user's language, and its byte formatter is the one already used everywhere
/// else in the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceNeed {
    pub required: u64,
    pub free: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdxError {
    pub kind: ErrorKind,
    pub message: String,
    /// Set only for [`ErrorKind::Occupied`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder: Option<ProcessRef>,
    /// Set only for [`ErrorKind::NotEnoughSpace`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space: Option<SpaceNeed>,
}

impl AdxError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), holder: None, space: None }
    }

    pub fn occupied(message: impl Into<String>, holder: Option<ProcessRef>) -> Self {
        Self { kind: ErrorKind::Occupied, message: message.into(), holder, space: None }
    }

    /// The transfer does not fit. Both figures travel so the user can see how
    /// far off it is — "not enough space" alone leaves them guessing whether to
    /// delete one video or a hundred.
    pub fn not_enough_space(required: u64, free: u64) -> Self {
        Self {
            kind: ErrorKind::NotEnoughSpace,
            message: format!("нужно {required} байт, свободно {free}"),
            holder: None,
            space: Some(SpaceNeed { required, free }),
        }
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
        )
    }

    /// True when the right recovery is to re-list the parent folder, re-resolve
    /// the handle and retry once — **not** to retry the same call.
    ///
    /// Deliberately not folded into [`is_transient`]: a stale handle survives
    /// any number of reopens, so a supervisor that retried it as "transient"
    /// would replay the same dead handle until it gave up. Two different
    /// recoveries must not share one predicate.
    pub fn needs_relist(&self) -> bool {
        matches!(self.kind, ErrorKind::StaleHandle)
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

    /// A stale handle needs a re-list, not a retry — the two recoveries must
    /// never both claim the same error, or the supervisor picks the wrong one.
    #[test]
    fn stale_handle_asks_for_a_relist_not_a_retry() {
        let stale = AdxError::new(ErrorKind::StaleHandle, "");
        assert!(stale.needs_relist());
        assert!(!stale.is_transient());

        let io = AdxError::new(ErrorKind::Io, "");
        assert!(io.is_transient());
        assert!(!io.needs_relist());
    }

    #[test]
    fn holder_is_omitted_when_absent() {
        let json = serde_json::to_string(&AdxError::new(ErrorKind::NoDevice, "нет устройств")).unwrap();
        assert!(!json.contains("holder"), "{json}");
        assert!(!json.contains("space"), "{json}");
        assert!(json.contains("\"no_device\""), "{json}");
    }

    /// Both figures reach the frontend as numbers. If they only lived in
    /// `message`, the sentence the user reads would be in whatever language the
    /// backend happened to be written in — and the criterion is that the user
    /// sees the required and the available amount, not that a log does.
    #[test]
    fn a_space_shortfall_carries_both_figures() {
        let json = serde_json::to_string(&AdxError::not_enough_space(4_000, 1_500)).unwrap();
        assert!(json.contains("\"required\":4000"), "{json}");
        assert!(json.contains("\"free\":1500"), "{json}");
        assert!(json.contains("\"not_enough_space\""), "{json}");
        assert!(!json.contains("holder"), "{json}");
    }
}
