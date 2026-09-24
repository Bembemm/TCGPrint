import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  BLEED_SOURCE_STRIP_SUGGESTIONS_MM,
  BleedEngine,
  BleedGenerationError,
  FileBleedCache,
  MemoryBleedCache,
  type BleedDerivativeResult,
  type BleedResult,
  type BleedSourceStrip,
} from "../../image-engine/bleed";

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const BLEED_FIXTURE = join(FIXTURES, "bleed", "synthetic-edge-card.png");
const JPEG_FIXTURE = join(FIXTURES, "pdf", "synthetic-gradient.jpg");
const SVG_FIXTURE = join(FIXTURES, "pdf", "simple-vector.svg");
const CORNER_JOIN_CASES = [
  [0.625, { mode: "auto" }, 3, 3],
  [3, { mode: "auto" }, 12, 13],
  [1.5, { mode: "custom", widthMm: 0.5 }, 6, 7],
] as const satisfies readonly (readonly [number, BleedSourceStrip, number, number])[];

interface DecodedRaster {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly depth: "uchar" | "ushort";
  readonly samples: Uint8Array | Uint16Array;
}

async function decodeRaster(bytes: Uint8Array): Promise<DecodedRaster> {
  const metadata = await sharp(bytes).metadata();
  const depth = metadata.depth === "ushort" ? "ushort" : "uchar";
  const colourspace = depth === "ushort"
    ? metadata.channels !== undefined && metadata.channels <= 2 ? "grey16" : "rgb16"
    : undefined;
  const pipeline = sharp(bytes);
  if (colourspace) pipeline.toColourspace(colourspace);
  const { data, info } = await pipeline.raw({ depth }).toBuffer({ resolveWithObject: true });
  const samples = depth === "ushort"
    ? new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
    : data;

  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    depth,
    samples,
  };
}

function pixelAt(image: DecodedRaster, x: number, y: number): number[] {
  const start = (y * image.width + x) * image.channels;
  return Array.from(image.samples.subarray(start, start + image.channels));
}

function pixelsAlong(
  image: DecodedRaster,
  count: number,
  pointAt: (index: number) => readonly [number, number],
): number[] {
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const [x, y] = pointAt(index);
    const start = (y * image.width + x) * image.channels;
    for (let channel = 0; channel < image.channels; channel += 1) {
      samples.push(image.samples[start + channel]);
    }
  }
  return samples;
}

function cropPixels(image: DecodedRaster, x: number, y: number, width: number, height: number): number[] {
  const samples: number[] = [];
  for (let row = y; row < y + height; row += 1) {
    const start = (row * image.width + x) * image.channels;
    const end = start + width * image.channels;
    samples.push(...image.samples.subarray(start, end));
  }
  return samples;
}

async function readFixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

function expectPassthrough(result: BleedResult): asserts result is Extract<BleedResult, { status: "passthrough" }> {
  if (result.status !== "passthrough") throw new Error("Expected the unchanged passthrough result.");
}

function expectDerived(result: BleedResult): asserts result is BleedDerivativeResult {
  if (result.status !== "derived") throw new Error("Expected a derived bleed image.");
}

