import { type Component, createResource, onCleanup, Show } from "solid-js";
import { AlertCircle, X } from "lucide-solid";
import { t } from "@/i18n";
import { api, asAdxError } from "@/ipc/client";
import type { EntryDto } from "@/ipc/types";
import { formatBytes } from "@/lib/format";
import { isTruncatable, mimeOf, previewKind, PREVIEW_LIMITS } from "@/lib/preview";
import { Button } from "@/components/Modal";

/**
 * A quick look at a file without copying it off the device.
 *
 * # Why a blob and not a data URL
 *
 * A `data:` URL carries the whole file as base64 inside the document — a third
 * larger than the bytes, re-parsed on every render, and pinned for as long as
 * the string is referenced. A `blob:` URL is a handle to memory the browser
 * already holds, and it is released the moment this component goes away. The
 * CSP in `tauri.conf.json` lists `blob:` for `img-src`, `frame-src` and
 * `object-src` for exactly this.
 *
 * # Why the size ceiling is checked before the read, not after
 *
 * The listing already knows how big the file is. Asking the device for a 4 GB
 * video and then deciding it cannot be shown costs minutes of USB traffic to
 * learn something that was on screen the whole time.
 */
const Preview: Component<{ entry: EntryDto; storageId: string; onClose: () => void }> = (props) => {
  // Read once. The modal is opened for one file and closed again, and a
  // reactive re-read here would re-fetch on any listing refresh that happens to
  // touch the row underneath.
  // eslint-disable-next-line solid/reactivity
  const entry = props.entry;
  // eslint-disable-next-line solid/reactivity
  const kind = previewKind(entry.name);

  const limit = kind ? PREVIEW_LIMITS[kind] : 0;
  const tooBig = !!kind && !isTruncatable(kind) && entry.size > limit;

  // Escape closes it. Registered on `document` rather than on the overlay,
  // because the overlay only has focus if the user has clicked into it — and
  // the modal opens from a double-click on a row, which leaves focus on the
  // listing behind it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  let objectUrl: string | null = null;
  // Registered synchronously, not inside the resource's `then`: by the time a
  // promise resolves there is no reactive owner left and `onCleanup` silently
  // does nothing — the leak this project already paid for once (commit
  // 1c85d97). The variable is what the cleanup closes over.
  onCleanup(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  /** Text arrives decoded, everything else as a URL the tag can point at. */
  interface Loaded {
    text?: string;
    url?: string;
    truncated: boolean;
  }

  const [content] = createResource<Loaded | null>(async () => {
    if (!kind || tooBig) return null;

    const bytes = await api.entries.read(props.storageId, entry.handle, limit);

    if (kind === "text") {
      // Lossy on purpose: a file that is not valid UTF-8 must show mojibake,
      // which tells the user what it is, rather than throw and show nothing.
      return { text: new TextDecoder("utf-8").decode(bytes), truncated: entry.size > limit };
    }

    objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeOf(kind, entry.name) }));
    return { url: objectUrl, truncated: false };
  });

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl">
        <header class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{entry.name}</span>
          <span class="shrink-0 text-xs text-fg-muted">{formatBytes(entry.size)}</span>
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
            when={kind && !tooBig}
            fallback={
              <Notice
                text={tooBig ? t()("preview.too_big", { size: formatBytes(limit) }) : t()("preview.unsupported")}
              />
            }
          >
            <Show when={!content.loading} fallback={<Notice text={t()("preview.loading")} />}>
              <Show when={!content.error} fallback={<Notice text={asAdxError(content.error).message} error />}>
                <Show when={content()}>
                  {(loaded) => (
                    <>
                      <Show when={loaded().truncated}>
                        <div class="border-b border-border bg-warn/10 px-3 py-1.5 text-xs text-warn">
                          {t()("preview.truncated", { size: formatBytes(limit) })}
                        </div>
                      </Show>

                      <Show when={kind === "image"}>
                        <div class="flex h-full items-center justify-center p-4">
                          <img
                            src={loaded().url}
                            alt={entry.name}
                            class="max-h-full max-w-full object-contain"
                          />
                        </div>
                      </Show>

                      <Show when={kind === "pdf"}>
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
                          aria-label={entry.name}
                        >
                          <Notice text={t()("preview.no_pdf_viewer")} />
                        </object>
                      </Show>

                      <Show when={kind === "text"}>
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
          <Show when={kind === "pdf" && !tooBig}>
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
