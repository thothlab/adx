import { describe, expect, it } from "vitest";
import { afterClick, EMPTY_SELECTION, selectAll, type Selection } from "./selection";

const ROWS = ["a", "b", "c", "d", "e"];

const plain = { shift: false, additive: false };
const shift = { shift: true, additive: false };
const additive = { shift: false, additive: true };

const picked = (s: Selection) => ROWS.filter((r) => s.picked.has(r));

describe("afterClick", () => {
  it("replaces the selection on a plain click and remembers the row", () => {
    const s = afterClick(ROWS, EMPTY_SELECTION, "c", plain);
    expect(picked(s)).toEqual(["c"]);
    expect(s.anchor).toBe("c");
  });

  it("adds and removes with the modifier held", () => {
    let s = afterClick(ROWS, EMPTY_SELECTION, "b", plain);
    s = afterClick(ROWS, s, "d", additive);
    expect(picked(s)).toEqual(["b", "d"]);

    s = afterClick(ROWS, s, "b", additive);
    expect(picked(s)).toEqual(["d"]);
  });

  it("selects an inclusive range from the anchor", () => {
    let s = afterClick(ROWS, EMPTY_SELECTION, "b", plain);
    s = afterClick(ROWS, s, "d", shift);
    expect(picked(s)).toEqual(["b", "c", "d"]);
  });

  /** Dragging upwards is the same range. */
  it("selects the same range in either direction", () => {
    const down = afterClick(ROWS, afterClick(ROWS, EMPTY_SELECTION, "b", plain), "d", shift);
    const up = afterClick(ROWS, afterClick(ROWS, EMPTY_SELECTION, "d", plain), "b", shift);
    expect(picked(down)).toEqual(picked(up));
  });

  /**
   * The reason the anchor is a separate field: a second Shift-click must
   * re-measure from the original row, not from the end of the previous range.
   * Otherwise shrinking a selection is impossible.
   */
  it("keeps the anchor so a range can be resized", () => {
    let s = afterClick(ROWS, EMPTY_SELECTION, "b", plain);
    s = afterClick(ROWS, s, "e", shift);
    expect(picked(s)).toEqual(["b", "c", "d", "e"]);

    s = afterClick(ROWS, s, "c", shift);
    expect(picked(s)).toEqual(["b", "c"]);
    expect(s.anchor).toBe("b");
  });

  it("moves the anchor on a toggle so the next range starts there", () => {
    let s = afterClick(ROWS, EMPTY_SELECTION, "a", plain);
    s = afterClick(ROWS, s, "d", additive);
    expect(s.anchor).toBe("d");

    s = afterClick(ROWS, s, "e", shift);
    expect(picked(s)).toEqual(["d", "e"]);
  });

  it("treats a shift-click with no anchor as a plain click", () => {
    const s = afterClick(ROWS, EMPTY_SELECTION, "c", shift);
    expect(picked(s)).toEqual(["c"]);
    expect(s.anchor).toBe("c");
  });

  /** The folder was re-read and the anchored row is gone. */
  it("recovers when the anchor no longer exists", () => {
    const stale: Selection = { picked: new Set(["zz"]), anchor: "zz" };
    const s = afterClick(ROWS, stale, "c", shift);
    expect(picked(s)).toEqual(["c"]);
  });

  it("ignores a click on a row that is not listed", () => {
    const before = afterClick(ROWS, EMPTY_SELECTION, "b", plain);
    expect(afterClick(ROWS, before, "nope", plain)).toBe(before);
  });

  /**
   * Order of insertion is not order on screen: the range must come from the
   * row order handed in, so a set built by toggling in any sequence still
   * yields a contiguous range.
   */
  it("measures the range by row order, not by insertion order", () => {
    let s = afterClick(ROWS, EMPTY_SELECTION, "e", plain);
    s = afterClick(ROWS, s, "a", additive);
    s = afterClick(ROWS, s, "c", additive);
    // Anchor is now "c"; a shift-click on "a" must give a..c, not e..a.
    s = afterClick(ROWS, s, "a", shift);
    expect(picked(s)).toEqual(["a", "b", "c"]);
  });
});

describe("selectAll", () => {
  it("takes every row and anchors at the last one", () => {
    const s = selectAll(ROWS);
    expect(picked(s)).toEqual(ROWS);
    expect(s.anchor).toBe("e");
  });

  it("survives an empty folder", () => {
    const s = selectAll([]);
    expect(s.picked.size).toBe(0);
    expect(s.anchor).toBeNull();
  });
});
