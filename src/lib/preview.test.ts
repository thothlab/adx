import { describe, expect, it } from "vitest";
import { extensionOf, isTruncatable, mimeOf, previewKind, PREVIEW_LIMITS } from "./preview";

describe("previewKind", () => {
  it("recognises the three kinds the modal can render", () => {
    expect(previewKind("photo.JPG")).toBe("image");
    expect(previewKind("scan.pdf")).toBe("pdf");
    expect(previewKind("notes.md")).toBe("text");
  });

  it("says nothing for what it cannot show, rather than guessing", () => {
    expect(previewKind("song.m4b")).toBeNull();
    expect(previewKind("clip.mp4")).toBeNull();
    expect(previewKind("archive.zip")).toBeNull();
    expect(previewKind("Makefile")).toBeNull();
  });

  /** A dotfile has no extension — the leading dot names the file. Treating it
   *  as one would make ".bashrc" a file of type "bashrc" and, worse, make
   *  ".pdf" look like a PDF. */
  it("does not read a leading dot as an extension", () => {
    expect(extensionOf(".bashrc")).toBe("");
    expect(previewKind(".pdf")).toBeNull();
  });

  it("ignores case, because devices do not agree on it", () => {
    expect(previewKind("SCAN.PDF")).toBe("pdf");
    expect(previewKind("Photo.JpEg")).toBe("image");
  });
});

describe("preview limits", () => {
  /** Only text survives being cut off: half a JPEG is a grey box and half a
   *  PDF does not open. So the modal may only truncate what this allows. */
  it("allows truncation for text alone", () => {
    expect(isTruncatable("text")).toBe(true);
    expect(isTruncatable("image")).toBe(false);
    expect(isTruncatable("pdf")).toBe(false);
  });

  it("keeps every ceiling positive and the text one the smallest", () => {
    for (const limit of Object.values(PREVIEW_LIMITS)) expect(limit).toBeGreaterThan(0);
    expect(PREVIEW_LIMITS.text).toBeLessThan(PREVIEW_LIMITS.image);
  });
});

describe("mimeOf", () => {
  /** The Blob's type is what makes the webview render instead of offering to
   *  save, and `image/jpg` is not a real type — a `.jpg` must come out as
   *  `image/jpeg` or the tag shows a broken image. */
  it("maps the extensions that do not equal their MIME subtype", () => {
    expect(mimeOf("image", "a.jpg")).toBe("image/jpeg");
    expect(mimeOf("image", "a.jpeg")).toBe("image/jpeg");
    expect(mimeOf("image", "a.svg")).toBe("image/svg+xml");
    expect(mimeOf("image", "a.ico")).toBe("image/x-icon");
    expect(mimeOf("image", "a.png")).toBe("image/png");
  });

  it("gives text an explicit charset so a Cyrillic file is not read as Latin-1", () => {
    expect(mimeOf("text", "a.txt")).toContain("charset=utf-8");
    expect(mimeOf("pdf", "a.pdf")).toBe("application/pdf");
  });
});
