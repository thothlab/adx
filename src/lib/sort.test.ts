import { describe, expect, it } from "vitest";
import type { EntryDto } from "@/ipc/types";
import { DEFAULT_SORT, nextSort, type Sort, sortEntries } from "./sort";

let handle = 0;
const entry = (name: string, extra: Partial<EntryDto> = {}): EntryDto => ({
  handle: String((handle += 1)),
  name,
  size: 0,
  isFolder: false,
  modified: null,
  ...extra,
});

const folder = (name: string, extra: Partial<EntryDto> = {}) =>
  entry(name, { isFolder: true, ...extra });

const names = (list: EntryDto[]) => list.map((e) => e.name);
const sorted = (list: EntryDto[], sort: Sort) => names(sortEntries(list, sort));

describe("nextSort", () => {
  it("starts a newly clicked column ascending", () => {
    expect(nextSort(DEFAULT_SORT, "size")).toEqual({ key: "size", dir: "asc" });
    expect(nextSort({ key: "size", dir: "desc" }, "modified")).toEqual({
      key: "modified",
      dir: "asc",
    });
  });

  it("flips the column already sorted by", () => {
    const once = nextSort(DEFAULT_SORT, "name");
    expect(once).toEqual({ key: "name", dir: "desc" });
    expect(nextSort(once, "name")).toEqual({ key: "name", dir: "asc" });
  });
});

describe("sortEntries", () => {
  /** The signal holds the array being sorted — sorting it in place would leave
   *  its identity unchanged and Solid would skip the update. */
  it("returns a new array and leaves the given one alone", () => {
    const list = [entry("b"), entry("a")];
    const out = sortEntries(list, DEFAULT_SORT);
    expect(out).not.toBe(list);
    expect(names(list)).toEqual(["b", "a"]);
  });

  it("reproduces the backend order by default, so a fresh listing is untouched", () => {
    const list = [entry("beta.txt"), folder("Zeta"), entry("Alpha.txt"), folder("apps")];
    expect(sorted(list, DEFAULT_SORT)).toEqual(["apps", "Zeta", "Alpha.txt", "beta.txt"]);
  });

  it("keeps folders above files whichever way the arrow points", () => {
    const list = [entry("b.txt"), folder("a"), entry("a.txt"), folder("b")];
    expect(sorted(list, { key: "name", dir: "asc" })).toEqual(["a", "b", "a.txt", "b.txt"]);
    expect(sorted(list, { key: "name", dir: "desc" })).toEqual(["b", "a", "b.txt", "a.txt"]);
  });

  it("orders sizes as numbers, not as the text in the cell", () => {
    const list = [
      entry("big", { size: 1_000_000 }),
      entry("small", { size: 9 }),
      entry("middle", { size: 2048 }),
    ];
    expect(sorted(list, { key: "size", dir: "asc" })).toEqual(["small", "middle", "big"]);
    expect(sorted(list, { key: "size", dir: "desc" })).toEqual(["big", "middle", "small"]);
  });

  /** The cell reads "—" for a folder, but the device still reports a number for
   *  it, and on some devices it is not zero. Ordering the folder block by it
   *  would be the listing shuffling itself for no visible reason. */
  it("ignores the size a device reports for a folder", () => {
    const list = [folder("b", { size: 4096 }), folder("a", { size: 8192 }), folder("c")];
    expect(sorted(list, { key: "size", dir: "asc" })).toEqual(["a", "b", "c"]);
    expect(sorted(list, { key: "size", dir: "desc" })).toEqual(["a", "b", "c"]);
  });

  it("sorts dates chronologically in both directions", () => {
    const list = [
      entry("mid", { modified: "2026-05-14 14:17" }),
      entry("new", { modified: "2026-08-18 22:32" }),
      entry("old", { modified: "2025-09-12 22:56" }),
    ];
    expect(sorted(list, { key: "modified", dir: "asc" })).toEqual(["old", "mid", "new"]);
    expect(sorted(list, { key: "modified", dir: "desc" })).toEqual(["new", "mid", "old"]);
  });

  /** A dateless row has no position on a timeline; flipping the arrow must not
   *  float a block of "—" to the top of the newest-first view. */
  it("leaves rows without a date at the end whichever way the arrow points", () => {
    const list = [
      entry("undated"),
      entry("old", { modified: "2025-01-01 00:00" }),
      entry("new", { modified: "2026-01-01 00:00" }),
    ];
    expect(sorted(list, { key: "modified", dir: "asc" })).toEqual(["old", "new", "undated"]);
    expect(sorted(list, { key: "modified", dir: "desc" })).toEqual(["new", "old", "undated"]);
  });

  it("breaks ties by name ascending, so a flip only moves the clicked column", () => {
    const list = [entry("b", { size: 10 }), entry("a", { size: 10 }), entry("c", { size: 1 })];
    expect(sorted(list, { key: "size", dir: "asc" })).toEqual(["c", "a", "b"]);
    expect(sorted(list, { key: "size", dir: "desc" })).toEqual(["a", "b", "c"]);
  });

  /** Two names differing only in case must still have one order, or the same
   *  unchanged folder comes back looking reshuffled. */
  it("orders case-only differences deterministically", () => {
    const a = sortEntries([entry("File"), entry("file")], DEFAULT_SORT);
    const b = sortEntries([entry("file"), entry("File")], DEFAULT_SORT);
    expect(names(a)).toEqual(names(b));
  });
});
