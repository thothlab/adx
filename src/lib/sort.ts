/**
 * Column ordering for the file listing.
 *
 * Pure and separate from the component for the same reason `selection.ts` is:
 * the whole of the behaviour is in the comparison rules — which column, which
 * direction, and what happens to the rows a column has nothing to say about —
 * and none of that is reachable from a test once it lives in a click handler.
 *
 * Three rules hold in *both* directions. They are decisions, not oversights:
 *
 *  - Folders come first, always. The backend states that invariant for every
 *    listing it produces (`sort_entries` in `adx-mtp/src/session.rs`) and the
 *    tree is built on it; a reversed sort that scattered folders among the
 *    files would put the same folder in two different places depending on the
 *    arrow. Flipping the direction reverses the order *within* each group.
 *  - A row with no date sorts last. "Unknown" has no position on a timeline,
 *    and letting it flip would move a block of "—" to the top of the
 *    newest-first view — the one place nobody is looking for them.
 *  - The name is the tie-break, and it is always ascending. Two files of the
 *    same size keep their order relative to each other when the arrow flips,
 *    so only the column the user actually clicked changes.
 */

import type { EntryDto } from "@/ipc/types";

/** The three columns the listing shows, and the only things it sorts by. */
export type SortKey = "name" | "size" | "modified";

export type SortDir = "asc" | "desc";

export interface Sort {
  key: SortKey;
  dir: SortDir;
}

/**
 * Name, ascending — the order the device listing already arrives in.
 *
 * Chosen to match the backend rather than picked for taste: the first render
 * of every folder then re-orders nothing, and the listing agrees with the
 * folder tree until the user says otherwise.
 */
export const DEFAULT_SORT: Sort = { key: "name", dir: "asc" };

/** The sort after a click on a column header: a column that was not sorted by
 *  starts ascending, the one already sorted by flips. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) return { key, dir: "asc" };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/**
 * By name, case-insensitively, with the exact-case comparison behind it.
 *
 * The second comparison is not decoration: without it "File" and "file" tie,
 * and two reads of the same unchanged folder can come back in different
 * orders. The rule mirrors the backend's `sort_entries`, which is what makes
 * `DEFAULT_SORT` a no-op on freshly listed rows.
 */
function byName(a: EntryDto, b: EntryDto): number {
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0;
}

/** The clicked column alone — the only comparison the direction applies to. */
function byColumn(a: EntryDto, b: EntryDto, key: SortKey): number {
  switch (key) {
    case "size":
      // Folders are compared as sizeless. The cell reads "—" for them because a
      // folder has no size worth showing, but the device still reports *some*
      // number for an association, and on some devices it is not zero. Ordering
      // the folder block by a figure that appears nowhere on screen — and
      // reversing it when the arrow flips — would look like the listing
      // shuffling itself. Both rows are folders or both are files by the time
      // this runs, so testing one of them is testing the pair.
      return a.isFolder ? 0 : a.size - b.size;
    case "modified": {
      // Both dates are known by the time this runs, and the backend formats
      // them as `YYYY-MM-DD HH:MM` — fixed width, most significant part first.
      // String order is therefore chronological order, with nothing to parse.
      const da = a.modified ?? "";
      const db = b.modified ?? "";
      return da < db ? -1 : da > db ? 1 : 0;
    }
    case "name":
      return byName(a, b);
  }
}

/**
 * The rows in display order.
 *
 * Returns a new array — `Array.prototype.sort` sorts in place and hands back
 * the *same* reference, and the rows it is given are the ones already held by
 * a signal. Sorting them in place would leave the signal's identity unchanged,
 * so Solid would skip the update and the header click would look dead.
 */
export function sortEntries(entries: readonly EntryDto[], sort: Sort): EntryDto[] {
  const flip = sort.dir === "desc" ? -1 : 1;

  return [...entries].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;

    if (sort.key === "modified") {
      const known = (a.modified === null ? 0 : 1) - (b.modified === null ? 0 : 1);
      if (known !== 0) return -known;
    }

    return flip * byColumn(a, b, sort.key) || byName(a, b);
  });
}
