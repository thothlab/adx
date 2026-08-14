use serde::Serialize;

use crate::error::ProcessRef;

/// Lifecycle of one device, as the UI sees it. Transitions are exercised in
/// T02; T00 only fixes the vocabulary so the frontend and the backend agree on
/// it from the first commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DeviceState {
    /// Visible in the list, not opened yet.
    Discovered,
    Connecting,
    Ready,
    /// Another process holds the device exclusively.
    Occupied { holder: Option<ProcessRef> },
    /// Attached over USB with no MTP interface — charging-only mode.
    Unauthorized,
    Reconnecting { attempt: u8 },
    Disconnected,
    Failed { message: String },
}

impl DeviceState {
    /// Whether device operations may be issued in this state. Everything the
    /// UI disables hangs off this one answer.
    pub fn is_usable(&self) -> bool {
        matches!(self, DeviceState::Ready)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

/// A transfer job ends in exactly one terminal state, on every branch —
/// including early exits from validation and a user dismissing a conflict
/// dialog. A branch that returns without one leaves the device queue parked on
/// that item and its progress bar spinning forever; see the itrack-tsd entry
/// cited in the PRD's Risks table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TransferState {
    Queued,
    Running,
    /// Device connection dropped mid-transfer; the supervisor is reconnecting.
    Paused,
    Cancelled,
    Done,
    Failed { message: String },
}

impl TransferState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TransferState::Cancelled | TransferState::Done | TransferState::Failed { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ready_is_usable() {
        assert!(DeviceState::Ready.is_usable());
        for s in [
            DeviceState::Discovered,
            DeviceState::Connecting,
            DeviceState::Occupied { holder: None },
            DeviceState::Unauthorized,
            DeviceState::Reconnecting { attempt: 1 },
            DeviceState::Disconnected,
            DeviceState::Failed { message: String::new() },
        ] {
            assert!(!s.is_usable(), "{s:?}");
        }
    }

    #[test]
    fn running_and_paused_are_not_terminal() {
        assert!(!TransferState::Queued.is_terminal());
        assert!(!TransferState::Running.is_terminal());
        assert!(!TransferState::Paused.is_terminal());
        assert!(TransferState::Done.is_terminal());
        assert!(TransferState::Cancelled.is_terminal());
        assert!(TransferState::Failed { message: String::new() }.is_terminal());
    }
}
