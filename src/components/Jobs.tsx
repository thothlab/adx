import { type Component, createMemo, For, Show } from "solid-js";
import { AlertCircle, AlertTriangle, Check, X } from "lucide-solid";
import { t } from "@/i18n";
import type { UploadOutcome } from "@/ipc/types";
import { formatBytes, fraction } from "@/lib/format";
import { Button, Modal } from "@/components/Modal";
import {
  cancelConflicts,
  cancelUpload,
  conflicts,
  dismissSummary,
  progress,
  resolveConflicts,
  running,
  summary,
  uploadError,
} from "@/stores/transfer";

/**
 * The operations panel: what is running, what just finished, and what went
 * wrong.
 *
 * A finished transfer stays on screen until dismissed. A copy that reports
 * nothing when it ends is indistinguishable from one that silently did less
 * than asked — and this one legitimately can do less than asked (skipped
 * conflicts, unfollowed symlinks), so it has to say so.
 */
const Jobs: Component = () => (
  <div class="space-y-2 p-2 text-xs">
    <Show when={progress()}>
      {(p) => (
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate">{p().name || t()("jobs.preparing")}</span>
            <span class="shrink-0 tabular-nums text-fg-muted">
              {p().done}/{p().total}
            </span>
            <Button onClick={() => void cancelUpload()}>{t()("jobs.cancel")}</Button>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
            <div
              class="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${fraction(p().bytesDone, p().bytesTotal) * 100}%` }}
            />
          </div>
          <div class="text-fg-muted">
            {formatBytes(p().bytesDone)} / {formatBytes(p().bytesTotal)}
          </div>
        </div>
      )}
    </Show>

    <Show when={uploadError()}>
      {(err) => (
        <div class="flex items-start gap-2 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-danger">
          <AlertCircle size={13} class="mt-0.5 shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="font-medium">{t()(`errors.${err().kind}`)}</div>
            <div class="break-words opacity-80">{err().message}</div>
          </div>
          <button class="shrink-0 opacity-60 hover:opacity-100" onClick={dismissSummary}>
            <X size={12} />
          </button>
        </div>
      )}
    </Show>

    <Show when={summary()}>{(outcome) => <Summary outcome={outcome()} />}</Show>

    <Show when={running() && !progress()}>
      <div class="text-fg-muted">{t()("jobs.preparing")}</div>
    </Show>

    <Show when={!running() && !progress() && !summary() && !uploadError()}>
      <div class="text-fg-muted">{t()("jobs.empty")}</div>
    </Show>

    <Show when={conflicts()}>
      {(pending) => (
        <ConflictDialog
          names={pending().names}
          onReplace={() => void resolveConflicts("replace")}
          onSkip={() => void resolveConflicts("skip")}
          onCancel={cancelConflicts}
        />
      )}
    </Show>
  </div>
);

/**
 * What a finished transfer says.
 *
 * The union is narrowed once, in a memo, into plain strings. Narrowing inside
 * JSX would mean re-reading `props.outcome` in every branch, and a props getter
 * does not keep TypeScript's narrowing across two reads — which is how a
 * "cancelled" result ends up rendered through the "done" branch.
 */
const Summary: Component<{ outcome: UploadOutcome }> = (props) => {
  const view = createMemo(() => {
    const o = props.outcome;
    if (o.status === "done") {
      const parts = [t()("jobs.done", { files: o.files, bytes: formatBytes(o.bytes) })];
      if (o.folders > 0) parts.push(t()("jobs.folders", { count: o.folders }));
      if (o.replaced > 0) parts.push(t()("jobs.replaced", { count: o.replaced }));
      if (o.skipped > 0) parts.push(t()("jobs.skipped", { count: o.skipped }));
      return { ok: true, line: parts.join(" · "), warnings: o.warnings };
    }
    if (o.status === "cancelled") {
      return {
        ok: false,
        line: t()("jobs.cancelled", { files: o.files, bytes: formatBytes(o.bytes) }),
        warnings: o.warnings,
      };
    }
    // `conflicts` never reaches here — it parks in its own signal — but the
    // branch exists so a new outcome variant is a compile error, not a blank row.
    return { ok: false, line: "", warnings: [] as string[] };
  });

  return (
    <div class="flex items-start gap-2 rounded border border-border bg-bg-subtle px-2 py-1.5">
      <Show
        when={view().ok}
        fallback={<AlertTriangle size={13} class="mt-0.5 shrink-0 text-warn" />}
      >
        <Check size={13} class="mt-0.5 shrink-0 text-success" />
      </Show>
      <div class="min-w-0 flex-1 space-y-1">
        <div>{view().line}</div>
        <Show when={view().warnings.length}>
          <ul class="space-y-0.5 text-warn">
            <For each={view().warnings}>{(w) => <li class="break-words">{w}</li>}</For>
          </ul>
        </Show>
      </div>
      <button class="shrink-0 opacity-60 hover:opacity-100" onClick={dismissSummary}>
        <X size={12} />
      </button>
    </div>
  );
};

/**
 * Three answers, not two: replacing and skipping are both reasonable and
 * neither is safe to assume. Nothing has been written to the device at the
 * moment this appears, so "cancel" really does leave the phone untouched.
 */
const ConflictDialog: Component<{
  names: string[];
  onReplace: () => void;
  onSkip: () => void;
  onCancel: () => void;
}> = (props) => (
  <Modal
    title={t()("dialog.conflict_title")}
    onClose={props.onCancel}
    footer={
      <>
        <Button onClick={props.onCancel}>{t()("dialog.cancel")}</Button>
        <Button onClick={props.onSkip}>{t()("dialog.conflict_skip")}</Button>
        <Button variant="primary" onClick={props.onReplace}>
          {t()("dialog.conflict_replace")}
        </Button>
      </>
    }
  >
    <p>{t()("dialog.conflict_body", { count: props.names.length })}</p>
    <ul class="mt-2 max-h-40 overflow-auto rounded border border-border bg-bg-subtle p-2 font-mono text-xs">
      <For each={props.names}>{(n) => <li class="truncate">{n}</li>}</For>
    </ul>
  </Modal>
);

export default Jobs;
