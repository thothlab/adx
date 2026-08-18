import { describe, expect, it } from "vitest";
import { clampWidth, DEFAULT_SIDEBAR, DEFAULT_TREE } from "./panes";

describe("clampWidth", () => {
  /** A panel dragged to zero cannot be dragged back — its handle is gone with
   *  it — so the clamp is what keeps the layout recoverable, not a nicety. */
  it("never lets a panel collapse or swallow the window", () => {
    expect(clampWidth(0)).toBeGreaterThanOrEqual(140);
    expect(clampWidth(-500)).toBeGreaterThanOrEqual(140);
    expect(clampWidth(5000)).toBeLessThanOrEqual(560);
  });

  it("keeps a width inside the range untouched, rounded to whole pixels", () => {
    expect(clampWidth(300)).toBe(300);
    expect(clampWidth(300.4)).toBe(300);
  });

  /** `NaN` reaches here from a corrupted localStorage entry or from a pointer
   *  event with no coordinates. Left unhandled it becomes `NaNpx` in the grid
   *  template, which browsers drop — the column then collapses to zero. */
  it("turns a non-number into the minimum rather than into NaN", () => {
    expect(clampWidth(Number.NaN)).toBe(140);
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBe(140);
  });

  it("ships with defaults that are inside the range", () => {
    expect(clampWidth(DEFAULT_SIDEBAR)).toBe(DEFAULT_SIDEBAR);
    expect(clampWidth(DEFAULT_TREE)).toBe(DEFAULT_TREE);
  });
});
