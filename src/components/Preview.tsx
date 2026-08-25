import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { AlertCircle, ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-solid";
import { t } from "@/i18n";
import { api, asAdxError, streamUrl } from "@/ipc/client";
import type { EntryDto } from "@/ipc/types";
import { formatBytes } from "@/lib/format";
import { isStreamed, isTruncatable, mimeOf, previewKind, PREVIEW_LIMITS } from "@/lib/preview";
import { canZoomIn, canZoomOut, FIT, zoomIn, zoomOut, zoomPercent } from "@/lib/zoom";
import { Button } from "@/components/Modal";
import PdfView from "@/components/PdfView";

/**
 * A quick look at a file without copying it off the device.
 *
 * # Two ways in, and the file's size decides which
 *
 * Small things — a photo, a PDF, a log — are read once into memory and handed
 * over as a `blob:` URL. A `data:` URL would carry the whole file as base64
 * inside the document, a third larger than the bytes and re-parsed on every
 * render; a blob is a handle to memory the browser already holds, released the
 * moment this component goes away.
 *
 * Media does not come this way at all. It is served by the `adx://` scheme a
 * byte range at a time, because a blob has to be complete before it is
 * anything, and the audiobooks on the measured device are 700-900 MB. Streaming
 * is also what makes the position slider work: a seek becomes a request for a
 * different offset instead of a re-read.
 *
 * # Why the size ceiling is checked before the read, not after
 *
 * The listing already knows how big the file is. Asking the device for a 4 GB
 * file and then deciding it cannot be shown costs minutes of USB traffic to
 * learn something that was on screen the whole time. Streamed kinds have no
 * ceiling — nothing is ever held whole.
 */
const Preview: Component<{
  entry: EntryDto;
  storageId: string;
  onClose: () => void;
  /** Move to the neighbouring file in the listing. Absent at the ends. */
  onPrev?: () => void;
  onNext?: () => void;
}> = (props) => {
  // Everything below is derived reactively from `props.entry`, because the
  // chevrons change it in place rather than remounting: a remount would drop
  // the modal for a frame and make paging through a folder flicker.
  const kind = createMemo(() => previewKind(props.entry.name));
  const limit = createMemo(() => {
    const k = kind();
    return k ? PREVIEW_LIMITS[k] : 0;
  });
  const tooBig = createMemo(() => {
    const k = kind();
    return !!k && !isTruncatable(k) && !isStreamed(k) && props.entry.size > limit();
  });

  /** Set when a media element refuses what it was given — an unsupported codec
   *  inside a container the engine does otherwise understand, which no
   *  extension check can predict. */
  const [mediaFailed, setMediaFailed] = createSignal(false);

  /**
   * Scale, in multiples of the fitted size. Only the still kinds have it: a
   * video scales itself to its box and a text file has the font size for that.
   */
  const [zoom, setZoom] = createSignal(FIT);
  const zoomable = () => (kind() === "image" || kind() === "pdf") && !tooBig();

  // Back to fit on every new file, keyed on the handle rather than on the row:
  // the chevrons swap `props.entry` in place, and a listing refresh hands back
  // an equal row for the same file — resetting on that would snap the zoom back
  // under the user's hands while they are looking at it.
  createEffect(
    on(
      () => props.entry.handle,
      () => setZoom(FIT),
      { defer: true },
    ),
  );

  const stepZoom = (dir: 1 | -1) => setZoom(dir > 0 ? zoomIn(zoom()) : zoomOut(zoom()));

  const onKeyDown = (e: KeyboardEvent) => {
    // Zoom keys only where there is something to zoom, so a text preview keeps
    // "-" and "0" for whatever has focus inside it. "=" as well as "+": the
    // unshifted key on most layouts, and nobody presses Shift to zoom in.
    if (zoomable() && (e.key === "+" || e.key === "=")) stepZoom(1);
    else if (zoomable() && e.key === "-") stepZoom(-1);
    else if (zoomable() && e.key === "0") setZoom(FIT);
    // Left and right rather than up and down: the chevrons are horizontal, and
    // up/down belong to whatever has focus inside the preview — the scroll of a
    // long text file, the position of a video.
    else if (e.key === "Escape") props.onClose();
    else if (e.key === "ArrowLeft") props.onPrev?.();
    else if (e.key === "ArrowRight") props.onNext?.();
    else return;
    e.preventDefault();
    // The listing behind this modal also handles Escape, by clearing the
    // selection — which would undo the one thing the preview is supposed to
    // leave behind, the cursor on the last file looked at. Stopping the event
    // here is what makes that deterministic instead of a question of where
    // focus happened to be: with the capture phase below, the listing never
    // sees the key at all.
    e.stopPropagation();
  };
  // Capture phase, on `document`. Both details matter. `document`, because the
  // modal opens from a double-click on a row and focus stays on the listing
  // behind it. Capture, because a bubbling listener on `document` runs *after*
  // the listing's own handler — the selection would already be gone by the time
  // this ran.
  document.addEventListener("keydown", onKeyDown, true);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));

  let objectUrl: string | null = null;
  const releaseUrl = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };
  // Registered synchronously, not inside the resource's `then`: by the time a
  // promise resolves there is no reactive owner left and `onCleanup` silently
  // does nothing — the leak this project already paid for once (commit
  // 1c85d97).
  onCleanup(releaseUrl);

  /**
   * Text arrives decoded, a PDF as the bytes themselves, everything else as a
   * URL the tag can point at.
   *
   * The PDF is the odd one out because it is drawn by `PdfView` rather than by
   * the engine, and pdf.js wants the bytes. A `blob:` URL would mean handing
   * the library a URL for it to fetch back out of memory it is already holding.
   */
  interface Loaded {
    text?: string;
    url?: string;
    bytes?: ArrayBuffer;
    truncated: boolean;
  }

  const [content] = createResource(
    // The source is the row itself, so paging re-reads. Without it the second
    // file in a folder would show the first one's bytes under its own name.
    () => props.entry,
    // `props.storageId` is read inside the fetcher and deliberately does not
    // track: the source above is the one thing that may re-trigger a read. The
    // storage cannot change under an open preview without the folder changing
    // too, which closes it.
    // eslint-disable-next-line solid/reactivity
    async (entry): Promise<Loaded | null> => {
      setMediaFailed(false);
      // The previous file's blob is dropped here rather than in a cleanup: this
      // component outlives the file it is showing, so paging through twenty
      // photos would otherwise pin all twenty in memory until the modal closed.
      releaseUrl();

      const k = previewKind(entry.name);
      if (!k) return null;

      // Served, not read. No bytes cross the IPC bridge for media at all.
      if (isStreamed(k)) {
        return { url: streamUrl(props.storageId, entry.handle, entry.name), truncated: false };
      }
      if (!isTruncatable(k) && entry.size > PREVIEW_LIMITS[k]) return null;

      const cap = PREVIEW_LIMITS[k];
      const bytes = await api.entries.read(props.storageId, entry.handle, cap);

      if (k === "text") {
        // Lossy on purpose: a file that is not valid UTF-8 must show mojibake,
        // which tells the user what it is, rather than throw and show nothing.
        return { text: new TextDecoder("utf-8").decode(bytes), truncated: entry.size > cap };
      }

      if (k === "pdf") return { bytes, truncated: false };

      objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeOf(k, entry.name) }));
      return { url: objectUrl, truncated: false };
    },
  );

  const Chevron: Component<{ dir: "prev" | "next"; onClick?: () => void }> = (p) => (
    <button
      class="shrink-0 rounded p-1 text-fg-muted hover:bg-bg-muted hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
      title={t()(p.dir === "prev" ? "preview.prev" : "preview.next")}
      disabled={!p.onClick}
      onClick={() => p.onClick?.()}
    >
      <Show when={p.dir === "prev"} fallback={<ChevronRight size={16} />}>
        <ChevronLeft size={16} />
      </Show>
    </button>
  );

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl">
        <header class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
          {/* The chevrons sit next to the name they change, so it is obvious
              what is about to move — and the name is what tells the user the
              step happened. */}
          <Chevron dir="prev" onClick={props.onPrev} />
          <Chevron dir="next" onClick={props.onNext} />

          {/* Only where there is something to scale, and only when there is
              something on screen to scale: a zoom widget over "no preview for
              this" is a control that does nothing. */}
          <Show when={zoomable()}>
            <div class="flex shrink-0 items-center gap-0.5">
              <button
                class="rounded p-1 text-fg-muted hover:bg-bg-muted hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
                title={t()("preview.zoom_out")}
                disabled={!canZoomOut(zoom())}
                onClick={() => stepZoom(-1)}
              >
                <ZoomOut size={14} />
              </button>
              {/* The label is the reset: the one place a user looks to find out
                  where they are is the one they reach for to get back. */}
              <button
                class="w-20 rounded px-1 py-0.5 text-center text-xs tabular-nums text-fg-muted hover:bg-bg-muted hover:text-fg"
                title={t()("preview.zoom_reset")}
                onClick={() => setZoom(FIT)}
              >
                <Show when={zoom() !== FIT} fallback={t()("preview.zoom_fit")}>
                  {zoomPercent(zoom())} %
                </Show>
              </button>
              <button
                class="rounded p-1 text-fg-muted hover:bg-bg-muted hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
                title={t()("preview.zoom_in")}
                disabled={!canZoomIn(zoom())}
                onClick={() => stepZoom(1)}
              >
                <ZoomIn size={14} />
              </button>
            </div>
          </Show>

          <span class="min-w-0 flex-1 truncate px-1 text-sm font-medium">{props.entry.name}</span>
          <span class="shrink-0 text-xs text-fg-muted">{formatBytes(props.entry.size)}</span>

          <button
            class="shrink-0 rounded p-1 text-fg-muted hover:bg-bg-muted hover:text-fg"
            title={t()("dialog.close")}
            onClick={() => props.onClose()}
          >
            <X size={14} />
          </button>
        </header>

        <div
          class="min-h-0 flex-1 overflow-auto bg-bg-subtle"
          // A trackpad pinch arrives as a wheel event with `ctrlKey`, which is
          // the gesture people try first on a picture. Guarded to the kinds that
          // scale, so a pinch over a text file scrolls it as it always did
          // instead of being swallowed by a `preventDefault` that leads nowhere.
          onWheel={(e) => {
            if (!zoomable() || !(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            stepZoom(e.deltaY < 0 ? 1 : -1);
          }}
        >
          <Show
            when={kind() && !tooBig()}
            fallback={
              <Notice
                text={
                  tooBig()
                    ? t()("preview.too_big", { size: formatBytes(limit()) })
                    : t()("preview.unsupported")
                }
              />
            }
          >
            <Show when={!content.loading} fallback={<Notice text={t()("preview.loading")} />}>
              <Show
                when={!content.error}
                fallback={<Notice text={asAdxError(content.error).message} error />}
              >
                <Show when={content()}>
                  {(loaded) => (
                    <>
                      <Show when={loaded().truncated}>
                        <div class="border-b border-border bg-warn/10 px-3 py-1.5 text-xs text-warn">
                          {t()("preview.truncated", { size: formatBytes(limit()) })}
                        </div>
                      </Show>

                      <Show when={kind() === "image"}>
                        {/* `m-auto` on the image rather than `justify-center` on
                            the box: a centred flex item that outgrows its
                            container cannot be scrolled back to on the left —
                            the overflow lands outside the scrollable area. With
                            auto margins the picture centres while it fits and
                            stays reachable in both directions once it does
                            not. */}
                        <div class="flex min-h-full p-4">
                          <img
                            src={loaded().url}
                            alt={props.entry.name}
                            class="m-auto object-contain"
                            classList={{ "max-h-full max-w-full": zoom() === FIT }}
                            style={
                              zoom() === FIT
                                ? undefined
                                : { width: `${zoomPercent(zoom())}%`, "max-width": "none" }
                            }
                          />
                        </div>
                      </Show>

                      <Show when={kind() === "pdf"}>
                        {/* Drawn by us, not by the engine — see `PdfView` for
                            why. The zoom ladder is the render scale here, which
                            is what makes a step on a PDF sharp rather than a
                            stretched raster. */}
                        <Show when={loaded().bytes}>
                          {(bytes) => <PdfView bytes={bytes()} scale={zoom()} />}
                        </Show>
                      </Show>

                      <Show when={kind() === "video"}>
                        <Show when={!mediaFailed()} fallback={<Notice text={t()("preview.no_codec")} />}>
                          <div class="flex h-full items-center justify-center bg-black p-2">
                            {/* No `preload`: the element decides what to fetch,
                                and every fetch is a USB read. Letting it pull
                                the whole file ahead of the playhead would undo
                                the point of streaming. */}
                            <video
                              src={loaded().url}
                              controls
                              autoplay
                              class="max-h-full max-w-full"
                              onError={() => setMediaFailed(true)}
                            />
                          </div>
                        </Show>
                      </Show>

                      <Show when={kind() === "audio"}>
                        <Show when={!mediaFailed()} fallback={<Notice text={t()("preview.no_codec")} />}>
                          <div class="flex h-full flex-col items-center justify-center gap-4 p-6">
                            <span class="max-w-full truncate text-xs text-fg-muted">
                              {props.entry.name}
                            </span>
                            <audio
                              src={loaded().url}
                              controls
                              autoplay
                              class="w-full max-w-xl"
                              onError={() => setMediaFailed(true)}
                            />
                          </div>
                        </Show>
                      </Show>

                      <Show when={kind() === "text"}>
                        {/* `select-text` against the shell's `select-none`:
                            copying a line out of a config or a log is the main
                            reason to open a text file at all. */}
                        <pre class="h-full select-text whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
                          {loaded().text}
                        </pre>
                      </Show>
                    </>
                  )}
                </Show>
              </Show>
            </Show>
          </Show>
        </div>

        <footer class="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
          <span class="ml-auto" />
          <Button onClick={() => props.onClose()}>{t()("dialog.close")}</Button>
        </footer>
      </div>
    </div>
  );
};

/** Everything the preview cannot show — too big, wrong kind, read failed —
 *  says so in the same place the content would have been, rather than closing
 *  the modal and leaving the double-click looking like it did nothing. */
const Notice: Component<{ text: string; error?: boolean }> = (props) => (
  <div
    class="flex h-full items-center justify-center gap-2 p-6 text-center text-xs"
    classList={{ "text-danger": props.error, "text-fg-muted": !props.error }}
  >
    <Show when={props.error}>
      <AlertCircle size={14} class="shrink-0" />
    </Show>
    <span>{props.text}</span>
  </div>
);

export default Preview;
