/**
 * Theme — light / dark / system.
 *
 * Persisted in localStorage (`adx:theme`). System mode follows
 * `prefers-color-scheme` and re-evaluates when the OS appearance flips.
 * Side effect: toggles `.dark` on `<html>`, which is what engages both
 * Tailwind's `dark:` variants and the CSS-var overrides in `styles/index.css`.
 *
 * Importing this module installs the effect — see `main.tsx`.
 */

import { createEffect, createSignal } from "solid-js";

export type Theme = "light" | "dark" | "system";

/** Every theme, in the order both the settings dialog lists them and the
 *  footer button cycles them. One list: two orders that drifted apart would
 *  make the same app disagree with itself about what comes after "light". */
export const THEMES: readonly Theme[] = ["light", "dark", "system"];

const STORAGE_KEY = "adx:theme";

function loadStored(): Theme {
  // `typeof localStorage === "undefined"` is not enough of a guard: Node 25
  // exposes a global `localStorage` stub that throws on `getItem` unless the
  // process was started with `--localstorage-file`. That turned a pure-logic
  // unit test into a module-load crash, so the access is wrapped instead.
  try {
    const v = localStorage?.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

const [themeSignal, setThemeSignal] = createSignal<Theme>(loadStored());
export const theme = themeSignal;

const [osDark, setOsDark] = createSignal(
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
);

if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    setOsDark(e.matches);
  });
}

/** Pure resolution rule, kept separate from the signals so it is testable
 *  without a DOM or a live `matchMedia`. */
export function resolveTheme(t: Theme, systemPrefersDark: boolean): "light" | "dark" {
  if (t !== "system") return t;
  return systemPrefersDark ? "dark" : "light";
}

export function effectiveTheme(): "light" | "dark" {
  return resolveTheme(theme(), osDark());
}

export function setTheme(t: Theme): void {
  setThemeSignal(t);
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* private mode / disabled storage — keep it in memory */
  }
}

export function cycleTheme(): void {
  setTheme(THEMES[(THEMES.indexOf(theme()) + 1) % THEMES.length]!);
}

createEffect(() => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", effectiveTheme() === "dark");
});
