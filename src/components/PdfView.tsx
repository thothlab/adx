import { type Component, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { t } from "@/i18n";

/**
 * PDF pages, drawn by us rather than by the engine.
 *
 * # Why not `<object type="application/pdf">`
 *
 * Because whether that works is the operating system's opinion, not ours. It
 * renders on one macOS and paints an empty frame on another — and "empty
 * frame" is the worst of the possible outcomes, because the `<object>` counts
 * as loaded and its fallback children never appear, so the app cannot even say
 * that it failed. Reported from a second machine on 1.0.5, with the same build
 * that works here.
 *
 * pdf.js costs about a third of a megabyte compressed and removes the question
 * entirely: the same pages, drawn the same way, on every system the app ships
 * to. It also makes the zoom real — each step re-renders the page at the new
 * scale instead of stretching pixels that were already drawn, which is what the
 * previous implementation was reduced to.
 *
 * # What is deliberately not here
 *
 * No text layer, no search, no thumbnails, no annotations. This is a quick look
 * at a file on a phone; anything more is what "copy it to the computer" is for,
 * and every one of those features costs another surface to keep working.
 */

// The worker is bundled by Vite as an ordinary same-origin asset, which is what
// keeps it inside the window's `script-src 'self'`. Set explicitly, because the
// library's fallback is to build one from a `blob:` URL — allowed by the policy
// but pointlessly close to its edge.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Horizontal padding of the page column, in px — `p-4` on both sides. */
const PADDING = 32;

const PdfView: Component<{ bytes: ArrayBuffer; scale: number }> = (props) => {
  /**
   * Width available for a page, tracked because the scale is relative to it.
   *
   * "100 %" in this app means *fitted to the window*, not one PDF point per
   * pixel — a scanned A4 and a slide deck open at the size of the box either
   * way, which is what a quick look is for. So the ladder is a multiplier on
   * the fit, and the fit needs the width. Watched rather than read once: the
   * window is resizable, and a page that keeps a scale computed for the old
   * width is a page that no longer fits.
   */
  const [available, setAvailable] = createSignal(0);

  const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
  onCleanup(() => observer.disconnect());
  const measure = (el: HTMLDivElement) => {
    observer.observe(el);
    setAvailable(el.clientWidth);
  };

  /**
   * Parsed once per file, not once per zoom step: reading the document is the
   * expensive half, and the scale only changes how pages are drawn from it.
   *
   * The buffer is copied because `getDocument` takes ownership of what it is
   * given — it transfers it to the worker, leaving the original detached. The
   * preview keeps those bytes for the life of the modal, and a second look at
   * the same file would otherwise find an empty buffer.
   */
  let task: pdfjs.PDFDocumentLoadingTask | undefined;

  const [doc] = createResource(
    () => props.bytes,
    // eslint-disable-next-line solid/reactivity
    async (bytes) => {
      // The previous document goes first: paging through a folder of PDFs
      // otherwise leaves a worker and a parsed file per document looked at.
      await task?.destroy();
      task = pdfjs.getDocument({
        data: bytes.slice(0),
        // Substitution data for fonts the document does not carry itself.
        // Without it pdf.js does not fail — it draws the page and silently
        // leaves the text out, which is a white page with nothing to explain
        // it. Real documents rely on this constantly: a "standard" font like
        // Helvetica is expected to be supplied by the viewer, and a
        // non-embedded CID font needs the character maps as well.
        standardFontDataUrl: "pdfjs/standard_fonts/",
        cMapUrl: "pdfjs/cmaps/",
        cMapPacked: true,
      });
      return await task.promise;
    },
  );

  onCleanup(() => void task?.destroy());

  return (
    <Show
      when={!doc.loading}
      fallback={<div class="p-6 text-center text-xs text-fg-muted">{t()("preview.loading")}</div>}
    >
      <Show
        when={!doc.error}
        fallback={
          <div class="p-6 text-center text-xs text-danger">{t()("preview.pdf_broken")}</div>
        }
      >
        {/* `w-max` with `min-w-full`, not `items-center` on a fixed width: a
            centred item wider than its box overflows to both sides, and the
            left half cannot be scrolled back to — the page is simply cut off,
            which is what the first version of this did. */}
        {/* Two boxes, and the outer one is the one that gets measured: it is
            as wide as the viewport and stays that way. Measuring the inner
            column instead makes the width chase itself — the column is as wide
            as its widest page, the page is sized from the measurement, and each
            render feeds the next. That loop drew nothing at all. */}
        <Show when={doc()}>
          {(pdf) => (
            <div ref={measure} class="w-full">
              <div class="flex w-max min-w-full flex-col items-center gap-3 p-4">
                <For each={Array.from({ length: pdf().numPages }, (_, i) => i + 1)}>
                  {(number) => (
                    <Page doc={pdf()} number={number} scale={props.scale} available={available()} />
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </Show>
  );
};

/**
 * One page, drawn when it comes into view and re-drawn when the scale changes.
 *
 * Lazily, because a scanned document runs to hundreds of pages and rendering
 * them all on open would freeze the window for the sake of pages nobody has
 * scrolled to. The placeholder keeps the page's real size from the start, so
 * the scrollbar tells the truth before anything is drawn and the view does not
 * jump as pages arrive.
 */
const Page: Component<{
  doc: pdfjs.PDFDocumentProxy;
  number: number;
  /** Steps of the ladder, where 1 is "fitted to the window". */
  scale: number;
  /** Width the page has to fit into, in CSS px. */
  available: number;
}> = (props) => {
  /**
   * The first page is drawn without waiting to be noticed.
   *
   * Not an optimisation — a correctness fix. The observer below watches a box
   * that has no size until its own render has computed one, and an element of
   * zero area is not reliably reported as visible: one WebKit says yes, another
   * says no and never revisits the question. The result was a white rectangle
   * of exactly the right size with nothing drawn in it, reported from a second
   * machine while this one was fine. A page the user is looking at must not
   * depend on that answer.
   */
  // eslint-disable-next-line solid/reactivity -- the page number of a given
  // instance never changes: `<For>` creates one per page and keys them by it.
  const [visible, setVisible] = createSignal(props.number === 1);
  const [failure, setFailure] = createSignal<string | null>(null);
  let canvas: HTMLCanvasElement | undefined;

  const observer = new IntersectionObserver(
    (entries) => {
      // One-way: a page that has been drawn stays drawn. Freeing the canvas of
      // a page that scrolled away would save memory this app does not need to
      // save, and pay for it with a blank flash on every scroll back.
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    },
    // Ahead of the viewport, so scrolling meets finished pages rather than
    // watching them appear.
    { rootMargin: "600px" },
  );

  onCleanup(() => observer.disconnect());

  const mount = (el: HTMLDivElement) => observer.observe(el);

  /** Placeholder size, so the layout is right before the first paint. */
  const [size, setSize] = createSignal({ width: 0, height: 0 });

  /** The render in flight, cancelled by the next one. */
  let pending: pdfjs.RenderTask | undefined;
  onCleanup(() => pending?.cancel());

  createResource(
    () => ({ scale: props.scale, available: props.available, ready: visible() }),
    // eslint-disable-next-line solid/reactivity
    async ({ scale, available, ready }) => {
      try {
        return await draw({ scale, available, ready });
      } catch (e) {
        // Said out loud, in the page's own box. A render that fails silently is
        // the exact failure this component was written to remove: an empty
        // rectangle tells the user nothing and tells us less.
        const message = e instanceof Error ? e.message : String(e);
        if (!message.toLowerCase().includes("cancel")) setFailure(message);
        return null;
      }
    },
  );

  const draw = async ({
    scale,
    available,
    ready,
  }: {
    scale: number;
    available: number;
    ready: boolean;
  }) => {
    const page = await props.doc.getPage(props.number);
    // The fit first, the ladder on top of it. `PADDING` is the padding of the
    // column above, which is not available to the page.
    const natural = page.getViewport({ scale: 1 });
    const fit = available > PADDING ? (available - PADDING) / natural.width : 1;
    const viewport = page.getViewport({ scale: fit * scale });
    setSize({ width: viewport.width, height: viewport.height });
    if (!ready || !canvas) return null;

    // Drawn at the screen's real pixel density and shown at CSS size: a page
    // rendered at 1x on a retina display is soft in exactly the way the old
    // implementation was, which is the thing this is here to fix.
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return null;

    setFailure(null);
    // A zoom step while a page is still drawing would otherwise leave two
    // renders writing into the same canvas, and the slower one wins. Held in a
    // variable the next run cancels, rather than in `onCleanup`: after an
    // `await` there is no reactive owner left to register with, and the cleanup
    // would silently never run.
    pending?.cancel();
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });
    pending = task;
    await task.promise;
    pending = undefined;
    return true;
  };

  return (
    <div
      ref={mount}
      class="shadow-sm"
      style={{
        width: `${size().width}px`,
        height: `${size().height}px`,
        "background-color": "white",
      }}
    >
      <canvas ref={canvas} style={{ width: `${size().width}px`, height: `${size().height}px` }} />
      <Show when={failure()}>
        {(message) => (
          <div class="p-4 text-center text-xs text-danger">
            {t()("preview.pdf_page_failed", { error: message() })}
          </div>
        )}
      </Show>
    </div>
  );
};

export default PdfView;
