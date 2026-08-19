/**
 * Whether a name the user is typing can be used, answered while they type.
 *
 * The character and length rule is the same one the backend enforces in
 * `crates/adx-core/src/name.rs`; this copy exists so the dialog can grey out its
 * button on the keystroke rather than after a round trip to the device. Two
 * implementations of one rule is an invariant, not a coincidence: both are
 * pinned by the same vectors — `names_the_frontend_also_pins` there,
 * "matches the Rust rule" in `names.test.ts` here. The backend stays the
 * enforcing side; a name that slips past this one is still refused there.
 *
 * The "already taken" half has no counterpart in the backend, and deliberately:
 * answering it there costs a folder listing over USB, and the listing is
 * already on screen.
 */

import type { AdxError } from "@/ipc/types";

/** Mirrors `MAX_NAME_CHARS`. Characters, not bytes: MTP names are UTF-16, so a
 *  byte limit would refuse a Cyrillic name half the length of a passing ASCII
 *  one. */
export const MAX_NAME_CHARS = 254;

/** The error kinds a name can fail with — a subset of `AdxError["kind"]`, so
 *  the dialog reuses the `errors.*` strings already written for the backend's
 *  version of the same refusal. */
export type NameProblem = Extract<
  AdxError["kind"],
  "name_invalid" | "name_too_long" | "name_taken"
>;

/**
 * `null` when the name is usable.
 *
 * An empty name reports nothing: the field starts empty and every dialog keeps
 * its confirm button disabled until something is typed, so complaining about it
 * would put a red line under a field the user has not touched yet.
 *
 * `taken` holds the names already in the target folder. Comparison is
 * case-sensitive, which is the conservative direction: Android's storage is
 * usually case-insensitive but MTP does not say so, and a false "already taken"
 * blocks a legal name while a missed one is simply answered by the device.
 */
export function checkName(
  name: string,
  taken: readonly string[] = [],
  /** The current name when renaming — keeping a name is not a collision. */
  self?: string,
): NameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return null;

  // Separator before length: an over-long name is fixed by trimming it, a
  // separator is not, and reporting the unfixable problem first sends the user
  // to retype rather than to count characters.
  if (/[/\\\0]/.test(trimmed)) return "name_invalid";
  if ([...trimmed].length > MAX_NAME_CHARS) return "name_too_long";
  if (trimmed !== self && taken.includes(trimmed)) return "name_taken";
  return null;
}
