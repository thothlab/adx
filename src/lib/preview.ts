/**
 * What a double-click on a file should show.
 *
 * By extension, not by content sniffing: the listing has the name and nothing
 * else, and deciding by content would mean pulling bytes off the device before
 * knowing whether there is any point — a device round trip per double-click on
 * a 4 GB video.
 *
 * Pure and separate from the component because the interesting part is entirely
 * in the table: which extensions are worth opening, and what the size ceiling
 * is for each. None of that is reachable from a test once it lives inside JSX.
 */

export type PreviewKind = "image" | "pdf" | "text";

/**
 * Formats the webview renders natively. HEIC is included because Safari's
 * engine decodes it on macOS — where most Android photos taken by an iPhone
 * user end up — and it simply fails to load elsewhere, which the preview
 * already handles as "cannot show this".
 */
const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif", "ico"];

/** Anything a plain `<pre>` can show. Deliberately generous: a file the user
 *  can read as text is one they can check without copying it off the phone. */
const TEXT = [
  "txt", "md", "markdown", "log", "json", "xml", "csv", "tsv", "yml", "yaml", "ini", "conf",
  "cfg", "toml", "properties", "srt", "vtt", "sh", "bat", "ps1", "py", "js", "ts", "jsx", "tsx",
  "css", "html", "htm", "java", "kt", "kts", "rs", "go", "c", "h", "cpp", "hpp", "sql", "gradle",
];

/**
 * Ceilings per kind, in bytes.
 *
 * A text file is truncated at its ceiling and still shown — the first megabyte
 * of a log answers most questions. An image or a PDF is useless truncated, so
 * over the ceiling the preview refuses and points at the download instead.
 */
export const PREVIEW_LIMITS: Record<PreviewKind, number> = {
  image: 32 * 1024 * 1024,
  pdf: 64 * 1024 * 1024,
  text: 1024 * 1024,
};

/** Whether the kind can be shown from a partial read. */
export function isTruncatable(kind: PreviewKind): boolean {
  return kind === "text";
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // `dot > 0`, not `>= 0`: a leading dot is a hidden file, not an extension —
  // ".gitignore" is text by luck, ".bashrc" would be nothing at all.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** What to show for this file name, or `null` when nothing sensible can be. */
export function previewKind(name: string): PreviewKind | null {
  const ext = extensionOf(name);
  if (!ext) return null;
  if (IMAGE.includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (TEXT.includes(ext)) return "text";
  return null;
}

/** MIME type for the Blob, which is what makes the webview render it rather
 *  than offer to save it. */
export function mimeOf(kind: PreviewKind, name: string): string {
  if (kind === "pdf") return "application/pdf";
  if (kind === "text") return "text/plain; charset=utf-8";

  const ext = extensionOf(name);
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "ico") return "image/x-icon";
  if (ext === "heic" || ext === "heif") return `image/${ext}`;
  return `image/${ext}`;
}
