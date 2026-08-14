import { describe, expect, it } from "vitest";
import * as i18n from "@solid-primitives/i18n";
import en from "./en";
import ru from "./ru";

/**
 * A missing Russian key is already a compile error (`ru: Dict`). This guards the
 * other direction and the shape: an extra key, or a key present but left as the
 * English string, ships an untranslated interface that nothing else catches.
 */
describe("dictionaries", () => {
  // Flattened dictionaries are typed as an exact record of known key paths, so
  // indexing them with a loop variable needs a widening cast.
  // `i18n.flatten` keeps the intermediate objects alongside the dotted leaves
  // ({ app: {...}, "app.name": "ADX" }), so comparing raw key sets would pass
  // while comparing values would hand a regex an object. Leaves only.
  const leaves = (dict: typeof en): Record<string, string> =>
    Object.fromEntries(
      Object.entries(i18n.flatten(dict) as Record<string, unknown>).filter(
        ([, v]) => typeof v === "string",
      ),
    ) as Record<string, string>;

  const flatEn = leaves(en);
  const flatRu = leaves(ru);

  it("have the same key sets", () => {
    expect(Object.keys(flatRu).sort()).toEqual(Object.keys(flatEn).sort());
  });

  it("have no empty values", () => {
    for (const [key, value] of Object.entries(flatRu)) {
      expect(value, `ru.${key}`).not.toBe("");
    }
    for (const [key, value] of Object.entries(flatEn)) {
      expect(value, `en.${key}`).not.toBe("");
    }
  });

  it("use the same interpolation placeholders in both locales", () => {
    const placeholders = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).sort();
    for (const key of Object.keys(flatEn)) {
      expect(placeholders(flatRu[key]!), key).toEqual(
        placeholders(flatEn[key]!),
      );
    }
  });
});
