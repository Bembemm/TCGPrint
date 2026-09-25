import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { importImageSource } from "../../import-engine/importers/image";
import { ImportFailureError } from "../../import-engine";
import type { ImportSource } from "../../import-engine";

const PDF_FIXTURES = join(process.cwd(), "tests", "fixtures", "pdf");

function source(bytes: Uint8Array, filename: string): ImportSource {
  return {
    id: "input-1",
    kind: "file",
    filename,
    order: 0,
    sizeBytes: bytes.byteLength,
    originalBytes: bytes,
  };
}

async function makeRaster(format: "webp" | "tiff"): Promise<Uint8Array> {
  const bytes = await sharp({
    create: { width: 7, height: 5, channels: 3, background: { r: 22, g: 118, b: 204 } },
  })[format]().toBuffer();
  return new Uint8Array(bytes);
}

describe("local image import", () => {
  it.each([
    ["synthetic-rgb.png", "raster.png", "png", "image/png", 4, 3],
    ["synthetic-gradient.jpg", "raster.jpeg", "jpeg", "image/jpeg", 8, 6],
  ] as const)("validates %s and retains the exact original bytes", async (fixture, filename, format, mediaType, width, height) => {
    const bytes = new Uint8Array(await readFile(join(PDF_FIXTURES, fixture)));
    const originalHash = createHash("sha256").update(bytes).digest("hex");
    const result = await importImageSource(source(bytes, filename));

    expect(result.entry).toMatchObject({
      kind: "custom-card",
      order: 0,
      quantity: 1,
      sourceFilename: filename,
      asset: {
        originalFormat: format,
        mediaType,
        sha256: originalHash,
        widthPx: width,
        heightPx: height,
        sourceFilename: filename,
      },
    });
    expect(result.entry.nameSuggestion).toBe("raster");
    expect(result.entry.asset?.originalBytes).toBe(bytes);
    expect(Buffer.from(result.entry.asset!.originalBytes!)).toEqual(Buffer.from(bytes));
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ["webp", "image/webp"],
    ["tiff", "image/tiff"],
  ] as const)("accepts %s without conversion", async (format, mediaType) => {
    const bytes = await makeRaster(format);
    const result = await importImageSource(source(bytes, `capture.${format}`));
    expect(result.entry.asset).toMatchObject({ originalFormat: format, mediaType, widthPx: 7, heightPx: 5 });
    expect(result.entry.asset?.originalBytes).toBe(bytes);
  });

  it("uses file content over a misleading extension and reports the mismatch", async () => {
    const bytes = new Uint8Array(await readFile(join(PDF_FIXTURES, "synthetic-gradient.jpg")));
    const result = await importImageSource(source(bytes, "scan.png"));
    expect(result.entry.asset).toMatchObject({ originalFormat: "jpeg", mediaType: "image/jpeg" });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "EXTENSION_MISMATCH" }));
  });

  it("keeps a byte-view's exact range when hashing and retaining an upload", async () => {
    const jpeg = await readFile(join(PDF_FIXTURES, "synthetic-gradient.jpg"));
    const padded = Buffer.alloc(jpeg.length + 13, 0xab);
    jpeg.copy(padded, 5);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 5, jpeg.length);
    const result = await importImageSource(source(view, "view.jpg"));
    expect(result.entry.asset?.sha256).toBe(createHash("sha256").update(jpeg).digest("hex"));
    expect(result.entry.asset?.originalBytes).toBe(view);
  });

  it("preserves SVG bytes and reads dimensions from its vector root", async () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="120" height="168" viewBox="0 0 40 56"><rect width="40" height="56" /></svg>',
    );
    const result = await importImageSource(source(svg, "card-front.svg"));
    expect(result.entry).toMatchObject({
      kind: "custom-card",
      asset: {
        originalFormat: "svg",
        mediaType: "image/svg+xml",
        widthPx: 120,
        heightPx: 168,
        sha256: createHash("sha256").update(svg).digest("hex"),
      },
    });
    expect(result.entry.asset?.originalBytes).toBe(svg);
    expect(Buffer.from(result.entry.asset!.originalBytes!)).toEqual(Buffer.from(svg));
  });

  it("rejects malformed or truncated raster content as a typed import failure", async () => {
    const corruptPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    await expect(importImageSource(source(corruptPng, "broken.png")))
      .rejects.toMatchObject<Partial<ImportFailureError>>({ code: "IMAGE_DECODE_FAILED" });
  });

  it("enforces the configured per-input byte limit", async () => {
    const bytes = new Uint8Array(await readFile(join(PDF_FIXTURES, "synthetic-rgb.png")));
    await expect(importImageSource(source(bytes, "large.png"), { maxInputBytes: bytes.byteLength - 1 }))
      .rejects.toMatchObject<Partial<ImportFailureError>>({ code: "INPUT_TOO_LARGE" });
  });
});
