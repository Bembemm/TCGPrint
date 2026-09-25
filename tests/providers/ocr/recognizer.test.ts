import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TesseractOcrRecognizer } from "../../../providers/ocr/tesseract-recognizer";

async function titleBandFixture() {
  return new Uint8Array(await sharp({ create: { width: 1200, height: 800, channels: 3, background: "white" } })
    .composite([{ input: Buffer.from('<svg width="1200" height="180"><rect width="1200" height="180" fill="white"/><text x="35" y="125" fill="black" font-family="DejaVu Sans" font-size="92" font-weight="bold">SOL RING</text></svg>'), left: 0, top: 0 }])
    .png().toBuffer());
}

describe("lazy local OCR recognizer", () => {
  it("loads one worker lazily, passes only a temporary title-region crop, and never mutates original bytes", async () => {
    let image: Uint8Array | undefined;
    const original = await titleBandFixture();
    const before = new Uint8Array(original);
    const worker = { recognize: vi.fn(async (bytes: Uint8Array) => { image = new Uint8Array(bytes); return { data: { text: "SOL RING" } }; }), terminate: vi.fn(async () => undefined) };
    const workerFactory = vi.fn(async () => worker);
    const recognizer = new TesseractOcrRecognizer({ cachePath: "/tmp/tcgprint-ocr-tests", workerFactory });
    expect(workerFactory).not.toHaveBeenCalled();
    await expect(recognizer.recognizeName(original)).resolves.toBe("SOL RING");
    await recognizer.recognizeName(original);
    expect(workerFactory).toHaveBeenCalledOnce();
    expect(Buffer.from(original)).toEqual(Buffer.from(before));
    const cropMetadata = await sharp(Buffer.from(image!)).metadata();
    expect(cropMetadata.width).toBe(1200);
    expect(cropMetadata.height).toBeLessThan(250);
    await recognizer.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.runIf(process.env.TCGPRINT_RUN_LOCAL_OCR === "1")("recognizes a synthetic Magic title with the packaged local English model", async () => {
    const cachePath = await mkdtemp(join(tmpdir(), "tcgprint-ocr-model-"));
    const original = await titleBandFixture();
    const before = new Uint8Array(original);
    const recognizer = new TesseractOcrRecognizer({ cachePath });
    try {
      await expect(recognizer.recognizeName(original)).resolves.toMatch(/SOL RING/i);
      expect(Buffer.from(original)).toEqual(Buffer.from(before));
    } finally {
      await recognizer.dispose();
      await rm(cachePath, { recursive: true, force: true });
    }
  }, 20_000);
});
