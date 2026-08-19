import { describe, expect, it } from "vitest";
import { checkName, MAX_NAME_CHARS } from "./names";

describe("checkName", () => {
  it("passes ordinary names", () => {
    expect(checkName("photo.jpg")).toBeNull();
    expect(checkName("Отпуск 2026")).toBeNull();
  });

  /**
   * An untouched field is not a complaint. The confirm button is disabled while
   * the field is empty, so a message here would only put a red line under
   * something the user has not typed in yet.
   */
  it("says nothing about an empty field", () => {
    expect(checkName("")).toBeNull();
    expect(checkName("   ")).toBeNull();
  });

  it("refuses separators and null bytes", () => {
    expect(checkName("a/b")).toBe("name_invalid");
    expect(checkName("a\\b")).toBe("name_invalid");
    expect(checkName("a\0b")).toBe("name_invalid");
  });

  it("counts characters, not bytes", () => {
    expect(checkName("x".repeat(MAX_NAME_CHARS))).toBeNull();
    expect(checkName("x".repeat(MAX_NAME_CHARS + 1))).toBe("name_too_long");

    const cyrillic = "я".repeat(MAX_NAME_CHARS);
    expect(new TextEncoder().encode(cyrillic).length).toBe(508);
    expect(checkName(cyrillic)).toBeNull();
  });

  /** Astral characters are one name character each — `.length` would count two
   *  and refuse a name of 128 emoji. */
  it("counts a surrogate pair once", () => {
    const emoji = "😀".repeat(MAX_NAME_CHARS);
    expect(emoji.length).toBe(MAX_NAME_CHARS * 2);
    expect(checkName(emoji)).toBeNull();
  });

  it("reports the unfixable problem first", () => {
    expect(checkName(`${"x".repeat(200)}/${"y".repeat(200)}`)).toBe("name_invalid");
  });

  describe("already taken", () => {
    it("catches a name that exists in the folder", () => {
      expect(checkName("DCIM", ["DCIM", "Download"])).toBe("name_taken");
      expect(checkName("Music", ["DCIM", "Download"])).toBeNull();
    });

    /** Renaming a file to the name it already has is a no-op, not a collision —
     *  the user opened the dialog, changed their mind about the extension, and
     *  the button must not be dead when they change it back. */
    it("does not count the file's own name", () => {
      expect(checkName("note.txt", ["note.txt", "other.txt"], "note.txt")).toBeNull();
      expect(checkName("other.txt", ["note.txt", "other.txt"], "note.txt")).toBe("name_taken");
    });

    it("compares the trimmed name", () => {
      expect(checkName("  DCIM  ", ["DCIM"])).toBe("name_taken");
    });
  });

  /**
   * The same vectors as `names_the_frontend_also_pins` in
   * `crates/adx-core/src/name.rs`. Two implementations of one rule are allowed;
   * disagreeing is not, and the disagreement would show up as a dialog that
   * accepts a name the device then refuses.
   *
   * The empty and blank cases are the one deliberate divergence and are left
   * out: the backend refuses them, this side stays quiet because the dialog's
   * button is already disabled. Listing them here as `null` would read as the
   * two rules agreeing when they do not.
   */
  it("matches the Rust rule on the pinned vectors", () => {
    const cases: [string, string | null][] = [
      ["ok.txt", null],
      ["a/b", "name_invalid"],
      ["a\\b", "name_invalid"],
      ["x".repeat(254), null],
      ["x".repeat(255), "name_too_long"],
    ];
    for (const [name, expected] of cases) {
      expect(checkName(name), JSON.stringify(name.slice(0, 12))).toBe(expected);
    }
  });
});
