import { describe, expect, it } from "vitest";
import type { EntryDto } from "@/ipc/types";
import { DRAG_THRESHOLD, pastThreshold, rowsForDrag } from "./drag";

const entry = (handle: string, name = handle): EntryDto => ({
  handle,
  name,
  size: 0,
  isFolder: false,
  modified: null,
});

const ROWS = [entry("a"), entry("b"), entry("c"), entry("d")];
const names = (rows: EntryDto[]) => rows.map((r) => r.handle);

describe("rowsForDrag", () => {
  it("takes the whole selection when the dragged row is part of it", () => {
    const picked = new Set(["b", "d"]);
    expect(names(rowsForDrag(ROWS, picked, ROWS[1]))).toEqual(["b", "d"]);
  });

  it("takes only the dragged row when it is outside the selection", () => {
    const picked = new Set(["b", "d"]);
    expect(names(rowsForDrag(ROWS, picked, ROWS[2]))).toEqual(["c"]);
  });

  it("hands rows over in display order, not in the order they were picked", () => {
    const picked = new Set(["d", "a"]);
    expect(names(rowsForDrag(ROWS, picked, ROWS[3]))).toEqual(["a", "d"]);
  });

  /** A handle can name a row that is no longer listed — a refresh under the
   *  pointer is enough. Dragging nothing at all would be a drag that silently
   *  does not start. */
  it("falls back to the dragged row when the selection matches nothing on screen", () => {
    const picked = new Set(["gone", "x"]);
    expect(names(rowsForDrag(ROWS, picked, ROWS[0]))).toEqual(["a"]);
  });
});

describe("pastThreshold", () => {
  it("ignores the pixel or two a plain click drifts by", () => {
    expect(pastThreshold(100, 100, 102, 101)).toBe(false);
    expect(pastThreshold(100, 100, 100, 100)).toBe(false);
  });

  it("triggers once the pointer has really moved, in any direction", () => {
    expect(pastThreshold(100, 100, 100, 100 + DRAG_THRESHOLD)).toBe(true);
    expect(pastThreshold(100, 100, 100 - DRAG_THRESHOLD, 100)).toBe(true);
  });
});
