import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { downloadDir } from "@tauri-apps/api/path";
import {
  ChevronRight,
  Download,
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
import type { EntryDto } from "@/ipc/types";
import { formatBytes } from "@/lib/format";
import { checkName } from "@/lib/names";
import { afterClick, EMPTY_SELECTION, selectAll, type Selection } from "@/lib/selection";
import { Dropdown, DropdownItem } from "@/components/Dropdown";
import ErrorBanner from "@/components/ErrorBanner";
import { Button, ConfirmModal, PromptModal } from "@/components/Modal";
import Preview from "@/components/Preview";
import { download, transferBusy } from "@/stores/download";
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
 * The toolbar is deliberately flat — one visible button per action. The
 * requirement is "maximally simple", and the previous tool's problem was never
 * too few features. The single exception is "copy to computer", which is one
 * verb with two destinations: a folder the user picks, or the standard
 * Downloads folder. Two top-level buttons for the same verb would read as two
 * features rather than one.
 */
/**
 * Height of one row, in px, and the period of the striping below the last one.
 *
 * One number rather than two, and set on the row explicitly rather than left to
 * `py-1` plus the line height: the filler below the table paints its stripes
 * with a gradient, and a gradient whose period disagrees with the real row
 * height produces stripes that visibly change thickness at the last row.
 *
 * The number alone is not the whole guarantee. A height on a `<tr>` is a
 * *minimum*, so this holds only while a row is one line — which it is, because
 * every cell truncates rather than wraps. Give a row a second line and the
 * stripes below the table will no longer match the ones above it.
 */
const ROW_H = 24;

/**
 * The striped area below the last row, as in Finder.
 *
 * Its phase is not guessed — it starts exactly where the table ends, so its
 * first band is simply the colour row number `count` would have had. That is
 * why this can be a gradient at all: it never has to line up with anything
 * above it, only continue the rhythm.
 */
const StripeFiller: Component<{ count: number; onClick: () => void }> = (props) => {
  const tint = "rgb(var(--bg-subtle))";
  const plain = "transparent";
  const first = () => (props.count % 2 === 1 ? tint : plain);
  const second = () => (props.count % 2 === 1 ? plain : tint);

  return (
    <div
      class="min-h-0 flex-1"
      style={{
        "background-image": `repeating-linear-gradient(to bottom, ${first()} 0, ${first()} ${ROW_H}px, ${second()} ${ROW_H}px, ${second()} ${ROW_H * 2}px)`,
      }}
      onClick={() => props.onClick()}
    />
  );
};

const Listing: Component = () => {
  const [rows, setRows] = createSignal<Selection>(EMPTY_SELECTION);
  const [renaming, setRenaming] = createSignal<{ handle: string; name: string } | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  /** Handle of the row the preview is showing, or `null` when it is closed.
   *  A handle rather than the row itself, so a listing refresh under an open
   *  preview resolves to the fresh row instead of pinning a stale copy. */
  const [previewing, setPreviewing] = createSignal<string | null>(null);

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

  /**
   * Everything the download needs, taken from the rows already on screen.
   *
   * Sent whole rather than as bare handles so the backend does not have to
   * re-read the folder to learn what is a folder and how big each file is —
   * that is a device round trip per row for information the listing has.
   */
  const roots = () =>
    selection().map((e) => ({
      handle: e.handle,
      name: e.name,
      isFolder: e.isFolder,
      size: e.size,
    }));

  const saveTo = async (dest: string | null) => {
    if (dest) await download(roots(), dest);
  };

  const pickDestination = async () => {
    const chosen = await open({ multiple: false, directory: true });
    await saveTo(typeof chosen === "string" ? chosen : null);
  };

  /**
   * Paging in the preview walks files, skipping folders — a folder has nothing
   * to show, and stepping onto one would turn the chevron into a dead end in
   * the middle of a run.
   *
   * Non-previewable files are *not* skipped. The modal says "no preview for
   * this" for them, which is information; skipping would move the cursor past
   * rows the user is watching go by, and they would lose their place.
   */
  const files = createMemo(() => entries().filter((e) => !e.isFolder));
  const previewIndex = () => files().findIndex((e) => e.handle === previewing());
  const previewEntry = () => files()[previewIndex()];

  /**
   * Step the preview, and move the selection with it.
   *
   * The selection following is the point, not a side effect: closing the modal
   * has to leave the cursor on the file the user was last looking at, so that
   * Copy to computer or Delete acts on it without hunting for the row again.
   */
  const stepPreview = (delta: number) => {
    const next = files()[previewIndex() + delta];
    if (!next) return;
    setPreviewing(next.handle);
    setRows({ picked: new Set([next.handle]), anchor: next.handle });
  };

  const openPreview = (entry: EntryDto) => {
    setPreviewing(entry.handle);
    setRows({ picked: new Set([entry.handle]), anchor: entry.handle });
  };

  /**
   * The reason a typed name cannot be used, in the interface language, or
   * `null`.
   *
   * The sibling names come from the listing already on screen, so "already
   * taken" costs nothing; asking the device would be a folder read over USB per
   * dialog.
   */
  const nameProblem = (name: string, self?: string) => {
    const problem = checkName(
      name,
      entries().map((e) => e.name),
      self,
    );
    return problem ? t()(`errors.${problem}`) : null;
  };

  const saveToDownloads = async () => {
    // `downloadDir()` throws where the OS has no such folder rather than
    // returning null, and a rejected promise here would silently do nothing.
    try {
      await saveTo(await downloadDir());
    } catch {
      await pickDestination();
    }
  };

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        {/* Disabled while any transfer is running, in either direction: the
            device takes one session, so a second transfer would not fail — it
            would queue behind the first and look frozen. */}
        <Button
          onClick={() => void pickFiles()}
          disabled={!canWrite() || transferBusy()}
          title={t()("listing.upload_files")}
        >
          <span class="flex items-center gap-1">
            <Upload size={12} /> {t()("listing.upload_files")}
          </span>
        </Button>
        <Button
          onClick={() => void pickFolder()}
          disabled={!canWrite() || transferBusy()}
          title={t()("listing.upload_folder")}
        >
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

        {/* The only menu in an otherwise flat toolbar: one verb, two
            destinations. Disabled with nothing selected, and while the device
            is already busy with a transfer — the backend serialises on one
            session, so a second one would not fail, it would look frozen. */}
        <Dropdown
          title={t()("listing.download")}
          disabled={selection().length === 0 || transferBusy()}
          label={
            <span class="flex items-center gap-1">
              <Download size={12} /> {t()("listing.download")}
            </span>
          }
        >
          {(close) => (
            <>
              <DropdownItem
                onClick={() => {
                  close();
                  void pickDestination();
                }}
              >
                {t()("listing.download_to")}
              </DropdownItem>
              <DropdownItem
                onClick={() => {
                  close();
                  void saveToDownloads();
                }}
              >
                {t()("listing.download_to_downloads")}
              </DropdownItem>
            </>
          )}
        </Dropdown>

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

      {/* Cleared by every re-read of the folder, so there is nothing to
          dismiss — see `loadEntries` in the browser store. */}
      <Show when={browseError()}>
        {(err) => (
          <div class="shrink-0 px-2 py-1.5">
            <ErrorBanner error={err()} />
          </div>
        )}
      </Show>

      {/* `tabindex` so the container can take focus and receive Cmd+A and
          Escape at all; `select-none` because without it Shift-click runs the
          browser's text-extend on mousedown and paints a blue smear across the
          rows instead of selecting them. */}
      <div
        class="flex min-h-0 flex-1 select-none flex-col overflow-auto outline-none"
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
                  {(entry, index) => (
                    <tr
                      class="cursor-default"
                      style={{ height: `${ROW_H}px` }}
                      // Exactly one background class is ever applied, and the
                      // conditions are mutually exclusive by construction.
                      // Layering them would leave it to stylesheet order which
                      // of two equally specific Tailwind classes wins — and the
                      // one that must win is the selection.
                      //
                      // Selection gets the accent tint, hover the grey, and
                      // every other row a faint stripe, Finder-style. The three
                      // stay distinguishable: when selection and hover were
                      // both `bg-bg-muted` a multi-row selection was unreadable
                      // (commit 7987acb), and a stripe as strong as the hover
                      // would bring the same problem back.
                      classList={{
                        "bg-accent/15": picked().has(entry.handle),
                        "hover:bg-bg-muted": !picked().has(entry.handle) && index() % 2 === 0,
                        "bg-bg-subtle hover:bg-bg-muted":
                          !picked().has(entry.handle) && index() % 2 === 1,
                      }}
                      onClick={(e) => onRowClick(entry.handle, e)}
                      onDblClick={() => {
                        if (entry.isFolder) {
                          // The two clicks that precede this one already moved
                          // the selection here; entering the folder clears it,
                          // and the folder-change effect clears the anchor.
                          void enterFolder(entry.handle, entry.name);
                        } else {
                          // Opened for every file, not only the ones with a
                          // preview: the modal itself says "no preview for
                          // this, copy it instead". A double-click that does
                          // nothing at all is indistinguishable from one the
                          // app failed to notice.
                          openPreview(entry);
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

            <StripeFiller count={entries().length} onClick={clearSelection} />
          </Show>
        </Show>
      </div>

      <Show when={creating()}>
        <PromptModal
          title={t()("dialog.new_folder_title")}
          label={t()("dialog.name_label")}
          confirmLabel={t()("dialog.create")}
          problem={(name) => nameProblem(name)}
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
            problem={(name) => nameProblem(name, target().name)}
            onClose={() => setRenaming(null)}
            onConfirm={(name) => {
              const handle = target().handle;
              setRenaming(null);
              void renameEntry(handle, name);
            }}
          />
        )}
      </Show>

      {/* Resolved from the current listing every render, so the preview follows
          a refresh rather than holding a row that no longer exists. If the file
          is gone after a reload, `previewEntry()` is undefined and the modal
          closes itself by simply not rendering. */}
      <Show when={previewEntry()}>
        {(entry) => (
          <Show when={storageId()}>
            {(id) => (
              <Preview
                entry={entry()}
                storageId={id()}
                onClose={() => setPreviewing(null)}
                onPrev={previewIndex() > 0 ? () => stepPreview(-1) : undefined}
                onNext={previewIndex() < files().length - 1 ? () => stepPreview(1) : undefined}
              />
            )}
          </Show>
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
