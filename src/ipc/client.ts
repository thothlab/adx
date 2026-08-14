import { invoke } from "@tauri-apps/api/core";
import type { AdxError, DeviceDto } from "./types";

/**
 * The single place that names Tauri command strings. Everything else calls
 * these functions, so a renamed command is one edit and a type error rather
 * than a silent runtime failure at some call site nobody exercised.
 */
export const api = {
  devices: {
    list: () => invoke<DeviceDto[]>("devices_list"),
  },
};

/** Tauri rejects with whatever the command's error type serialised to. Ours is
 *  always an `AdxError`, but a panic or a plugin error can still surface as a
 *  bare string, so this narrows rather than casts. */
export function asAdxError(e: unknown): AdxError {
  if (typeof e === "object" && e !== null && "kind" in e && "message" in e) {
    return e as AdxError;
  }
  return { kind: "io", message: String(e) };
}
