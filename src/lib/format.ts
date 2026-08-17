/**
 * Formatting helpers shared by the listing, the storage panel and the job row.
 *
 * Kept out of components so the rounding rules are stated once: a file that
 * reads "1.2 GB" in the listing and "1.18 GB" in the progress row looks like
 * two different files.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Human-readable byte count, base 1024.
 *
 * Sub-kilobyte values keep no decimals (there is no such thing as 12.3 bytes);
 * everything above shows one, which is the resolution a progress bar can
 * actually change at without flickering.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} ${UNITS[0]}`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** `0` when the total is unknown or zero, so a progress bar never renders NaN. */
export function fraction(done: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}
