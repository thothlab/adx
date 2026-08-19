import { describe, expect, it } from "vitest";
import {
  extensionOf,
  isStreamed,
  isTruncatable,
  mimeOf,
  previewKind,
  PREVIEW_LIMITS,
} from "./preview";

describe("previewKind", () => {
  it("recognises every kind the modal can render", () => {
    expect(previewKind("photo.JPG")).toBe("image");
    expect(previewKind("scan.pdf")).toBe("pdf");
    expect(previewKind("notes.md")).toBe("text");
    expect(previewKind("clip.mp4")).toBe("video");
    expect(previewKind("book.m4b")).toBe("audio");
    expect(previewKind("track.mp3")).toBe("audio");
  });

  /** Common on Android and not decodable by WebKit. Claiming them would give
   *  the user a black rectangle instead of "copy it to the computer". */
  it("does not claim media the engine cannot decode", () => {
    expect(previewKind("movie.mkv")).toBeNull();
    expect(previewKind("movie.avi")).toBeNull();
    expect(previewKind("movie.wmv")).toBeNull();
  });

  it("says nothing for what it cannot show, rather than guessing", () => {
    expect(previewKind("app.apk")).toBeNull();
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

  /** A ceiling on a streamed kind would reject exactly the files streaming was
   *  built for — the 700 MB audiobooks on the device this was measured against
   *  are the normal case, not the edge one. */
  it("puts no ceiling on what is streamed", () => {
    expect(isStreamed("video")).toBe(true);
    expect(isStreamed("audio")).toBe(true);
    expect(isStreamed("image")).toBe(false);
    expect(isStreamed("pdf")).toBe(false);

    expect(PREVIEW_LIMITS.video).toBe(Number.POSITIVE_INFINITY);
    expect(PREVIEW_LIMITS.audio).toBe(Number.POSITIVE_INFINITY);
    expect(800 * 1024 * 1024).toBeLessThan(PREVIEW_LIMITS.audio);
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
