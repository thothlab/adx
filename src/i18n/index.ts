/**
 * App-wide i18n on `@solid-primitives/i18n`.
 *
 *   import { t } from "@/i18n";
 *   <button>{t()("devices.refresh")}</button>
 *
 * `t` is a memo: calling `t()` inside JSX subscribes the component to the
 * locale signal, so switching language re-renders without a restart (a PRD
 * acceptance criterion). Keys are dot paths into the flattened dictionary.
 *
 * Default is Russian — the user of this app works in Russian; English is one
 * click away and the choice persists in localStorage.
 */

import { createMemo, createSignal } from "solid-js";
import * as i18n from "@solid-primitives/i18n";

import en from "./en";
import ru from "./ru";

export type Locale = "en" | "ru";

export const LOCALES: { code: Locale; label: string }[] = [
  { code: "ru", label: "Русский" },
  { code: "en", label: "English" },
];

const DEFAULT_LOCALE: Locale = "ru";
const STORAGE_KEY = "adx:locale";

// Flattened once at module load — dictionaries are static, so each lookup is a
// single map hit instead of walking nested objects.
const dictionaries = {
  en: i18n.flatten(en),
  ru: i18n.flatten(ru),
};

function loadLocale(): Locale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "ru") return raw;
  } catch {
    /* private mode / no storage — fall through to the default */
  }
  return DEFAULT_LOCALE;
}

const [locale, setLocaleSignal] = createSignal<Locale>(loadLocale());

export { locale };

export function setLocale(next: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* swallow — the locale still changes in memory */
  }
  setLocaleSignal(next);
}

/** Reactive translator. Call as `t()(key, params?)` inside JSX.
 *  `resolveTemplate` is the load-bearing second argument: without it
 *  "{{free}} free of {{total}}" renders literally, braces and all. */
// The arrow below is the translator's own dictionary accessor: it is called
// from inside this memo's tracked scope, which is exactly how the locale signal
// reaches it. The lint rule can't see that through the library call.
export const t = createMemo(() =>
  // eslint-disable-next-line solid/reactivity
  i18n.translator(() => dictionaries[locale()], i18n.resolveTemplate),
);

/** Non-reactive one-off, for call sites outside JSX (thrown errors, logs). */
export function tr(key: string, params?: Record<string, string | number>): string {
  // Deliberately untracked — this is the escape hatch for call sites that
  // aren't components and have no reactive scope to belong to.
  // eslint-disable-next-line solid/reactivity
  const fn = i18n.translator(() => dictionaries[locale()], i18n.resolveTemplate);
  // The translator's type is templated on the dictionary's path set, which a
  // dynamic string can't satisfy. Reactive call sites keep full type safety;
  // this escape hatch exists for the non-JSX ones.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((fn as any)(key, params) as string) ?? key;
}

/** Exposed for the parity test. */
export const DICTIONARIES = dictionaries;
