import { createSignal } from "solid-js";
import { api, asAdxError, onUploadProgress } from "@/ipc/client";
import type { AdxError, ConflictPolicy, UploadOutcome, UploadProgress } from "@/ipc/types";
import { currentFolder, reloadAll, storageId } from "@/stores/browser";

/**
 * Upload state.
 *
 * Mirrors the backend's rule that a transfer ends in exactly one terminal
 * outcome: every path through `upload()` either sets `summary`, sets
 * `uploadError`, or parks a conflict question — and clears `running` and
 * `progress` in all of them. A branch that returned without doing so would
 * leave the progress row pinned forever, which is the exact bug this shape is
 * built to make impossible.
 */

const [running, setRunning] = createSignal(false);
const [progress, setProgress] = createSignal<UploadProgress | null>(null);
const [summary, setSummary] = createSignal<UploadOutcome | null>(null);
const [uploadError, setUploadError] = createSignal<AdxError | null>(null);

/** A question waiting for the user: these names already exist on the device. */
const [conflicts, setConflicts] = createSignal<{ paths: string[]; names: string[] } | null>(null);

export { conflicts, progress, running, summary, uploadError };

export function dismissSummary(): void {
  setSummary(null);
  setUploadError(null);
}

/**
 * Send local paths (files or folders) into the folder currently open.
 *
 * With `policy: "ask"` the backend writes nothing when it finds existing
 * names — it reports them and returns. So the confirmation the user sees is
 * asked before the device has been touched, not halfway through a copy.
 */
export async function upload(paths: string[], policy: ConflictPolicy = "ask"): Promise<void> {
  const id = storageId();
  if (!id || paths.length === 0) return;

  setRunning(true);
  setSummary(null);
  setUploadError(null);
  setProgress({ done: 0, total: paths.length, bytesDone: 0, bytesTotal: 0, name: "" });

  try {
    const outcome = await api.upload.start(id, currentFolder(), paths, policy);
    if (outcome.status === "conflicts") {
      setConflicts({ paths, names: outcome.names });
    } else {
      setSummary(outcome);
      await reloadAll();
    }
  } catch (e) {
    setUploadError(asAdxError(e));
    // Something may still have landed before the failure, so the listing is
    // re-read either way: showing a folder that does not match the device is
    // worse than showing an error.
    await reloadAll();
  } finally {
    setRunning(false);
    setProgress(null);
  }
}

/** Answer the conflict question and run the transfer for real. */
export async function resolveConflicts(policy: Exclude<ConflictPolicy, "ask">): Promise<void> {
  const pending = conflicts();
  setConflicts(null);
  if (pending) await upload(pending.paths, policy);
}

export function cancelConflicts(): void {
  setConflicts(null);
}

export async function cancelUpload(): Promise<void> {
  try {
    await api.upload.cancel();
  } catch (e) {
    setUploadError(asAdxError(e));
  }
}

/** Subscribe to progress events. Returns the unlisten function. */
export function watchUploads(): Promise<() => void> {
  return onUploadProgress(setProgress);
}
