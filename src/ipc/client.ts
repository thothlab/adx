import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AdxError,
  ConflictPolicy,
  DeviceDto,
  DownloadRootDto,
  EntryDto,
  OpenedDeviceDto,
  StorageDto,
  TransferOutcome,
  TransferProgress,
} from "./types";

/**
 * The single place that names Tauri command strings. Everything else calls
 * these functions, so a renamed command is one edit and a type error rather
 * than a silent runtime failure at some call site nobody exercised.
 */
export const api = {
  devices: {
    list: () => invoke<DeviceDto[]>("devices_list"),
    open: (serial: string) => invoke<OpenedDeviceDto>("device_open", { serial }),
    close: () => invoke<void>("device_close"),
  },
  storages: {
    refresh: () => invoke<StorageDto[]>("storages_refresh"),
  },
  folders: {
    /** `parent = null` lists the root of the storage. */
    list: (storageId: string, parent: string | null) =>
      invoke<EntryDto[]>("folder_list", { storageId, parent }),
    create: (storageId: string, parent: string | null, name: string) =>
      invoke<string>("folder_create", { storageId, parent, name }),
  },
  entries: {
    remove: (storageId: string, handle: string) =>
      invoke<void>("entry_delete", { storageId, handle }),
    rename: (storageId: string, handle: string, name: string) =>
      invoke<void>("entry_rename", { storageId, handle, name }),
    /** First `maxBytes` of a file, raw. The command answers with a Tauri
     *  `Response`, which crosses the bridge as an `ArrayBuffer` rather than as
     *  a JSON array of numbers — six times the size and parsed as text. */
    read: (storageId: string, handle: string, maxBytes: number) =>
      invoke<ArrayBuffer>("entry_read", { storageId, handle, maxBytes }),
  },
  upload: {
    start: (storageId: string, parent: string | null, paths: string[], policy: ConflictPolicy) =>
      invoke<TransferOutcome>("upload_start", { storageId, parent, paths, policy }),
    cancel: () => invoke<void>("upload_cancel"),
  },
  download: {
    /** `roots` are the rows the user selected; `dest` is a folder on this
     *  computer. Folders bring their contents. */
    start: (
      storageId: string,
      roots: DownloadRootDto[],
      dest: string,
      policy: ConflictPolicy,
    ) => invoke<TransferOutcome>("download_start", { storageId, roots, dest, policy }),
    cancel: () => invoke<void>("download_cancel"),
  },
};

/**
 * URL a `<video>` or `<audio>` element can point at, served by the `adx://`
 * handler in `src-tauri/src/stream.rs` a byte range at a time.
 *
 * `convertFileSrc` rather than a hand-built string: the scheme's URL shape
 * differs per platform (`adx://localhost/...` against `http://adx.localhost/...`
 * on Windows) and this is the function that knows which.
 *
 * The extension is part of the path because the handler serves the
 * `Content-Type` from it, and a player handed the wrong type reports a good
 * file as broken. `-` separates the ids because `convertFileSrc`
 * percent-encodes its argument and leaves `-` alone.
 */
export function streamUrl(storageId: string, handle: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "bin";
  return convertFileSrc(`${storageId}-${handle}.${ext}`, "adx");
}

/** Event names, mirrored from `src-tauri`. */
export const events = {
  /** The attached devices changed — payload is the whole new list. */
  devicesChanged: "devices-changed",
  uploadProgress: "upload-progress",
  downloadProgress: "download-progress",
} as const;

export function onDevicesChanged(fn: (devices: DeviceDto[]) => void): Promise<UnlistenFn> {
  return listen<DeviceDto[]>(events.devicesChanged, (e) => fn(e.payload));
}

export function onUploadProgress(fn: (p: TransferProgress) => void): Promise<UnlistenFn> {
  return listen<TransferProgress>(events.uploadProgress, (e) => fn(e.payload));
}

export function onDownloadProgress(fn: (p: TransferProgress) => void): Promise<UnlistenFn> {
  return listen<TransferProgress>(events.downloadProgress, (e) => fn(e.payload));
}

/** Tauri rejects with whatever the command's error type serialised to. Ours is
 *  always an `AdxError`, but a panic or a plugin error can still surface as a
 *  bare string, so this narrows rather than casts. */
export function asAdxError(e: unknown): AdxError {
  if (typeof e === "object" && e !== null && "kind" in e && "message" in e) {
    return e as AdxError;
  }
  return { kind: "io", message: String(e) };
}
