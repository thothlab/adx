import { describe, expect, it } from "vitest";
import { formatBytes, fraction } from "./format";

describe("formatBytes", () => {
  it("keeps bytes whole and larger units to one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50575716352)).toBe("47.1 GB");
  });

  it("stops at the largest unit it knows instead of inventing one", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
  });

  /** A device that reports nothing must not render "NaN undefined". */
  it("refuses values that are not counts", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("fraction", () => {
  it("is a ratio clamped to 0..1", () => {
    expect(fraction(0, 100)).toBe(0);
    expect(fraction(50, 100)).toBe(0.5);
    expect(fraction(150, 100)).toBe(1);
  });

  /** An empty upload is 0 %, never a division by zero. */
  it("survives an unknown or zero total", () => {
    expect(fraction(5, 0)).toBe(0);
    expect(fraction(5, Number.NaN)).toBe(0);
  });
});
