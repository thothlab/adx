import { createSignal } from "solid-js";
import { api, asAdxError, onDownloadProgress, onDragDone } from "@/ipc/client";
import type {
  AdxError,
  ConflictPolicy,
  DownloadRootDto,
  TransferOutcome,
  TransferProgress,
} from "@/ipc/types";
import { storageId } from "@/stores/browser";
import { running as uploading } from "@/stores/transfer";

/**
 * Download state — the mirror of `stores/transfer.ts`, deliberately a separate
 * file rather than a shared bidirectional job store.
 *
 * The upload store states an invariant it has been verified against on real
 * hardware: every path through `upload()` ends in exactly one terminal state,
 * and clears `running` and `progress` in all of them. Folding a second
 * direction into it would put that at risk to save a few lines. So the shape is
 * copied and the invariant is restated: every path through `download()` sets
 * `summary`, sets `downloadError`, or parks a conflict question — and clears
 * `running` and `progress` either way.
 */

const [running, setRunning] = createSignal(false);
const [progress, setProgress] = createSignal<TransferProgress | null>(null);
const [summary, setSummary] = createSignal<TransferOutcome | null>(null);
const [downloadError, setDownloadError] = createSignal<AdxError | null>(null);

/** A question waiting for the user: these names already exist in the folder
 *  they picked on this computer. */
const [conflicts, setConflicts] = createSignal<{
  roots: DownloadRootDto[];
  dest: string;
  names: string[];
} | null>(null);

export { conflicts, downloadError, progress, running, summary };

export function dismissSummary(): void {
  setSummary(null);
  setDownloadError(null);
}

/**
 * True when a transfer is already using the device.
 *
 * The backend serialises on one session mutex, so a download started during an
 * upload would not fail — it would sit on the lock and look frozen, which is
 * worse. The button asks this first.
 */
export function transferBusy(): boolean {
  return running() || uploading();
}

/**
 * Copy the selected rows into a folder on this computer.
 *
 * With `policy: "ask"` the backend writes nothing when it finds existing names
 * — not even the folder tree — so the confirmation is asked before the
 * destination has been touched.
 */
export async function download(
  roots: DownloadRootDto[],
  dest: string,
  policy: ConflictPolicy = "ask",
): Promise<void> {
  const id = storageId();
  if (!id || roots.length === 0 || !dest) return;

  setRunning(true);
  setSummary(null);
  setDownloadError(null);
  // Zeroed rather than left null: the backend walks the device before the first
  // byte moves, and on a large folder that walk is seconds of silence. A row
  // that says "preparing" is the difference between waiting and wondering.
  setProgress({ done: 0, total: roots.length, bytesDone: 0, bytesTotal: 0, name: "" });

  try {
    const outcome = await api.download.start(id, roots, dest, policy);
    if (outcome.status === "conflicts") {
      setConflicts({ roots, dest, names: outcome.names });
    } else {
      setSummary(outcome);
    }
  } catch (e) {
    setDownloadError(asAdxError(e));
  } finally {
    setRunning(false);
    setProgress(null);
  }
}

/** Answer the conflict question and run the transfer for real. */
export async function resolveConflicts(policy: Exclude<ConflictPolicy, "ask">): Promise<void> {
  const pending = conflicts();
  setConflicts(null);
  if (pending) await download(pending.roots, pending.dest, policy);
}

export function cancelConflicts(): void {
  setConflicts(null);
}

export async function cancelDownload(): Promise<void> {
  try {
    await api.download.cancel();
  } catch (e) {
    setDownloadError(asAdxError(e));
  }
}

/**
 * Hand the selected rows to the system as a drag into Finder.
 *
 * Nothing is copied here: the command returns as soon as the system has the
 * drag session, and the transfer starts only if the user drops the rows
 * somewhere that accepts them. Where they land is the drop point, so there is
 * no destination to pass and no folder to pick.
 */
export async function dragOut(roots: DownloadRootDto[]): Promise<void> {
  const id = storageId();
  if (!id || roots.length === 0) return;
  try {
    await api.drag.start(id, roots);
  } catch (e) {
    const problem = asAdxError(e);
    // `unsupported` is the honest answer on Windows and Linux, where the system
    // has no equivalent of file promises. Reporting it would put an error
    // banner under every attempted drag for a feature that is simply not there
    // — while the "Copy to computer" button is, and does the same job.
    if (problem.kind !== "unsupported") setDownloadError(problem);
  }
}

/**
 * Subscribe to progress events. Returns the unlisten function.
 *
 * `running` is set here, not only in `download()`, because a copy can also be
 * started from outside this store: dropping rows into Finder makes the backend
 * run the same transfer, and the toolbar has to grey out for it too — the
 * device has one session either way.
 */
export function watchDownloads(): Promise<() => void> {
  return onDownloadProgress((p) => {
    setProgress(p);
    setRunning(true);
  });
}

/**
 * Subscribe to the end of a copy started by a drop into Finder.
 *
 * The command that starts the drag returns before the user has let go, so this
 * event is the only thing that can clear the progress row — without it a drop
 * would leave the operations panel showing a transfer that finished minutes
 * ago.
 */
export function watchDragDrops(): Promise<() => void> {
  return onDragDone((done) => {
    if (done.status === "failed") setDownloadError(done.error);
    else setSummary(done.outcome);
    setRunning(false);
    setProgress(null);
  });
}
