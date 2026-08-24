/**
 * Zoom steps for the preview.
 *
 * # What 100 % means here
 *
 * Fitted to the window, not one image pixel per screen pixel. The preview is a
 * quick look at a file on a phone, and the question it answers is "what is
 * this" — for which the whole page or the whole photo, whatever its native
 * size, is the right starting point. A 1:1 default would open a 12-megapixel
 * photo at 400 % of the window and a scanned A4 at a third of it, which is two
 * different surprises for the same click.
 *
 * That is also why the fitted state is labelled rather than numbered: calling
 * it "100 %" on an image the window had to upscale would be a number that says
 * something untrue. Percentages appear once the user has stepped away from it,
 * where they mean what they say — relative to the fit.
 *
 * Pure and separate from the component for the usual reason: the interesting
 * part is the table and the clamping at both ends, and neither is reachable
 * from a test once it lives inside a click handler.
 */

/** Fitted to the window — where every file opens, and where "reset" returns. */
export const FIT = 1;

/**
 * The ladder, in multiples of the fitted size.
 *
 * Fixed steps rather than a factor per click: a factor makes the same button
 * mean different things at different points, and after four clicks the user
 * cannot say what they are looking at. Below the fit there are two steps, which
 * is enough to see a whole multi-column page at once and no more — zooming out
 * of a fitted image has nothing to reveal.
 */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** The next step up, or the same value at the top of the ladder. */
export function zoomIn(current: number): number {
  return ZOOM_STEPS.find((step) => step > current) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

/** The next step down, or the same value at the bottom. */
export function zoomOut(current: number): number {
  const below = ZOOM_STEPS.filter((step) => step < current);
  return below.length ? below[below.length - 1] : ZOOM_STEPS[0];
}

export function canZoomIn(current: number): boolean {
  return current < ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

export function canZoomOut(current: number): boolean {
  return current > ZOOM_STEPS[0];
}

/** The number to put next to a "%", relative to the fitted size. */
export function zoomPercent(current: number): number {
  return Math.round(current * 100);
}
