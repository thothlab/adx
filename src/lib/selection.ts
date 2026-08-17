/**
 * Row selection rules for the file listing.
 *
 * Pure and separate from the component because the interesting behaviour is
 * entirely in the state transitions — Shift ranges measured from an anchor,
 * Cmd toggles that move it, a Shift with no anchor to measure from — and none
 * of that is reachable from a test once it lives inside JSX handlers.
 */

/** What the user did to a row. */
export interface ClickModifiers {
  /** Shift: extend from the anchor to this row. */
  shift: boolean;
  /** Cmd on macOS, Ctrl elsewhere: add or remove this row. */
  additive: boolean;
}

export interface Selection {
  picked: Set<string>;
  /**
   * The row a Shift-range is measured from. Held separately from `picked`
   * because a `Set` has no "last clicked" — deriving the range endpoint from
   * its iteration order works until the first toggle reorders it.
   */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { picked: new Set(), anchor: null };

/**
 * The selection after clicking `clicked`, given the rows currently on screen
 * in display order.
 *
 * `rows` must be the handles as listed, because a range is a range of *rows*.
 * Order of insertion into the set is not order on screen.
 */
export function afterClick(
  rows: string[],
  current: Selection,
  clicked: string,
  modifiers: ClickModifiers,
): Selection {
  const index = rows.indexOf(clicked);
  if (index < 0) return current;

  if (modifiers.shift) {
    const from = current.anchor === null ? -1 : rows.indexOf(current.anchor);
    // Nothing to measure from — the anchor was never set, or the row it named
    // is gone. A Shift-click then behaves as a plain click rather than doing
    // nothing, which is what every file manager does.
    if (from < 0) return { picked: new Set([clicked]), anchor: clicked };

    const [lo, hi] = from <= index ? [from, index] : [index, from];
    const picked = new Set<string>();
    for (let i = lo; i <= hi; i += 1) picked.add(rows[i]);
    // The anchor stays where it was, so repeated Shift-clicks grow and shrink
    // one range instead of walking it down the list.
    return { picked, anchor: current.anchor };
  }

  if (modifiers.additive) {
    const picked = new Set(current.picked);
    if (picked.has(clicked)) picked.delete(clicked);
    else picked.add(clicked);
    return { picked, anchor: clicked };
  }

  return { picked: new Set([clicked]), anchor: clicked };
}

export function selectAll(rows: string[]): Selection {
  return { picked: new Set(rows), anchor: rows.length ? rows[rows.length - 1] : null };
}
