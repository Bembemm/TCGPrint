import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BleedEngine, MemoryBleedCache } from "../../image-engine/bleed";

const CARD_WIDTH_PX = 127;
const CARD_HEIGHT_PX = 178;

async function syntheticDarkFrame(): Promise<Uint8Array> {
  const samples = new Uint8Array(CARD_WIDTH_PX * CARD_HEIGHT_PX * 3);
  for (let y = 0; y < CARD_HEIGHT_PX; y += 1) {
    for (let x = 0; x < CARD_WIDTH_PX; x += 1) {
      const isDarkFrame = x < 3 || x >= CARD_WIDTH_PX - 3 || y < 3 || y >= CARD_HEIGHT_PX - 3;
      const pixel = (y * CARD_WIDTH_PX + x) * 3;
      samples[pixel] = isDarkFrame ? 3 : 48;
      samples[pixel + 1] = isDarkFrame ? 4 : 126;
      samples[pixel + 2] = isDarkFrame ? 5 : 214;
    }
  }
  const png = await sharp(samples, { raw: { width: CARD_WIDTH_PX, height: CARD_HEIGHT_PX, channels: 3 } }).png().toBuffer();
  return new Uint8Array(png);
}

async function syntheticLeftDarkFrame(): Promise<Uint8Array> {
  const samples = new Uint8Array(CARD_WIDTH_PX * CARD_HEIGHT_PX * 3);
  for (let y = 0; y < CARD_HEIGHT_PX; y += 1) {
    for (let x = 0; x < CARD_WIDTH_PX; x += 1) {
      const isDarkFrame = x < 3;
      const pixel = (y * CARD_WIDTH_PX + x) * 3;
      samples[pixel] = isDarkFrame ? 3 : 48;
      samples[pixel + 1] = isDarkFrame ? 4 : 126;
      samples[pixel + 2] = isDarkFrame ? 5 : 214;
    }
  }
  const png = await sharp(samples, { raw: { width: CARD_WIDTH_PX, height: CARD_HEIGHT_PX, channels: 3 } }).png().toBuffer();
  return new Uint8Array(png);
}

async function syntheticBorderlessFullArt(): Promise<Uint8Array> {
  const samples = new Uint8Array(CARD_WIDTH_PX * CARD_HEIGHT_PX * 3);
  for (let y = 0; y < CARD_HEIGHT_PX; y += 1) {
    for (let x = 0; x < CARD_WIDTH_PX; x += 1) {
      const wave = Math.sin(x / 15) * 25 + Math.cos(y / 19) * 27;
      const pixel = (y * CARD_WIDTH_PX + x) * 3;
      samples[pixel] = Math.max(0, Math.min(255, Math.round(92 + (x / CARD_WIDTH_PX) * 88 + wave)));
      samples[pixel + 1] = Math.max(0, Math.min(255, Math.round(84 + (y / CARD_HEIGHT_PX) * 103 - wave / 2)));
      samples[pixel + 2] = Math.max(0, Math.min(255, Math.round(102 + ((x + y) / (CARD_WIDTH_PX + CARD_HEIGHT_PX)) * 113 + wave / 3)));
    }
  }
  const png = await sharp(samples, { raw: { width: CARD_WIDTH_PX, height: CARD_HEIGHT_PX, channels: 3 } }).png().toBuffer();
  return new Uint8Array(png);
}

async function syntheticLightBorder(): Promise<Uint8Array> {
  const samples = new Uint8Array(CARD_WIDTH_PX * CARD_HEIGHT_PX * 3);
  for (let y = 0; y < CARD_HEIGHT_PX; y += 1) {
    for (let x = 0; x < CARD_WIDTH_PX; x += 1) {
      const isLightBorder = x < 3 || x >= CARD_WIDTH_PX - 3 || y < 3 || y >= CARD_HEIGHT_PX - 3;
      const pixel = (y * CARD_WIDTH_PX + x) * 3;
      samples[pixel] = isLightBorder ? 245 : 32;
      samples[pixel + 1] = isLightBorder ? 243 : 104;
      samples[pixel + 2] = isLightBorder ? 237 : 188;
    }
  }
  const png = await sharp(samples, { raw: { width: CARD_WIDTH_PX, height: CARD_HEIGHT_PX, channels: 3 } }).png().toBuffer();
  return new Uint8Array(png);
}

