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

/**
 * Mirrors `DragDoneDto` — how a copy started by a drop into Finder ended.
 *
 * A separate event rather than the command's answer: the command returns as
 * soon as the system takes the drag session, which is minutes before the user
 * lets go of the mouse.
 */
export type DragDone =
  { status: "done"; outcome: TransferOutcome } | { status: "failed"; error: AdxError };

/** What to do with names that already exist in the target folder — on the
 *  device when uploading, on this computer when downloading. */
export type ConflictPolicy = "ask" | "replace" | "skip";

/**
 * Mirrors `UploadOutcomeDto` and `DownloadOutcomeDto`, which are the same three
 * cases on both sides. A tagged union on purpose: every branch of a transfer
 * ends in exactly one of these, so the UI clears its progress state on `status`
 * alone and can never be left waiting on a job that already finished.
 */
export type TransferOutcome =
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

/** Payload of the `upload-progress` and `download-progress` events. */
export interface TransferProgress {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  name: string;
}

/** Mirrors `DownloadRootDto` — one row the user picked in the listing. Sent
 *  whole rather than as a handle, so the backend does not have to re-read the
 *  folder to learn whether it is a folder and how big it is. */
export interface DownloadRootDto {
  handle: string;
  name: string;
  isFolder: boolean;
  size: number;
}

/** Mirrors `UpdateCheck` in `src-tauri/src/update.rs`. */
export interface UpdateCheck {
  /** The running version. */
  current: string;
  /** Newest published release, without the leading `v`. */
  latest: string;
  /** Page to send the user to. */
  url: string;
  /** True only when `latest` is genuinely newer — a development build ahead of
   *  the last release reports `false`, not an update backwards. */
  outdated: boolean;
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
  /** Only on `occupied`. */
  holder?: { pid: number; name: string };
  /** Only on `not_enough_space`. Bytes, so the sentence around them is written
   *  here in the user's language rather than in the backend's. */
  space?: { required: number; free: number };
}
