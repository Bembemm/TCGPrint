import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BLEED_ALGORITHM_VERSION, BleedEngine, MemoryBleedCache } from "../../image-engine/bleed";

const WIDTH = 127;
const HEIGHT = 178;

type Pixel = readonly [number, number, number];
type RgbaPixel = readonly [number, number, number, number];

async function encodePixels(pixelAt: (x: number, y: number) => Pixel): Promise<Uint8Array> {
  const samples = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      samples.set(pixelAt(x, y), offset);
    }
  }
  return new Uint8Array(await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer());
}

async function encodeRgbaPixels(pixelAt: (x: number, y: number) => RgbaPixel): Promise<Uint8Array> {
  const samples = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      samples.set(pixelAt(x, y), offset);
    }
  }
  return new Uint8Array(await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer());
}

async function decode(bytes: Uint8Array) {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function pixelAt(image: Awaited<ReturnType<typeof decode>>, x: number, y: number): number[] {
  const offset = (y * image.width + x) * image.channels;
  return Array.from(image.data.subarray(offset, offset + image.channels));
}

const EDGE_FIXTURES = [
  {
    name: "black border",
    pixelAt: (x: number, y: number): Pixel => x === 0 || x === WIDTH - 1 || y === 0 || y === HEIGHT - 1
      ? [0, 0, 0]
      : [176, 84, 39],
  },
  {
    name: "full-art texture",
    pixelAt: (x: number, y: number): Pixel => [
      (x * 7 + y * 3) % 256,
      (x * 2 + y * 11) % 256,
      (x * 13 + y * 5) % 256,
    ],
  },
  {
    name: "light border",
    pixelAt: (x: number, y: number): Pixel => x === 0 || x === WIDTH - 1 || y === 0 || y === HEIGHT - 1
      ? [245, 243, 237]
      : [32, 104, 188],
  },
  {
    name: "asymmetric sides",
    pixelAt: (x: number, y: number): Pixel => y === 0 ? [230, 35, 40]
      : x === WIDTH - 1 ? [35, 210, 70]
        : y === HEIGHT - 1 ? [35, 75, 225]
          : x === 0 ? [235, 205, 25]
            : [(x * 3) % 256, (y * 5) % 256, (x + y) % 256],
  },
] as const;

describe("immediate-edge bleed", () => {
  it.each([0, 0.625, 1, 2, 3])("preserves or extends black, full-art, light, and asymmetric pixels at %s mm", async (bleedMm) => {
    for (const fixture of EDGE_FIXTURES) {
      const original = await encodePixels(fixture.pixelAt);
      const source = await decode(original);
      const result = await new BleedEngine().generate({ imageBytes: original, bleedMm });

      if (bleedMm === 0) {
        expect(result.status, fixture.name).toBe("passthrough");
        const output = await decode(result.preview.bytes);
        expect(output.width).toBe(source.width);
        expect(output.height).toBe(source.height);
        expect(output.data).toEqual(source.data);
        continue;
      }

      expect(result.status, fixture.name).toBe("derived");
      if (result.status !== "derived") throw new Error("Expected a derived edge extension.");
      const output = await decode(result.preview.bytes);
      const trim = result.preview.trimRectPx;
      const expected = Buffer.alloc(output.data.byteLength);
      for (let y = 0; y < output.height; y += 1) {
        for (let x = 0; x < output.width; x += 1) {
          const sourceX = Math.max(0, Math.min(source.width - 1, x - trim.x));
          const sourceY = Math.max(0, Math.min(source.height - 1, y - trim.y));
          const sourceOffset = (sourceY * source.width + sourceX) * source.channels;
          const targetOffset = (y * output.width + x) * output.channels;
          source.data.copy(expected, targetOffset, sourceOffset, sourceOffset + source.channels);
        }
      }
      expect(output.data, fixture.name).toEqual(expected);
    }
  });

  it.each([0.625, 1, 2, 3])("extends every edge and corner from the adjacent trim pixels at %s mm", async (bleedMm) => {
    const original = await encodePixels((x, y) => [x % 256, y % 256, (x * 3 + y * 5) % 256]);
    const source = await decode(original);
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived edge extension.");
    const output = await decode(result.preview.bytes);
    const trim = result.preview.trimRectPx;

    for (let y = 0; y < output.height; y += 1) {
      for (let x = 0; x < output.width; x += 1) {
        const sourceX = Math.max(0, Math.min(source.width - 1, x - trim.x));
        const sourceY = Math.max(0, Math.min(source.height - 1, y - trim.y));
        expect(pixelAt(output, x, y)).toEqual(pixelAt(source, sourceX, sourceY));
      }
    }
    expect(result.algorithmVersion).toBe("edge-extension-v1");
  });

  it.each([0.625, 1, 2, 3])("keeps a black border black throughout all four bleed sides at %s mm", async (bleedMm) => {
    const original = await encodePixels((x, y) => {
      const isOuterEdge = x === 0 || x === WIDTH - 1 || y === 0 || y === HEIGHT - 1;
      return isOuterEdge ? [0, 0, 0] : [176, 84, 39];
    });
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived edge extension.");
    const output = await decode(result.preview.bytes);
    const trim = result.preview.trimRectPx;

    for (let y = 0; y < output.height; y += 1) {
      for (let x = 0; x < output.width; x += 1) {
        const outsideTrim = x < trim.x || x >= trim.x + trim.width || y < trim.y || y >= trim.y + trim.height;
        if (outsideTrim) expect(pixelAt(output, x, y)).toEqual([0, 0, 0]);
      }
    }
  });

  it("requires an explicit radius for non-Magic trims", async () => {
    const original = await encodeRgbaPixels(() => [25, 90, 155, 255]);

    await expect(new BleedEngine().generate({
      imageBytes: original,
      bleedMm: 0,
      roundedCorners: true,
      trimSizeMm: { widthMm: 70, heightMm: 100 },
    })).rejects.toThrow(/cornerRadiusMm/);

    const explicitRadius = await new BleedEngine().generate({
      imageBytes: original,
      bleedMm: 0,
      roundedCorners: true,
      trimSizeMm: { widthMm: 70, heightMm: 100 },
      cornerRadiusMm: 3.5,
    });
    expect(explicitRadius).toMatchObject({ status: "derived", cornerRadiusMm: 3.5 });
  });

  it("rounds square corners only when the separate option is enabled", async () => {
    const original = await encodeRgbaPixels(() => [25, 90, 155, 255]);
    const result = await new BleedEngine().generate({
      imageBytes: original,
      bleedMm: 0,
      roundedCorners: true,
      cornerRadiusMm: 3.175,
    });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a rounded-corner derivative.");
    expect(result.roundedCorners).toBe(true);
    const output = await decode(result.preview.bytes);
    expect(output.width).toBe(WIDTH);
    expect(output.height).toBe(HEIGHT);
    expect(pixelAt(output, 0, 0)).toEqual([25, 90, 155, 0]);
    expect(pixelAt(output, WIDTH - 1, 0)).toEqual([25, 90, 155, 0]);
    expect(pixelAt(output, 0, HEIGHT - 1)).toEqual([25, 90, 155, 0]);
    expect(pixelAt(output, WIDTH - 1, HEIGHT - 1)).toEqual([25, 90, 155, 0]);
    expect(pixelAt(output, Math.floor(WIDTH / 2), 0)).toEqual([25, 90, 155, 255]);
    expect(pixelAt(output, Math.floor(WIDTH / 2), HEIGHT - 1)).toEqual([25, 90, 155, 255]);
    expect(pixelAt(output, 0, Math.floor(HEIGHT / 2))).toEqual([25, 90, 155, 255]);
    expect(pixelAt(output, WIDTH - 1, Math.floor(HEIGHT / 2))).toEqual([25, 90, 155, 255]);
    expect(pixelAt(output, Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2))).toEqual([25, 90, 155, 255]);

    const source = await decode(original);
    const inputRgb = Buffer.alloc(WIDTH * HEIGHT * 3);
    const outputRgb = Buffer.alloc(WIDTH * HEIGHT * 3);
    const inputOutsideCornerAlpha: number[] = [];
    const outputOutsideCornerAlpha: number[] = [];
    const radiusXPx = (WIDTH * 3.175) / 63.5;
    const radiusYPx = (HEIGHT * 3.175) / 88.9;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const sourcePixel = pixelAt(source, x, y);
        const outputPixel = pixelAt(output, x, y);
        const rgbOffset = (y * WIDTH + x) * 3;
        inputRgb.set(sourcePixel.slice(0, 3), rgbOffset);
        outputRgb.set(outputPixel.slice(0, 3), rgbOffset);
        const inCorner = (x < radiusXPx || x >= WIDTH - radiusXPx)
          && (y < radiusYPx || y >= HEIGHT - radiusYPx);
        if (!inCorner) {
          inputOutsideCornerAlpha.push(sourcePixel[3]!);
          outputOutsideCornerAlpha.push(outputPixel[3]!);
        }
      }
    }
    expect(outputRgb).toEqual(inputRgb);
    expect(outputOutsideCornerAlpha).toEqual(inputOutsideCornerAlpha);
  });

  it("keeps zero-bleed source bytes pixel-identical when rounded corners are explicitly OFF", async () => {
    const original = await encodeRgbaPixels((x, y) => [x, y, x + y, 255]);
    const result = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0, roundedCorners: false });

    expect(result.status).toBe("passthrough");
    expect(result.roundedCorners).toBe(false);
    expect(result.preview.bytes).toBe(original);
  });

  it("does not add a second rounded-corner effect to an already rounded asset", async () => {
    const original = await encodeRgbaPixels(() => [25, 90, 155, 255]);
    const options = { bleedMm: 0, roundedCorners: true, cornerRadiusMm: 3.175 } as const;
    const first = await new BleedEngine().generate({ imageBytes: original, ...options });
    if (first.status !== "derived") throw new Error("Expected a rounded-corner derivative.");
    const second = await new BleedEngine().generate({ imageBytes: first.preview.bytes, ...options });
    if (second.status !== "derived") throw new Error("Expected an idempotent rounded-corner derivative.");

    expect(second.preview.widthPx).toBe(first.preview.widthPx);
    expect(second.preview.heightPx).toBe(first.preview.heightPx);
    expect(await decode(second.preview.bytes)).toEqual(await decode(first.preview.bytes));
  });

  it("preserves an existing larger alpha-rounded corner when the option is enabled", async () => {
    const original = await encodeRgbaPixels(() => [25, 90, 155, 255]);
    const alreadyRounded = await new BleedEngine().generate({
      imageBytes: original,
      bleedMm: 0,
      roundedCorners: true,
      cornerRadiusMm: 5,
    });
    if (alreadyRounded.status !== "derived") throw new Error("Expected a rounded-corner derivative.");
    const reapplied = await new BleedEngine().generate({
      imageBytes: alreadyRounded.preview.bytes,
      bleedMm: 0,
      roundedCorners: true,
      cornerRadiusMm: 3.175,
    });
    if (reapplied.status !== "derived") throw new Error("Expected the already-rounded derivative to remain derived.");

    expect(await decode(reapplied.preview.bytes)).toEqual(await decode(alreadyRounded.preview.bytes));
  });

  it("includes rounded-corner selection and radius in the derivative cache identity", async () => {
    const cache = new MemoryBleedCache();
    const engine = new BleedEngine({ cache });
    const imageBytes = await encodeRgbaPixels(() => [25, 90, 155, 255]);
    const off = await engine.generate({ imageBytes, bleedMm: 1, roundedCorners: false });
    const on = await engine.generate({ imageBytes, bleedMm: 1, roundedCorners: true, cornerRadiusMm: 3.175 });
    const otherRadius = await engine.generate({ imageBytes, bleedMm: 1, roundedCorners: true, cornerRadiusMm: 4 });

    expect(off.status).toBe("derived");
    expect(on.status).toBe("derived");
    expect(otherRadius.status).toBe("derived");
    if (off.status !== "derived" || on.status !== "derived" || otherRadius.status !== "derived") throw new Error("Expected derivative results.");
    expect(new Set([off.cacheKey, on.cacheKey, otherRadius.cacheKey]).size).toBe(3);
  });
});