async function syntheticHighContrastCorners(): Promise<Uint8Array> {
  const samples = new Uint8Array(CARD_WIDTH_PX * CARD_HEIGHT_PX * 3);
  for (let y = 0; y < CARD_HEIGHT_PX; y += 1) {
    for (let x = 0; x < CARD_WIDTH_PX; x += 1) {
      const corner = (x < 6 || x >= CARD_WIDTH_PX - 6) && (y < 6 || y >= CARD_HEIGHT_PX - 6);
      const cornerValue = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0 ? 0 : 255;
      const gradient = Math.round(74 + (x / CARD_WIDTH_PX) * 76 + (y / CARD_HEIGHT_PX) * 63);
      const pixel = (y * CARD_WIDTH_PX + x) * 3;
      samples[pixel] = corner ? cornerValue : gradient;
      samples[pixel + 1] = corner ? cornerValue : Math.max(0, gradient - 21);
      samples[pixel + 2] = corner ? cornerValue : Math.min(255, gradient + 28);
    }
  }
  const png = await sharp(samples, { raw: { width: CARD_WIDTH_PX, height: CARD_HEIGHT_PX, channels: 3 } }).png().toBuffer();
  return new Uint8Array(png);
}

async function synthetic16BitAlphaFrame(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL("../fixtures/pdf/synthetic-rgba16.png", import.meta.url)));
}

