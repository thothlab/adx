/** Mirrors `DeviceDto` in `src-tauri/src/commands.rs`. */
export interface DeviceDto {
  serial: string;
  /** Hex string, not a number: a u64 does not survive a JSON round trip. */
  locationId: string;
  manufacturer: string;
  model: string;
  state: "ready" | "unauthorized";
}

/**
 * Mirrors `StorageDto`. Sizes are numbers (quantities, all far below 2^53),
 * `id` is a string (an opaque backend token whose full width matters).
 */
export interface StorageDto {
  id: string;
  description: string;
  totalCapacity: number;
  freeSpace: number;
  isWritable: boolean;
}

/** Mirrors `EntryDto`. */
export interface EntryDto {
  handle: string;
  name: string;
  size: number;
  isFolder: boolean;
  /** `YYYY-MM-DD HH:MM`, already formatted by the backend. */
  modified: string | null;
}

/** Mirrors `OpenedDeviceDto`. */
export interface OpenedDeviceDto {
  serial: string;
  model: string;
  canWrite: boolean;
  canRename: boolean;
  storages: StorageDto[];
}

/** What to do with names that already exist on the device. */
export type ConflictPolicy = "ask" | "replace" | "skip";

/**
 * Mirrors `UploadOutcome`. A tagged union on purpose: every branch of the
 * transfer ends in exactly one of these, so the UI clears its progress state on
 * `status` alone and can never be left waiting on a job that already finished.
 */
export type UploadOutcome =
  | { status: "conflicts"; names: string[] }
  | {
      status: "done";
      files: number;
      folders: number;
      replaced: number;
      skipped: number;
      bytes: number;
      warnings: string[];
    }
  | { status: "cancelled"; files: number; bytes: number; warnings: string[] };

/** Payload of the `upload-progress` event. */
export interface UploadProgress {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  name: string;
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
