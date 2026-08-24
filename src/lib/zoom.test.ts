import { describe, expect, it } from "vitest";
import { canZoomIn, canZoomOut, FIT, zoomIn, zoomOut, ZOOM_STEPS, zoomPercent } from "./zoom";

describe("zoom steps", () => {
  it("walks the ladder in both directions", () => {
    expect(zoomIn(FIT)).toBe(1.25);
    expect(zoomIn(1.5)).toBe(2);
    expect(zoomOut(FIT)).toBe(0.75);
    expect(zoomOut(0.75)).toBe(0.5);
  });

  /** A button that keeps working past the end of the ladder would let the user
   *  zoom to a place the ladder cannot express, and the label would then show a
   *  value no click can return to. */
  it("stops at both ends instead of running off them", () => {
    const top = ZOOM_STEPS[ZOOM_STEPS.length - 1];
    const bottom = ZOOM_STEPS[0];
    expect(zoomIn(top)).toBe(top);
    expect(zoomOut(bottom)).toBe(bottom);
    expect(canZoomIn(top)).toBe(false);
    expect(canZoomOut(bottom)).toBe(false);
    expect(canZoomIn(FIT)).toBe(true);
    expect(canZoomOut(FIT)).toBe(true);
  });

  /** A value from outside the ladder — a pinch that landed between steps, a
   *  stale value from an older build — must still lead somewhere sensible. */
  it("finds its place from a value that is not on the ladder", () => {
    expect(zoomIn(1.1)).toBe(1.25);
    expect(zoomOut(1.1)).toBe(1);
    expect(zoomIn(9)).toBe(4);
    expect(zoomOut(0.1)).toBe(0.5);
  });

  it("labels the step as a percentage of the fitted size", () => {
    expect(zoomPercent(FIT)).toBe(100);
    expect(zoomPercent(1.25)).toBe(125);
    expect(zoomPercent(0.75)).toBe(75);
  });
});