describe("smart-border-fill", () => {
  it("keeps zero-millimeter smart mode as original-byte passthrough", async () => {
    const original = await syntheticDarkFrame();
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0, mode: "smart-border-fill" });

    expect(result.status).toBe("passthrough");
    expect(result.preview.bytes).toBe(original);
    expect(result.preview.bytes).toEqual(original);
    expect(result.cacheStatus).toBe("bypass");
  });

  it.each([0.625, 1, 2, 3])("preserves trim pixels and nominal physical size at %s mm", async (bleedMm) => {
    const original = await syntheticDarkFrame();
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm, mode: "smart-border-fill" });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    expect(result.bleedMm).toBe(bleedMm);
    expect(result.trimSizeMm).toEqual({ widthMm: 63.5, heightMm: 88.9 });
    expect(result.preview.widthPx - result.preview.trimRectPx.width).toBe(result.preview.trimRectPx.x * 2);
    expect(result.preview.heightPx - result.preview.trimRectPx.height).toBe(result.preview.trimRectPx.y * 2);

    const { data: input, info: inputInfo } = await sharp(original).raw().toBuffer({ resolveWithObject: true });
    const { data: output, info: outputInfo } = await sharp(result.preview.bytes).raw().toBuffer({ resolveWithObject: true });
    const trim = result.preview.trimRectPx;
    for (let y = 0; y < inputInfo.height; y += 1) {
      const inputStart = y * inputInfo.width * inputInfo.channels;
      const outputStart = ((trim.y + y) * outputInfo.width + trim.x) * outputInfo.channels;
      expect(output.subarray(outputStart, outputStart + inputInfo.width * inputInfo.channels)).toEqual(
        input.subarray(inputStart, inputStart + inputInfo.width * inputInfo.channels),
      );
    }
  });

  it("extends a detected dark frame from the interior band and leaves every trim sample unchanged", async () => {
    const original = await syntheticDarkFrame();
    const request = {
      imageBytes: original,
      bleedMm: 1,
      trimSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      mode: "smart-border-fill",
    } as const;
    const result = await new BleedEngine().generate(request);

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    const { data: input, info: inputInfo } = await sharp(original).raw().toBuffer({ resolveWithObject: true });
    const { data: output, info: outputInfo } = await sharp(result.preview.bytes).raw().toBuffer({ resolveWithObject: true });
    const trim = result.preview.trimRectPx;
    const sample = (x: number, y: number) => {
      const start = (y * outputInfo.width + x) * outputInfo.channels;
      return Array.from(output.subarray(start, start + outputInfo.channels));
    };
    const middleX = Math.floor(outputInfo.width / 2);
    const middleY = Math.floor(outputInfo.height / 2);

    expect(sample(0, middleY)).toEqual([48, 126, 214]);
    expect(sample(outputInfo.width - 1, middleY)).toEqual([48, 126, 214]);
    expect(sample(middleX, 0)).toEqual([48, 126, 214]);
    expect(sample(middleX, outputInfo.height - 1)).toEqual([48, 126, 214]);
    expect((["top", "right", "bottom", "left"] as const).map((side) => result.sideDiagnostics[side].effectiveMode))
      .toEqual(Array(4).fill("smart-border-fill"));
    for (let y = 0; y < inputInfo.height; y += 1) {
      const inputStart = y * inputInfo.width * inputInfo.channels;
      const outputStart = ((trim.y + y) * outputInfo.width + trim.x) * outputInfo.channels;
      expect(output.subarray(outputStart, outputStart + inputInfo.width * inputInfo.channels)).toEqual(
        input.subarray(inputStart, inputStart + inputInfo.width * inputInfo.channels),
      );
    }
  });

  it.each([0.625, 1, 2, 3])("keeps the physical trim while applying smart fill at %s mm", async (bleedMm) => {
    const result = await new BleedEngine().generate({
      imageBytes: await syntheticDarkFrame(),
      bleedMm,
      mode: "smart-border-fill",
    });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    expect(result.preview.trimRectPx).toMatchObject({ width: CARD_WIDTH_PX, height: CARD_HEIGHT_PX });
    expect(result.preview.widthPx).toBe(CARD_WIDTH_PX + 2 * Math.ceil((CARD_WIDTH_PX * bleedMm) / 63.5));
    expect(result.preview.heightPx).toBe(CARD_HEIGHT_PX + 2 * Math.ceil((CARD_HEIGHT_PX * bleedMm) / 88.9));
    expect(result.sideDiagnostics.left).toMatchObject({
      effectiveMode: "smart-border-fill",
      classification: "interior-strip-found",
    });
  });

  it("uses the configured dark-pixel threshold when classifying each side", async () => {
    const imageBytes = await syntheticDarkFrame();
    const result = await new BleedEngine({ smartBorderFillConfig: { darkPixelLuminanceMax: 0 } }).generate({
      imageBytes,
      bleedMm: 1,
      mode: "smart-border-fill",
    });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    expect(result.sideDiagnostics.left).toMatchObject({
      effectiveMode: "subtle-edge-stretch",
      classification: "outer-band-not-dark-uniform",
      fallbackReason: "outer-band-not-dark-uniform",
    });
  });

  it("falls back when no representative source-strip start lies within the configured physical search bound", async () => {
    const result = await new BleedEngine({ smartBorderFillConfig: { maximumInwardSearchFractionOfTrim: 0.01 } }).generate({
      imageBytes: await syntheticDarkFrame(),
      bleedMm: 1,
      mode: "smart-border-fill",
    });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    expect(result.sideDiagnostics.left).toMatchObject({
      effectiveMode: "subtle-edge-stretch",
      classification: "search-bound-exhausted",
      sourceOffsetPx: 0,
      fallbackReason: "no-representative-interior-strip-within-search-bound",
    });
  });

  it("classifies sides independently and reflects selected side strips through corners", async () => {
    const original = await syntheticLeftDarkFrame();
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm: 1, mode: "smart-border-fill" });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    expect(result.effectiveMode).toBe("mixed");
    expect(result.sideDiagnostics.left).toMatchObject({
      requestedMode: "smart-border-fill",
      effectiveMode: "smart-border-fill",
      classification: "interior-strip-found",
      sourceOffsetPx: 3,
    });
    expect(result.sideDiagnostics.right).toMatchObject({
      requestedMode: "smart-border-fill",
      effectiveMode: "subtle-edge-stretch",
      fallbackReason: "outer-band-not-dark-uniform",
    });
    expect(result.sideDiagnostics.top.fallbackReason).toBe("outer-band-not-dark-uniform");
    expect(result.sideDiagnostics.bottom.fallbackReason).toBe("outer-band-not-dark-uniform");

    const { data: input, info: inputInfo } = await sharp(original).raw().toBuffer({ resolveWithObject: true });
    const { data: output, info: outputInfo } = await sharp(result.preview.bytes).raw().toBuffer({ resolveWithObject: true });
    const trim = result.preview.trimRectPx;
    const outputPixel = (relativeX: number, relativeY: number) => {
      const start = ((trim.y + relativeY) * outputInfo.width + trim.x + relativeX) * outputInfo.channels;
      return Array.from(output.subarray(start, start + outputInfo.channels));
    };
    const reflectedTopLeft = outputPixel(-1, -1);
    const expectedSourceOffset = (0 * inputInfo.width + 3) * inputInfo.channels;

    expect(reflectedTopLeft).toEqual(Array.from(input.subarray(expectedSourceOffset, expectedSourceOffset + inputInfo.channels)));
    const cornerJoins = [
      { corner: [-1, -1], horizontal: [0, -1], vertical: [-1, 0] },
      { corner: [CARD_WIDTH_PX, -1], horizontal: [CARD_WIDTH_PX - 1, -1], vertical: [CARD_WIDTH_PX, 0] },
      { corner: [-1, CARD_HEIGHT_PX], horizontal: [0, CARD_HEIGHT_PX], vertical: [-1, CARD_HEIGHT_PX - 1] },
      { corner: [CARD_WIDTH_PX, CARD_HEIGHT_PX], horizontal: [CARD_WIDTH_PX - 1, CARD_HEIGHT_PX], vertical: [CARD_WIDTH_PX, CARD_HEIGHT_PX - 1] },
    ] as const;
    for (const { corner, horizontal, vertical } of cornerJoins) {
      const cornerPixel = outputPixel(corner[0], corner[1]);
      expect(cornerPixel).toEqual(outputPixel(horizontal[0], horizontal[1]));
      expect(cornerPixel).toEqual(outputPixel(vertical[0], vertical[1]));
    }
  });

  it("keeps 16-bit RGBA samples and alpha intact inside the trim", async () => {
    const original = await synthetic16BitAlphaFrame();
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm: 1, mode: "smart-border-fill" });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    const inputMetadata = await sharp(original).metadata();
    const outputMetadata = await sharp(result.preview.bytes).metadata();
    expect(inputMetadata).toMatchObject({ depth: "ushort", hasAlpha: true });
    expect(outputMetadata).toMatchObject({ format: "png", depth: "ushort", hasAlpha: true });

    const { data: input, info: inputInfo } = await sharp(original).raw({ depth: "ushort" }).toBuffer({ resolveWithObject: true });
    const { data: output, info: outputInfo } = await sharp(result.preview.bytes).raw({ depth: "ushort" }).toBuffer({ resolveWithObject: true });
    expect(inputInfo.channels).toBe(4);
    expect(outputInfo.channels).toBe(4);
    const trim = result.preview.trimRectPx;
    for (let y = 0; y < inputInfo.height; y += 1) {
      const inputStart = y * inputInfo.width * inputInfo.channels * 2;
      const outputStart = ((trim.y + y) * outputInfo.width + trim.x) * outputInfo.channels * 2;
      expect(output.subarray(outputStart, outputStart + inputInfo.width * inputInfo.channels * 2)).toEqual(
        input.subarray(inputStart, inputStart + inputInfo.width * inputInfo.channels * 2),
      );
    }
  });

  it("uses subtle stretch for a varied borderless full-art edge", async () => {
    const imageBytes = await syntheticBorderlessFullArt();
    const result = await new BleedEngine().generate({ imageBytes, bleedMm: 1, mode: "smart-border-fill" });
    const repeated = await new BleedEngine().generate({ imageBytes, bleedMm: 1, mode: "smart-border-fill" });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    expect(repeated.status).toBe("derived");
    if (repeated.status !== "derived") throw new Error("Expected a repeated derived raster.");
    expect(result.effectiveMode).toBe("subtle-edge-stretch");
    expect(repeated.preview.bytes).toEqual(result.preview.bytes);
    expect(repeated.sideDiagnostics).toEqual(result.sideDiagnostics);
    expect(repeated.cacheKey).toBe(result.cacheKey);
    expect((["top", "right", "bottom", "left"] as const).map((side) => result.sideDiagnostics[side].fallbackReason))
      .toEqual(Array(4).fill("outer-band-not-dark-uniform"));
  });

  it("falls back on each side of a light border", async () => {
    const result = await new BleedEngine().generate({ imageBytes: await syntheticLightBorder(), bleedMm: 1, mode: "smart-border-fill" });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    expect(result.effectiveMode).toBe("subtle-edge-stretch");
    expect((["top", "right", "bottom", "left"] as const).map((side) => result.sideDiagnostics[side].fallbackReason))
      .toEqual(Array(4).fill("outer-band-not-dark-uniform"));
  });

  it("keeps high-contrast corners continuous while rejecting them as an edge-frame signal", async () => {
    const original = await syntheticHighContrastCorners();
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm: 1, mode: "smart-border-fill" });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    expect(result.effectiveMode).toBe("subtle-edge-stretch");
    expect((["top", "right", "bottom", "left"] as const).map((side) => result.sideDiagnostics[side].fallbackReason))
      .toEqual(Array(4).fill("outer-band-not-dark-uniform"));

    const { data: output, info } = await sharp(result.preview.bytes).raw().toBuffer({ resolveWithObject: true });
    const trim = result.preview.trimRectPx;
    const pixel = (x: number, y: number) => {
      const start = ((trim.y + y) * info.width + trim.x + x) * info.channels;
      return Array.from(output.subarray(start, start + info.channels));
    };
    const cornerJoins = [
      { corner: [-1, -1], horizontal: [0, -1], vertical: [-1, 0] },
      { corner: [CARD_WIDTH_PX, -1], horizontal: [CARD_WIDTH_PX - 1, -1], vertical: [CARD_WIDTH_PX, 0] },
      { corner: [-1, CARD_HEIGHT_PX], horizontal: [0, CARD_HEIGHT_PX], vertical: [-1, CARD_HEIGHT_PX - 1] },
      { corner: [CARD_WIDTH_PX, CARD_HEIGHT_PX], horizontal: [CARD_WIDTH_PX - 1, CARD_HEIGHT_PX], vertical: [CARD_WIDTH_PX, CARD_HEIGHT_PX - 1] },
    ] as const;
    for (const { corner, horizontal, vertical } of cornerJoins) {
      expect(pixel(corner[0], corner[1])).toEqual(pixel(horizontal[0], horizontal[1]));
      expect(pixel(corner[0], corner[1])).toEqual(pixel(vertical[0], vertical[1]));
    }
  });

  it("separates cache entries by source policy, mode, and threshold configuration", async () => {
    const cache = new MemoryBleedCache();
    const imageBytes = await syntheticDarkFrame();
    const first = await new BleedEngine({ cache }).generate({ imageBytes, bleedMm: 1, mode: "smart-border-fill", policyId: "scryfall-raster-auto-v1" });
    const otherPolicy = await new BleedEngine({ cache }).generate({ imageBytes, bleedMm: 1, mode: "smart-border-fill", policyId: "manual-override-upload-smart-border-fill-v1" });
    const otherConfig = await new BleedEngine({ cache, smartBorderFillConfig: { searchStepMm: 0.5 } }).generate({
      imageBytes,
      bleedMm: 1,
      mode: "smart-border-fill",
      policyId: "manual-override-upload-smart-border-fill-v1",
    });
    const otherSearchBound = await new BleedEngine({ cache, smartBorderFillConfig: { maximumInwardSearchFractionOfTrim: 0.04 } }).generate({
      imageBytes,
      bleedMm: 1,
      mode: "smart-border-fill",
      policyId: "manual-override-upload-smart-border-fill-v1",
    });
    const otherMode = await new BleedEngine({ cache }).generate({
      imageBytes,
      bleedMm: 1,
      mode: "subtle-edge-stretch",
      policyId: "manual-override-upload-smart-border-fill-v1",
    });

    expect(first.status).toBe("derived");
    expect(otherPolicy.status).toBe("derived");
    expect(otherConfig.status).toBe("derived");
    expect(otherSearchBound.status).toBe("derived");
    expect(otherMode.status).toBe("derived");
    if (first.status !== "derived" || otherPolicy.status !== "derived" || otherConfig.status !== "derived" || otherSearchBound.status !== "derived" || otherMode.status !== "derived") {
      throw new Error("Expected all cache identity requests to return derivatives.");
    }
    expect(new Set([first.cacheKey, otherPolicy.cacheKey, otherConfig.cacheKey, otherSearchBound.cacheKey, otherMode.cacheKey]).size).toBe(5);
    expect([first, otherPolicy, otherConfig, otherSearchBound, otherMode].every((result) => result.cacheStatus === "miss")).toBe(true);
  });
});