describe("BleedEngine", () => {
  it.each([
    ["PNG", join(FIXTURES, "pdf", "synthetic-rgb.png"), "image/png"],
    ["JPEG", JPEG_FIXTURE, "image/jpeg"],
    ["SVG", SVG_FIXTURE, "image/svg+xml"],
  ])("keeps a zero-mm %s request on the unchanged passthrough path", async (_name, path, mimeType) => {
    const original = await readFixture(path);
    const before = Buffer.from(original);
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0 });
    expectPassthrough(result);

    expect(result.status).toBe("passthrough");
    expect(result.cacheStatus).toBe("bypass");
    expect(result.preview).toMatchObject({ mimeType, bytes: original });
    expect(result.preview.bytes).toBe(original);
    expect(Buffer.from(original)).toEqual(before);
    expect("cacheKey" in result).toBe(false);
  });

  it.each([
    [0.625, 3, 3],
    [1, 4, 5],
    [2, 8, 9],
    [3, 12, 13],
  ])("adds symmetric raster bleed at %s mm and preserves every trim sample", async (bleedMm, bleedXPx, bleedYPx) => {
    const original = await readFixture(BLEED_FIXTURE);
    const originalBefore = Buffer.from(original);
    const sourcePixels = await decodeRaster(original);
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm });
    expectDerived(result);
    const output = await decodeRaster(result.preview.bytes);

    expect(result.status).toBe("derived");
    expect(result.bleedMm).toBe(bleedMm);
    expect(result.preview).toMatchObject({
      mimeType: "image/png",
      widthPx: sourcePixels.width + 2 * bleedXPx,
      heightPx: sourcePixels.height + 2 * bleedYPx,
      trimRectPx: {
        x: bleedXPx,
        y: bleedYPx,
        width: sourcePixels.width,
        height: sourcePixels.height,
      },
    });
    expect(output.width).toBe(sourcePixels.width + 2 * bleedXPx);
    expect(output.height).toBe(sourcePixels.height + 2 * bleedYPx);
    expect(cropPixels(output, bleedXPx, bleedYPx, sourcePixels.width, sourcePixels.height))
      .toEqual(Array.from(sourcePixels.samples));
    expect(Buffer.from(original)).toEqual(originalBefore);
  });

  it("stretches TOP, BOTTOM, LEFT, and RIGHT independently and joins each corner without a seam", async () => {
    const original = await readFixture(BLEED_FIXTURE);
    const source = await decodeRaster(original);
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });
    const output = await decodeRaster(result.preview.bytes);
    const bleedX = 3;
    const bleedY = 3;

    expect(pixelsAlong(output, source.width, (x) => [bleedX + x, bleedY - 1]))
      .toEqual(pixelsAlong(source, source.width, (x) => [x, 0]));
    expect(pixelsAlong(output, source.width, (x) => [bleedX + x, bleedY + source.height]))
      .toEqual(pixelsAlong(source, source.width, (x) => [x, source.height - 1]));
    expect(pixelsAlong(output, source.width, (x) => [bleedX + x, 0]))
      .toEqual(pixelsAlong(source, source.width, (x) => [x, 2]));
    expect(pixelsAlong(output, source.width, (x) => [bleedX + x, output.height - 1]))
      .toEqual(pixelsAlong(source, source.width, (x) => [x, source.height - 3]));
    expect(pixelsAlong(output, source.height, (y) => [bleedX - 1, bleedY + y]))
      .toEqual(pixelsAlong(source, source.height, (y) => [0, y]));
    expect(pixelsAlong(output, source.height, (y) => [bleedX + source.width, bleedY + y]))
      .toEqual(pixelsAlong(source, source.height, (y) => [source.width - 1, y]));
    expect(pixelsAlong(output, source.height, (y) => [0, bleedY + y]))
      .toEqual(pixelsAlong(source, source.height, (y) => [2, y]));
    expect(pixelsAlong(output, source.height, (y) => [output.width - 1, bleedY + y]))
      .toEqual(pixelsAlong(source, source.height, (y) => [source.width - 3, y]));

    expect(pixelsAlong(output, bleedY, (depth) => [bleedX - 1, bleedY - 1 - depth]))
      .toEqual(pixelsAlong(output, bleedY, (depth) => [bleedX, bleedY - 1 - depth]));
    expect(pixelsAlong(output, bleedY, (depth) => [bleedX + source.width, bleedY - 1 - depth]))
      .toEqual(pixelsAlong(output, bleedY, (depth) => [bleedX + source.width - 1, bleedY - 1 - depth]));
    expect(pixelsAlong(output, bleedY, (depth) => [bleedX - 1, bleedY + source.height + depth]))
      .toEqual(pixelsAlong(output, bleedY, (depth) => [bleedX, bleedY + source.height + depth]));
    expect(pixelsAlong(output, bleedY, (depth) => [bleedX + source.width, bleedY + source.height + depth]))
      .toEqual(pixelsAlong(output, bleedY, (depth) => [bleedX + source.width - 1, bleedY + source.height + depth]));
    expect(pixelsAlong(output, bleedX, (depth) => [bleedX - 1 - depth, bleedY - 1]))
      .toEqual(pixelsAlong(output, bleedX, (depth) => [bleedX - 1 - depth, bleedY]));
    expect(pixelsAlong(output, bleedX, (depth) => [bleedX + source.width + depth, bleedY - 1]))
      .toEqual(pixelsAlong(output, bleedX, (depth) => [bleedX + source.width + depth, bleedY]));
    expect(pixelsAlong(output, bleedX, (depth) => [bleedX - 1 - depth, bleedY + source.height]))
      .toEqual(pixelsAlong(output, bleedX, (depth) => [bleedX - 1 - depth, bleedY + source.height - 1]));
    expect(pixelsAlong(output, bleedX, (depth) => [bleedX + source.width + depth, bleedY + source.height]))
      .toEqual(pixelsAlong(output, bleedX, (depth) => [bleedX + source.width + depth, bleedY + source.height - 1]));

    expect(pixelAt(output, 0, 0)).toEqual(pixelAt(source, 2, 2));
    expect(pixelAt(output, output.width - 1, 0)).toEqual(pixelAt(source, source.width - 3, 2));
    expect(pixelAt(output, 0, output.height - 1)).toEqual(pixelAt(source, 2, source.height - 3));
    expect(pixelAt(output, output.width - 1, output.height - 1))
      .toEqual(pixelAt(source, source.width - 3, source.height - 3));
  });

  it.each(CORNER_JOIN_CASES)("keeps all four corner joins continuous at %s mm with the selected source strip", async (bleedMm, sourceStrip, bleedX, bleedY) => {
    const source = await decodeRaster(await readFixture(BLEED_FIXTURE));
    const result = await new BleedEngine().generate({
      imageBytes: await readFixture(BLEED_FIXTURE),
      bleedMm,
      sourceStrip,
    });
    const output = await decodeRaster(result.preview.bytes);

    expect(pixelsAlong(output, bleedY, (depth) => [bleedX - 1, bleedY - depth]))
      .toEqual(pixelsAlong(output, bleedY, (depth) => [bleedX, bleedY - depth]));
    expect(pixelsAlong(output, bleedY, (depth) => [bleedX + source.width, bleedY - depth]))
      .toEqual(pixelsAlong(output, bleedY, (depth) => [bleedX + source.width - 1, bleedY - depth]));
    expect(pixelsAlong(output, bleedY, (depth) => [bleedX - 1, bleedY + source.height - 1 + depth]))
      .toEqual(pixelsAlong(output, bleedY, (depth) => [bleedX, bleedY + source.height - 1 + depth]));
    expect(pixelsAlong(output, bleedY, (depth) => [bleedX + source.width, bleedY + source.height - 1 + depth]))
      .toEqual(pixelsAlong(output, bleedY, (depth) => [bleedX + source.width - 1, bleedY + source.height - 1 + depth]));
    expect(pixelsAlong(output, bleedX, (depth) => [bleedX - depth, bleedY - 1]))
      .toEqual(pixelsAlong(output, bleedX, (depth) => [bleedX - depth, bleedY]));
    expect(pixelsAlong(output, bleedX, (depth) => [bleedX + source.width - 1 + depth, bleedY - 1]))
      .toEqual(pixelsAlong(output, bleedX, (depth) => [bleedX + source.width - 1 + depth, bleedY]));
    expect(pixelsAlong(output, bleedX, (depth) => [bleedX - depth, bleedY + source.height]))
      .toEqual(pixelsAlong(output, bleedX, (depth) => [bleedX - depth, bleedY + source.height - 1]));
    expect(pixelsAlong(output, bleedX, (depth) => [bleedX + source.width - 1 + depth, bleedY + source.height]))
      .toEqual(pixelsAlong(output, bleedX, (depth) => [bleedX + source.width - 1 + depth, bleedY + source.height - 1]));
  });

  it("preserves partial and zero alpha in the trim and generates alpha in the bleed", async () => {
    const sourceBytes = await readFixture(join(FIXTURES, "pdf", "synthetic-alpha.png"));
    const source = await decodeRaster(sourceBytes);
    const result = await new BleedEngine().generate({ imageBytes: sourceBytes, bleedMm: 1 });
    const output = await decodeRaster(result.preview.bytes);

    expect(output.channels).toBe(4);
    expect(output.samples).toHaveLength(output.width * output.height * 4);
    expect(cropPixels(output, 1, 1, source.width, source.height)).toEqual(Array.from(source.samples));
    expect(pixelAt(output, 1, 0)).toEqual(pixelAt(source, 0, 0));
    expect(pixelAt(output, 0, 0)[3]).toBe(pixelAt(source, 0, 0)[3]);
  });

  it.each([
    ["synthetic-rgb16.png", [0x1234, 0x5678, 0x9abc, 0x12ff, 0x56ff, 0x9aff]],
    ["synthetic-rgba16.png", [0x1234, 0x5678, 0x9abc, 0x00aa, 0x12ff, 0x56ff, 0x9aff, 0xff01]],
    ["synthetic-rgb16-trns.png", [0x1234, 0x5678, 0x9abc, 0x0000, 0x12ff, 0x56ff, 0x9aff, 0xffff]],
  ])("preserves all 16-bit PNG samples and alpha in %s", async (filename, expectedSamples) => {
    const sourceBytes = await readFixture(join(FIXTURES, "pdf", filename));
    const result = await new BleedEngine().generate({ imageBytes: sourceBytes, bleedMm: 0.625 });
    const output = await decodeRaster(result.preview.bytes);

    expect(output.depth).toBe("ushort");
    expect(cropPixels(output, 1, 1, 2, 1)).toEqual(expectedSamples);
  });

  it("decodes JPEG only to create a lossless PNG derivative", async () => {
    const sourceBytes = await readFixture(JPEG_FIXTURE);
    const source = await decodeRaster(sourceBytes);
    const result = await new BleedEngine().generate({ imageBytes: sourceBytes, bleedMm: 0.625 });
    const output = await decodeRaster(result.preview.bytes);

    expect(result.preview.mimeType).toBe("image/png");
    expect(Buffer.from(result.preview.bytes).subarray(0, 8))
      .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(cropPixels(output, 1, 1, source.width, source.height)).toEqual(Array.from(source.samples));
    expect(Buffer.from(result.preview.bytes)).not.toEqual(Buffer.from(sourceBytes));
  });

  it("accepts arbitrary decimal bleed values without rounding the requested millimeters", async () => {
    const result = await new BleedEngine().generate({
      imageBytes: await readFixture(BLEED_FIXTURE),
      bleedMm: 1.234567,
    });

    expect(result.bleedMm).toBe(1.234567);
    expect(result.status).toBe("derived");
  });

  it.each([-0.001, 3.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid bleed amount %s",
    async (bleedMm) => {
      await expect(new BleedEngine().generate({
        imageBytes: await readFixture(BLEED_FIXTURE),
        bleedMm,
      })).rejects.toThrow(RangeError);
    },
  );

  it.each([0.25, 0.5, 0.75, 1, 0.4])("accepts source-strip value %s mm as configurable input", async (widthMm) => {
    const sourceStrip: BleedSourceStrip = { mode: "custom", widthMm };
    const result = await new BleedEngine().generate({
      imageBytes: await readFixture(BLEED_FIXTURE),
      bleedMm: 1.5,
      sourceStrip,
    });
    expectDerived(result);

    expect(result.sourceStrip).toEqual(sourceStrip);
    expect(result.resolvedSourceStripMm).toBe(widthMm);
    expect(result.cacheKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("offers common source-strip values without restricting custom decimals", async () => {
    expect(BLEED_SOURCE_STRIP_SUGGESTIONS_MM).toEqual([0.25, 0.5, 0.75, 1]);
    const result = await new BleedEngine().generate({
      imageBytes: await readFixture(BLEED_FIXTURE),
      bleedMm: 1,
      sourceStrip: { mode: "custom", widthMm: 0.333 },
    });
    expectDerived(result);

    expect(result.sourceStrip).toEqual({ mode: "custom", widthMm: 0.333 });
  });

  it.each([0, -0.1, 3.001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid custom source-strip width %s",
    async (widthMm) => {
      await expect(new BleedEngine().generate({
        imageBytes: await readFixture(BLEED_FIXTURE),
        bleedMm: 1,
        sourceStrip: { mode: "custom", widthMm },
      })).rejects.toThrow(RangeError);
    },
  );

  it("chooses a deterministic small source strip in Auto mode", async () => {
    const result = await new BleedEngine().generate({
      imageBytes: await readFixture(BLEED_FIXTURE),
      bleedMm: 0.625,
      sourceStrip: { mode: "auto" },
    });
    expectDerived(result);

    expect(result.sourceStrip).toEqual({ mode: "auto" });
    expect(result.resolvedSourceStripMm).toBe(0.625);
  });

  it("caches a derived preview and changes the key when configuration changes", async () => {
    const cache = new MemoryBleedCache();
    const engine = new BleedEngine({ cache });
    const imageBytes = await readFixture(BLEED_FIXTURE);
    const request = { imageBytes, bleedMm: 1, sourceStrip: { mode: "auto" } as const };
    const first = await engine.generate(request);
    const second = await engine.generate(request);
    const changed = await engine.generate({ ...request, sourceStrip: { mode: "custom", widthMm: 0.5 } });
    expectDerived(first);
    expectDerived(second);
    expectDerived(changed);

    expect(first.cacheStatus).toBe("miss");
    expect(second.cacheStatus).toBe("hit");
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(second.preview.bytes).toEqual(first.preview.bytes);
    expect(changed.cacheStatus).toBe("miss");
    expect(changed.cacheKey).not.toBe(first.cacheKey);
  });

  it("persists deterministic derivatives in the file cache for later previews", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgprint-bleed-cache-"));
    try {
      const imageBytes = await readFixture(BLEED_FIXTURE);
      const request = { imageBytes, bleedMm: 1 };
      const first = await new BleedEngine({ cache: new FileBleedCache(directory) }).generate(request);
      expectDerived(first);
      const entries = await readdir(directory);
      const second = await new BleedEngine({ cache: new FileBleedCache(directory) }).generate(request);
      expectDerived(second);

      expect(first.cacheStatus).toBe("miss");
      expect(entries).toEqual([`${first.cacheKey}.png`]);
      expect(Buffer.from(await readFile(join(directory, entries[0])))).toEqual(Buffer.from(first.preview.bytes));
      expect(second.cacheStatus).toBe("hit");
      expect(second.preview.bytes).toEqual(first.preview.bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails explicitly for non-zero SVG bleed and keeps the original SVG vector bytes", async () => {
    const svg = await readFixture(SVG_FIXTURE);
    const before = Buffer.from(svg);

    await expect(new BleedEngine().generate({ imageBytes: svg, bleedMm: 0.625 }))
      .rejects.toMatchObject<Partial<BleedGenerationError>>({ code: "SVG_VECTOR_BLEED_UNSUPPORTED" });
    expect(Buffer.from(svg)).toEqual(before);
  });

  it("fails clearly instead of silently rasterizing an undecodable source", async () => {
    await expect(new BleedEngine().generate({ imageBytes: new Uint8Array([0, 1, 2, 3]), bleedMm: 0.625 }))
      .rejects.toThrow(BleedGenerationError);
  });
});
