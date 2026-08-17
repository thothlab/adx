import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderUp,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-solid";
import { t } from "@/i18n";
import { formatBytes } from "@/lib/format";
import { afterClick, EMPTY_SELECTION, selectAll, type Selection } from "@/lib/selection";
import { Button, ConfirmModal, PromptModal } from "@/components/Modal";
import {
  browseError,
  busy,
  canWrite,
  createFolder,
  crumbs,
  currentStorage,
  enterFolder,
  entries,
  goToDepth,
  reloadAll,
  removeEntries,
  renameEntry,
  storageId,
} from "@/stores/browser";
import { upload } from "@/stores/transfer";

/**
 * The file listing, and every action that changes the device.
 *
 * The toolbar is deliberately flat — six buttons, all visible, none behind a
 * menu. The requirement is "maximally simple", and the previous tool's problem
 * was never too few features.
 */
const Listing: Component = () => {
  const [rows, setRows] = createSignal<Selection>(EMPTY_SELECTION);
  const [renaming, setRenaming] = createSignal<{ handle: string; name: string } | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);

  const picked = () => rows().picked;
  const handles = () => entries().map((e) => e.handle);
  const selection = createMemo(() => entries().filter((e) => picked().has(e.handle)));

  const clearSelection = () => setRows(EMPTY_SELECTION);

  /**
   * Leaving a folder drops the selection.
   *
   * Not cosmetic: MTP object handles are only unique within a device's
   * numbering, and a handle from the folder we just left can name a different
   * object in the folder we just entered. Carrying `picked` across would mean
   * Delete removing something the user never selected, in a directory they are
   * no longer looking at. Filtering `selection()` against `entries()` does not
   * protect against this — a colliding handle passes that filter.
   */
  createEffect(on([storageId, crumbs], clearSelection));

  const onRowClick = (handle: string, e: MouseEvent) =>
    setRows(
      afterClick(handles(), rows(), handle, {
        shift: e.shiftKey,
        additive: e.metaKey || e.ctrlKey,
      }),
    );

  const onKeyDown = (e: KeyboardEvent) => {
    // `e.code`, not `e.key`: on a Russian layout Cmd+A reports the key as "ф",
    // and a shortcut that stops working when the user switches layout is a
    // shortcut that does not work.
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyA") {
      e.preventDefault();
      setRows(selectAll(handles()));
      return;
    }
    if (e.key === "Escape") clearSelection();
  };

  const pickFiles = async () => {
    const chosen = await open({ multiple: true, directory: false });
    if (chosen) await upload(Array.isArray(chosen) ? chosen : [chosen]);
  };

  const pickFolder = async () => {
    const chosen = await open({ multiple: true, directory: true });
    if (chosen) await upload(Array.isArray(chosen) ? chosen : [chosen]);
  };

  const doDelete = async () => {
    const doomed = selection().map((e) => e.handle);
    setDeleting(false);
    clearSelection();
    await removeEntries(doomed);
  };

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <Button onClick={() => void pickFiles()} disabled={!canWrite()} title={t()("listing.upload_files")}>
          <span class="flex items-center gap-1">
            <Upload size={12} /> {t()("listing.upload_files")}
          </span>
        </Button>
        <Button onClick={() => void pickFolder()} disabled={!canWrite()} title={t()("listing.upload_folder")}>
          <span class="flex items-center gap-1">
            <FolderUp size={12} /> {t()("listing.upload_folder")}
          </span>
        </Button>
        <Button onClick={() => setCreating(true)} disabled={!canWrite()} title={t()("listing.new_folder")}>
          <span class="flex items-center gap-1">
            <FolderPlus size={12} /> {t()("listing.new_folder")}
          </span>
        </Button>

        <span class="mx-1 h-4 w-px bg-border" />

        <Button
          onClick={() => {
            const one = selection()[0];
            if (one) setRenaming({ handle: one.handle, name: one.name });
          }}
          disabled={!canWrite() || selection().length !== 1}
          title={t()("listing.rename")}
        >
          <span class="flex items-center gap-1">
            <Pencil size={12} /> {t()("listing.rename")}
          </span>
        </Button>
        <Button
          variant="danger"
          onClick={() => setDeleting(true)}
          disabled={!canWrite() || selection().length === 0}
          title={t()("listing.delete")}
        >
          <span class="flex items-center gap-1">
            <Trash2 size={12} /> {t()("listing.delete")}
          </span>
        </Button>

        {/* The count explains why Rename is greyed out while Delete is not:
            Rename takes exactly one, Delete takes any number. Without it the
            two buttons look inconsistently broken. */}
        <Show when={selection().length}>
          <span class="ml-2 whitespace-nowrap text-xs text-fg-muted">
            {t()("listing.selected", { count: selection().length })}
          </span>
        </Show>

        <span class="ml-auto" />
        <Button onClick={() => void reloadAll()} disabled={busy()} title={t()("listing.reload")}>
          <RefreshCw size={12} class={busy() ? "animate-spin" : undefined} />
        </Button>
      </div>

      <div class="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1 text-xs text-fg-muted">
        <button class="shrink-0 rounded px-1 py-0.5 hover:bg-bg-muted" onClick={() => void goToDepth(0)}>
          {currentStorage()?.description ?? t()("tree.root")}
        </button>
        <For each={crumbs()}>
          {(crumb, index) => (
            <>
              <ChevronRight size={11} class="shrink-0" />
              <button
                class="shrink-0 rounded px-1 py-0.5 hover:bg-bg-muted"
                classList={{ "text-fg font-medium": index() === crumbs().length - 1 }}
                onClick={() => void goToDepth(index() + 1)}
              >
                {crumb.name}
              </button>
            </>
          )}
        </For>
      </div>

      <Show when={browseError()}>
        {(err) => (
          <div class="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger">
            <AlertCircle size={13} class="mt-0.5 shrink-0" />
            <div>
              <div class="font-medium">{t()(`errors.${err().kind}`)}</div>
              <div class="opacity-80">{err().message}</div>
            </div>
          </div>
        )}
      </Show>

      {/* `tabindex` so the container can take focus and receive Cmd+A and
          Escape at all; `select-none` because without it Shift-click runs the
          browser's text-extend on mousedown and paints a blue smear across the
          rows instead of selecting them. */}
      <div
        class="min-h-0 flex-1 select-none overflow-auto outline-none"
        tabindex="0"
        onKeyDown={onKeyDown}
        onClick={(e) => {
          // Blank space below the last row means "never mind".
          if (e.target === e.currentTarget) clearSelection();
        }}
      >
        <Show
          when={storageId()}
          fallback={<div class="p-3 text-xs text-fg-muted">{t()("listing.empty")}</div>}
        >
          <Show
            when={entries().length}
            fallback={
              <div class="space-y-1 p-3 text-xs text-fg-muted">
                <div>{t()("listing.empty_folder")}</div>
                <Show when={canWrite()}>
                  <div>{t()("listing.drop_hint")}</div>
                </Show>
              </div>
            }
          >
            <table class="w-full border-collapse text-xs">
              <thead class="sticky top-0 bg-bg text-fg-subtle">
                <tr class="border-b border-border">
                  <th class="px-2 py-1 text-left font-medium">{t()("listing.name")}</th>
                  <th class="w-24 px-2 py-1 text-right font-medium">{t()("listing.size")}</th>
                  {/* Wide enough for "2026-08-17 08:19" on one line. At w-32
                      every date wrapped, which doubled every row's height and
                      made the listing look like it was rendering badly. */}
                  <th class="w-36 whitespace-nowrap px-2 py-1 text-left font-medium">
                    {t()("listing.modified")}
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={entries()}>
                  {(entry) => (
                    <tr
                      class="cursor-default border-b border-border/40"
                      // Selection gets the accent tint, hover keeps the grey —
                      // and they are mutually exclusive rather than layered,
                      // because when both were `bg-bg-muted` the row under the
                      // cursor was indistinguishable from a selected one, which
                      // makes a multi-row selection impossible to read.
                      classList={{
                        "bg-accent/15": picked().has(entry.handle),
                        "hover:bg-bg-muted": !picked().has(entry.handle),
                      }}
                      onClick={(e) => onRowClick(entry.handle, e)}
                      onDblClick={() => {
                        if (entry.isFolder) {
                          // The two clicks that precede this one already moved
                          // the selection here; entering the folder clears it,
                          // and the folder-change effect clears the anchor.
                          void enterFolder(entry.handle, entry.name);
                        }
                      }}
                    >
                      <td class="max-w-0 px-2 py-1">
                        <span class="flex items-center gap-1.5">
                          <Show
                            when={entry.isFolder}
                            fallback={<FileIcon size={12} class="shrink-0 text-fg-muted" />}
                          >
                            <Folder size={12} class="shrink-0 text-accent" />
                          </Show>
                          <span class="truncate">{entry.name}</span>
                        </span>
                      </td>
                      <td class="px-2 py-1 text-right tabular-nums text-fg-muted">
                        <Show when={!entry.isFolder} fallback={<span>—</span>}>
                          {formatBytes(entry.size)}
                        </Show>
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 font-mono text-fg-muted">
                        {entry.modified ?? "—"}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>
      </div>

      <Show when={creating()}>
        <PromptModal
          title={t()("dialog.new_folder_title")}
          label={t()("dialog.name_label")}
          confirmLabel={t()("dialog.create")}
          onClose={() => setCreating(false)}
          onConfirm={(name) => {
            setCreating(false);
            void createFolder(name);
          }}
        />
      </Show>

      <Show when={renaming()}>
        {(target) => (
          <PromptModal
            title={t()("dialog.rename_title")}
            label={t()("dialog.name_label")}
            initial={target().name}
            confirmLabel={t()("dialog.rename")}
            onClose={() => setRenaming(null)}
            onConfirm={(name) => {
              const handle = target().handle;
              setRenaming(null);
              void renameEntry(handle, name);
            }}
          />
        )}
      </Show>

      <Show when={deleting()}>
        <ConfirmModal
          title={t()("dialog.delete_title")}
          body={t()("dialog.delete_body", { count: selection().length })}
          names={selection().map((e) => e.name)}
          confirmLabel={t()("listing.delete")}
          danger
          onClose={() => setDeleting(false)}
          onConfirm={() => void doDelete()}
        />
      </Show>
    </div>
  );
};

export default Listing;
