import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { BleedEngine } from "../../image-engine/bleed";

async function darkFrameWithinFivePercentOfTrim(): Promise<Uint8Array> {
  const width = 488;
  const height = 680;
  const frame = 24;
  const samples = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isDarkFrame = x < frame || x >= width - frame || y < frame || y >= height - frame;
      const pixel = (y * width + x) * 3;
      samples[pixel] = isDarkFrame ? 3 : 48;
      samples[pixel + 1] = isDarkFrame ? 4 : 126;
      samples[pixel + 2] = isDarkFrame ? 5 : 214;
    }
  }
  return new Uint8Array(await sharp(samples, { raw: { width, height, channels: 3 } }).png().toBuffer());
}

describe("smart-border-fill geometry-derived search bound", () => {
  it("finds source strips at the 24-pixel frame without exceeding five percent of either physical trim dimension", async () => {
    const result = await new BleedEngine().generate({
      imageBytes: await darkFrameWithinFivePercentOfTrim(),
      bleedMm: 1,
      mode: "smart-border-fill",
    });

    expect(result.status).toBe("derived");
    if (result.status !== "derived") throw new Error("Expected a derived raster.");
    expect(result.sideDiagnostics).toMatchObject({
      top: { effectiveMode: "smart-border-fill", sourceOffsetPx: 24 },
      right: { effectiveMode: "smart-border-fill", sourceOffsetPx: 24 },
      bottom: { effectiveMode: "smart-border-fill", sourceOffsetPx: 24 },
      left: { effectiveMode: "smart-border-fill", sourceOffsetPx: 24 },
    });
  });
});
