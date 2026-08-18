/**
 * Widths of the two resizable columns — devices/storage on the left, the folder
 * tree next to it. The listing takes whatever is left.
 *
 * Persisted, because a pane width is a decision the user makes about their
 * screen and their file names, not about this session: a tree panel widened to
 * read long folder names that snaps back on the next launch has to be widened
 * again every launch.
 */

import { createSignal } from "solid-js";

export const DEFAULT_SIDEBAR = 240;
export const DEFAULT_TREE = 240;

/** Below this a panel shows a column of clipped ellipses and cannot be grabbed
 *  back by its own content — only the handle can rescue it, so the handle must
 *  never be pushed off screen either. */
const MIN = 140;
const MAX = 560;

const STORAGE_KEY = "adx:panes";

export function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return MIN;
  return Math.min(MAX, Math.max(MIN, Math.round(px)));
}

interface Stored {
  sidebar: number;
  tree: number;
}

function loadStored(): Stored {
  // Wrapped rather than guarded by `typeof`: Node 25 defines a global
  // `localStorage` whose methods throw, which already took down a test file
  // once (see `stores/theme.ts`).
  try {
    const raw = localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { sidebar: DEFAULT_SIDEBAR, tree: DEFAULT_TREE };
    const parsed: unknown = JSON.parse(raw);
    const read = (key: keyof Stored, fallback: number) => {
      const value = (parsed as Record<string, unknown>)?.[key];
      return typeof value === "number" ? clampWidth(value) : fallback;
    };
    return { sidebar: read("sidebar", DEFAULT_SIDEBAR), tree: read("tree", DEFAULT_TREE) };
  } catch {
    return { sidebar: DEFAULT_SIDEBAR, tree: DEFAULT_TREE };
  }
}

const stored = loadStored();
const [sidebarWidth, setSidebarSignal] = createSignal(stored.sidebar);
const [treeWidth, setTreeSignal] = createSignal(stored.tree);

/** True while a handle is being dragged. The shell turns off text selection for
 *  the duration — without it a drag across the listing paints the browser's own
 *  blue selection over the rows it passes. */
const [resizing, setResizing] = createSignal(false);

export { resizing, sidebarWidth, treeWidth };

function persist(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sidebar: sidebarWidth(), tree: treeWidth() }),
    );
  } catch {
    /* private mode / disabled storage — keep it for this session only */
  }
}

export function setSidebarWidth(px: number): void {
  setSidebarSignal(clampWidth(px));
  persist();
}

export function setTreeWidth(px: number): void {
  setTreeSignal(clampWidth(px));
  persist();
}

export function beginResize(): void {
  setResizing(true);
}

export function endResize(): void {
  setResizing(false);
}

/** Double-clicking a handle puts its panel back to the width it shipped with. */
export function resetSidebarWidth(): void {
  setSidebarWidth(DEFAULT_SIDEBAR);
}

export function resetTreeWidth(): void {
  setTreeWidth(DEFAULT_TREE);
}
