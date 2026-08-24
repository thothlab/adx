import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { downloadDir } from "@tauri-apps/api/path";
import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
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
import { createDelayed, SPINNER_DELAY_MS } from "@/lib/delayed";
import { checkName } from "@/lib/names";
import { pastThreshold, rowsForDrag } from "@/lib/drag";
import type { SortKey } from "@/lib/sort";
import { afterClick, EMPTY_SELECTION, selectAll, type Selection } from "@/lib/selection";
import { Dropdown, DropdownItem } from "@/components/Dropdown";
import ErrorBanner from "@/components/ErrorBanner";
import Spinner from "@/components/Spinner";
import { Button, ConfirmModal, PromptModal } from "@/components/Modal";
import Preview from "@/components/Preview";
import { download, dragOut, transferBusy } from "@/stores/download";
import {
  browseError,
  busy,
  canWrite,
  createFolder,
  crumbs,
  currentStorage,
  enterFolder,
  entries,
  folderLoading,
  goToDepth,
  reloadAll,
  removeEntries,
  renameEntry,
  sort,
  sortBy,
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
 * The header is exactly one row tall, and the virtualizer is told so.
 *
 * It scrolls with the content (sticking at the top) rather than living outside
 * the scroll box, so every row offset the virtualizer computes is measured from
 * above it. One constant, given to `scrollMargin` and subtracted in the row
 * transform: if the two ever disagree, every row is off by the difference and
 * the last one is unreachable.
 */
const HEADER_H = ROW_H;

/**
 * Column widths, shared by the header and every row.
 *
 * Name takes what is left and may shrink to nothing (`minmax(0, 1fr)` rather
 * than `1fr`, or a long filename would push the other two columns off the
 * right edge instead of truncating).
 */
const COLUMNS = "minmax(0, 1fr) 6rem 9rem";

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

/**
 * One column header: a button as wide as its column, carrying the arrow when
 * the listing is sorted by it.
 *
 * The button fills the header row rather than bringing padding of its own, and
 * `HEADER_H` above stays the only thing that decides how tall the row is. That
 * number is also the virtualizer's `scrollMargin` and the figure every row's
 * transform subtracts, so a header that grew by the height of a chevron would
 * push every row down by that much and leave the last one unreachable.
 */
const SortHeader: Component<{ column: SortKey; label: string; align?: "right" }> = (props) => (
  <button
    type="button"
    class="flex h-full min-w-0 items-center gap-1 self-stretch px-2 hover:bg-bg-muted"
    classList={{ "justify-end": props.align === "right" }}
    onClick={() => sortBy(props.column)}
  >
    <span class="truncate">{props.label}</span>
    {/* The slot is here whether or not this is the sorted column: an arrow that
        appeared out of nothing would shove the label sideways on every click,
        and the header would read as moving rather than as sorting. */}
    <span class="flex w-3 shrink-0 justify-center">
      <Show when={sort().key === props.column}>
        <Show when={sort().dir === "asc"} fallback={<ChevronDown size={11} />}>
          <ChevronUp size={11} />
        </Show>
      </Show>
    </span>
  </button>
);

const Listing: Component = () => {
  const [rows, setRows] = createSignal<Selection>(EMPTY_SELECTION);
  const [renaming, setRenaming] = createSignal<{ handle: string; name: string } | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  /** Handle of the row the preview is showing, or `null` when it is closed.
   *  A handle rather than the row itself, so a listing refresh under an open
   *  preview resolves to the fresh row instead of pinning a stale copy. */
  const [previewing, setPreviewing] = createSignal<string | null>(null);

  let scrollEl: HTMLDivElement | undefined;

  /** The loading state, but only once the wait is worth reporting. */
  const slowLoad = createDelayed(folderLoading, SPINNER_DELAY_MS);

  const virtualizer = createVirtualizer({
    // A getter, not a value: this is what makes the option reactive, so a new
    // folder resizes the list instead of leaving the previous folder's count.
    get count() {
      return entries().length;
    },
    getScrollElement: () => scrollEl ?? null,
    // Fixed, not measured. Measurement exists for rows that wrap, and these do
    // not — every cell truncates. It is also the number the stripes below the
    // last row are drawn with, so a row that measured differently would break
    // the rhythm at the seam.
    estimateSize: () => ROW_H,
    // The header scrolls above the rows, so row offsets start below it.
    scrollMargin: HEADER_H,
    overscan: 12,
  });

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
   *
   * The scroll position goes back to the top in the same breath, and that half
   * is about the virtualizer rather than about handles: it renders whatever
   * range the current offset points at, so a folder entered while scrolled to
   * row 400 opens showing blank space below its ten rows, with no way to tell
   * that from an empty folder. Source: `Projects/Pane/Правки` — a virtual list
   * has to be reset explicitly when its contents are swapped.
   */
  createEffect(
    on([storageId, crumbs], () => {
      clearSelection();
      if (scrollEl) scrollEl.scrollTop = 0;
    }),
  );

  /**
   * A re-sorted listing goes back to the top.
   *
   * Kept apart from the folder-change effect above because it is a different
   * event with a different answer. Under a new order the rows at the current
   * scroll offset are entirely different ones, so holding the offset would show
   * an arbitrary window into the new order — while the reason to click "Size"
   * at all is to see one of its ends.
   *
   * The selection deliberately survives, unlike on a folder change: re-sorting
   * the same folder leaves every handle in `picked` naming the object it named
   * before, and the anchor with it, so a following Shift-click ranges over the
   * new display order.
   */
  createEffect(
    on(
      sort,
      () => {
        if (scrollEl) scrollEl.scrollTop = 0;
      },
      { defer: true },
    ),
  );

  /**
   * Dragging rows out to Finder.
   *
   * Not HTML5 `dragstart`: inside WKWebView that starts the web view's own drag
   * session, and the native one — the only kind that can hand a file to Finder
   * — cannot be started on top of it. So the gesture is watched by hand: button
   * down, and once the pointer has moved far enough, the system takes over.
   *
   * The listeners go on `window` rather than the row: a drag leaves the row
   * within the first few pixels, and a `mouseup` outside it would otherwise
   * never arrive and leave the gesture armed.
   */
  const onRowMouseDown = (entry: EntryDto, e: MouseEvent) => {
    // Left button only, and never during a transfer: the device has one
    // session, so a second copy would not fail — it would sit on the lock and
    // look frozen. Same rule as the toolbar's.
    if (e.button !== 0 || transferBusy() || !storageId()) return;
    const fromX = e.clientX;
    const fromY = e.clientY;

    const move = (m: MouseEvent) => {
      if (!pastThreshold(fromX, fromY, m.clientX, m.clientY)) return;
      stop();
      const dragged = rowsForDrag(entries(), picked(), entry);
      // A row outside the selection becomes the selection first: dragging rows
      // that carry no visible mark copies things the user cannot see they
      // asked for.
      if (!picked().has(entry.handle)) {
        setRows({ picked: new Set([entry.handle]), anchor: entry.handle });
      }
      void dragOut(dragged.map(asRoot));
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

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
  const asRoot = (e: EntryDto) => ({
    handle: e.handle,
    name: e.name,
    isFolder: e.isFolder,
    size: e.size,
  });

  const roots = () => selection().map(asRoot);

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

    // Bring the row into view. Not cosmetic since the list became virtual: a
    // row outside the rendered window is not in the DOM at all, so paging
    // through a long folder and pressing Escape would leave the user looking at
    // rows with no selection anywhere on screen — which is exactly the thing
    // the cursor-follows-the-preview behaviour exists to prevent.
    const row = entries().findIndex((e) => e.handle === next.handle);
    if (row >= 0) virtualizer.scrollToIndex(row);
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
        ref={scrollEl}
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
          {/* Loading takes priority over "this folder is empty", and the order
              matters: while a folder is being read there are no rows yet, and
              the empty-folder message would be a confident answer given before
              the question was asked. */}
          <Show
            when={!folderLoading()}
            fallback={
              // Blank until the wait is long enough to be worth mentioning —
              // see `createDelayed`. A spinner on a folder that answers in
              // 20 ms is a flicker, not information.
              <Show when={slowLoad()}>
                <div class="p-3">
                  <Spinner label={t()("listing.loading")} />
                </div>
              </Show>
            }
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
            {/* The header is a grid row with the same template as every data
                row, and that shared constant is the whole reason the columns
                line up: two independent width declarations are two chances to
                drift, and the drift only shows once real data is in the cells. */}
            <div
              class="sticky top-0 z-10 grid shrink-0 items-center border-b border-border bg-bg text-xs font-medium text-fg-subtle"
              style={{ height: `${HEADER_H}px`, "grid-template-columns": COLUMNS }}
            >
              <SortHeader column="name" label={t()("listing.name")} />
              <SortHeader column="size" label={t()("listing.size")} align="right" />
              {/* Wide enough for "2026-08-17 08:19" on one line. At w-32 every
                  date wrapped, which doubled every row's height and made the
                  listing look like it was rendering badly. */}
              <SortHeader column="modified" label={t()("listing.modified")} />
            </div>

            {/* Only the rows in view exist in the DOM. A folder of 5000 objects
                is a normal camera roll, and 5000 rows of three cells each is
                where a listing stops scrolling and starts stuttering. The
                container keeps the full height so the scrollbar still tells the
                truth about how much is below. */}
            <div
              class="relative shrink-0"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              <For each={virtualizer.getVirtualItems()}>
                {(row) => (
                  <Show when={entries()[row.index]}>
                    {(entry) => (
                      <div
                        class="absolute inset-x-0 top-0 grid cursor-default items-center text-xs"
                        style={{
                          height: `${ROW_H}px`,
                          // `translateY`, not `top`: a transform is composited,
                          // and this value changes on every scroll frame.
                          // `row.start` is measured from the top of the scroll
                          // content, which includes the header — hence the
                          // subtraction, the same figure given as `scrollMargin`.
                          transform: `translateY(${row.start - HEADER_H}px)`,
                          "grid-template-columns": COLUMNS,
                        }}
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
                        //
                        // The stripe follows `row.index`, not the position in
                        // the rendered slice: virtual rows come and go, and a
                        // stripe keyed on the slice would repaint itself every
                        // scroll frame.
                        classList={{
                          "bg-accent/15": picked().has(entry().handle),
                          "hover:bg-bg-muted":
                            !picked().has(entry().handle) && row.index % 2 === 0,
                          "bg-bg-subtle hover:bg-bg-muted":
                            !picked().has(entry().handle) && row.index % 2 === 1,
                        }}
                        onMouseDown={(e) => onRowMouseDown(entry(), e)}
                        onClick={(e) => onRowClick(entry().handle, e)}
                        onDblClick={() => {
                          if (entry().isFolder) {
                            // The two clicks that precede this one already moved
                            // the selection here; entering the folder clears it,
                            // and the folder-change effect clears the anchor.
                            void enterFolder(entry().handle, entry().name);
                          } else {
                            // Opened for every file, not only the ones with a
                            // preview: the modal itself says "no preview for
                            // this, copy it instead". A double-click that does
                            // nothing at all is indistinguishable from one the
                            // app failed to notice.
                            openPreview(entry());
                          }
                        }}
                      >
                        <span class="flex min-w-0 items-center gap-1.5 px-2">
                          <Show
                            when={entry().isFolder}
                            fallback={<FileIcon size={12} class="shrink-0 text-fg-muted" />}
                          >
                            <Folder size={12} class="shrink-0 text-accent" />
                          </Show>
                          <span class="truncate">{entry().name}</span>
                        </span>
                        <span class="px-2 text-right tabular-nums text-fg-muted">
                          <Show when={!entry().isFolder} fallback="—">
                            {formatBytes(entry().size)}
                          </Show>
                        </span>
                        <span class="whitespace-nowrap px-2 font-mono text-fg-muted">
                          {entry().modified ?? "—"}
                        </span>
                      </div>
                    )}
                  </Show>
                )}
              </For>
            </div>

            <StripeFiller count={entries().length} onClick={clearSelection} />
          </Show>
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
