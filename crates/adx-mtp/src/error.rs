use adx_core::{AdxError, ErrorKind};
use mtp_rs::Error as MtpError;

/// Translate a library error into the app's vocabulary.
///
/// Matched on variants, never on message text: `mtp_rs::Error` is an explicit
/// enum, and `Error::Other { detail }` documents that its contents are for
/// diagnostics only and must not be pattern-matched.
///
/// Three distinctions here carry real product weight:
///
/// * `ExclusiveAccess` vs `NoDevice` — on macOS a device grabbed by
///   `ptpcamerad` or by a running Android File Transfer is the everyday case,
///   and its remedy is nothing like "plug in a phone".
/// * `PermissionDenied` vs `ExclusiveAccess` — nothing holds the device, the
///   user simply lacks access (missing udev rules on Linux). The remedy is a
///   command, not closing an app.
/// * `DeviceReset` vs `Disconnected` — the device is still there and
///   reopenable, so the session supervisor should reopen rather than tell the
///   user the device is gone.
pub fn map_error(err: &MtpError) -> AdxError {
    let message = err.to_string();

    let kind = match err {
        // Holder deliberately left empty here. Naming the process needs the
        // device's serial to pick the right node out of the IORegistry — the
        // tree lists an owner for every hub on the machine — and this function
        // is a pure translation with no idea which device it is talking about.
        // `Session::open` fills it in, where the identity is known.
        MtpError::ExclusiveAccess => return AdxError::occupied(message, None),
        MtpError::PermissionDenied => ErrorKind::PermissionDenied,
        MtpError::NoDevice => ErrorKind::NoDevice,
        MtpError::NotFound => ErrorKind::NotFound,
        MtpError::StaleHandle => ErrorKind::StaleHandle,
        MtpError::AccessDenied => ErrorKind::NotWritable,
        MtpError::Unsupported => ErrorKind::Unsupported,
        MtpError::Busy => ErrorKind::Busy,
        MtpError::StorageFull => ErrorKind::NotEnoughSpace,
        MtpError::Cancelled => ErrorKind::Cancelled,
        MtpError::Disconnected => ErrorKind::Disconnected,
        MtpError::DeviceReset => ErrorKind::DeviceReset,
        MtpError::Timeout => ErrorKind::Timeout,
        MtpError::InvalidData { .. } => ErrorKind::Protocol,
        MtpError::Io { .. } => ErrorKind::Io,
        MtpError::Other { .. } => ErrorKind::Protocol,
        // `mtp_rs::Error` is `#[non_exhaustive]`: a library upgrade can add a
        // variant. Falling back to `Protocol` keeps that from being a build
        // break, and the message still reaches the user verbatim — a new
        // variant degrades to a generic-but-honest error, never to a silent
        // success.
        _ => ErrorKind::Protocol,
    };

    AdxError::new(kind, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_device_is_not_an_io_error() {
        // The path a user hits by unplugging mid-session. Classifying it as I/O
        // would send the reconnect supervisor chasing a device that is gone.
        assert_eq!(map_error(&MtpError::NoDevice).kind, ErrorKind::NoDevice);
    }

    #[test]
    fn exclusive_access_is_not_permission_denied() {
        // Same-looking failure, opposite remedies: close the other app vs fix
        // device permissions. Collapsing them would send macOS users to udev
        // instructions and Linux users hunting a process that isn't there.
        assert_eq!(map_error(&MtpError::ExclusiveAccess).kind, ErrorKind::Occupied);
        assert_eq!(
            map_error(&MtpError::PermissionDenied).kind,
            ErrorKind::PermissionDenied,
        );
    }

    #[test]
    fn a_software_reset_is_recoverable_but_a_disconnect_is_not() {
        assert!(map_error(&MtpError::DeviceReset).is_transient());
        assert!(!map_error(&MtpError::Disconnected).is_transient());
    }

    #[test]
    fn write_refusals_do_not_look_retryable() {
        for e in [MtpError::AccessDenied, MtpError::StorageFull, MtpError::Unsupported] {
            assert!(!map_error(&e).is_transient(), "{e:?}");
        }
    }
}
