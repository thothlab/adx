/**
 * Which rows a drag carries.
 *
 * Pure and separate for the same reason the selection rules are: the rule is
 * one sentence and three edge cases, and inside a mouse handler none of them
 * are reachable from a test.
 */

import type { EntryDto } from "@/ipc/types";

/**
 * The rows to hand to the system when a drag starts on `clicked`.
 *
 * Dragging a row that is part of the selection takes the whole selection —
 * that is what makes "select five files, drag them out" work. Dragging a row
 * outside it takes just that row, and the caller moves the selection there:
 * the alternative, dragging rows the user cannot see any mark on, copies
 * things nobody asked for.
 */
export function rowsForDrag(
  entries: readonly EntryDto[],
  picked: ReadonlySet<string>,
  clicked: EntryDto,
): EntryDto[] {
  if (!picked.has(clicked.handle)) return [clicked];
  // In display order, not selection order: the drag image and the order files
  // land in follow the list the user is looking at.
  const rows = entries.filter((e) => picked.has(e.handle));
  return rows.length ? rows : [clicked];
}

/**
 * How far the pointer must travel with the button down before this counts as a
 * drag rather than a click, in px.
 *
 * Not zero, and not one: a plain click moves the pointer by a pixel or two on
 * the way down, and a listing where every click risks starting a drag is a
 * listing where selecting a file is a gamble.
 */
export const DRAG_THRESHOLD = 6;

/** True once the pointer has moved far enough from where the button went down. */
export function pastThreshold(fromX: number, fromY: number, toX: number, toY: number): boolean {
  return Math.hypot(toX - fromX, toY - fromY) >= DRAG_THRESHOLD;
}
