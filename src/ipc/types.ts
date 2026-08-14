/** Mirrors `DeviceDto` in `src-tauri/src/commands.rs`. */
export interface DeviceDto {
  serial: string;
  /** Hex string, not a number: a u64 does not survive a JSON round trip. */
  locationId: string;
  manufacturer: string;
  model: string;
  state: "ready" | "unauthorized";
}

/** Mirrors `AdxError` in `crates/adx-core/src/error.rs`. The UI branches on
 *  `kind` and renders its own localised text; `message` is the technical
 *  detail shown on demand. */
export interface AdxError {
  kind:
    | "no_device"
    | "occupied"
    | "unauthorized"
    | "permission_denied"
    | "busy"
    | "disconnected"
    | "device_reset"
    | "stale_handle"
    | "timeout"
    | "not_found"
    | "not_writable"
    | "unsupported"
    | "name_too_long"
    | "name_invalid"
    | "name_taken"
    | "not_enough_space"
    | "cancelled"
    | "io"
    | "protocol";
  message: string;
  holder?: { pid: number; name: string };
}
