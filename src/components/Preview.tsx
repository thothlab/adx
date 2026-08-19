import { type Component, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js";
import { AlertCircle, ChevronLeft, ChevronRight, X } from "lucide-solid";
import { t } from "@/i18n";
import { api, asAdxError, streamUrl } from "@/ipc/client";
import type { EntryDto } from "@/ipc/types";
import { formatBytes } from "@/lib/format";
import { isStreamed, isTruncatable, mimeOf, previewKind, PREVIEW_LIMITS } from "@/lib/preview";
import { Button } from "@/components/Modal";

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

  const onKeyDown = (e: KeyboardEvent) => {
    // Left and right rather than up and down: the chevrons are horizontal, and
    // up/down belong to whatever has focus inside the preview — the scroll of a
    // long text file, the position of a video.
    if (e.key === "Escape") props.onClose();
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

  /** Text arrives decoded, everything else as a URL the tag can point at. */
  interface Loaded {
    text?: string;
    url?: string;
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

        <div class="min-h-0 flex-1 overflow-auto bg-bg-subtle">
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
                        <div class="flex h-full items-center justify-center p-4">
                          <img
                            src={loaded().url}
                            alt={props.entry.name}
                            class="max-h-full max-w-full object-contain"
                          />
                        </div>
                      </Show>

                      <Show when={kind() === "pdf"}>
                        {/* An `<object>` rather than an `<iframe>`: its children
                            are a real fallback, rendered when the engine has no
                            PDF viewer, which is the honest outcome on the
                            platforms that do not.
                            The hint below it is not redundant with that
                            fallback. Whether a given engine renders the
                            fallback or just paints an empty frame is its
                            business, and an empty modal with no text is the one
                            outcome the user cannot act on — worse than saying
                            "no preview for this". So the way out is stated
                            unconditionally, next to the viewer rather than
                            instead of it. */}
                        <object
                          data={loaded().url}
                          type="application/pdf"
                          class="h-full w-full"
                          aria-label={props.entry.name}
                        >
                          <Notice text={t()("preview.no_pdf_viewer")} />
                        </object>
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
          <Show when={kind() === "pdf" && !tooBig()}>
            <span class="min-w-0 flex-1 truncate text-xs text-fg-muted">
              {t()("preview.pdf_hint")}
            </span>
          </Show>
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
