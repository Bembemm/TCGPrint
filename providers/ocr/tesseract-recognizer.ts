import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { IDENTITY_RESOLUTION_POLICY } from "../../core/cards/identity-policy";
import type { OcrRecognizer, OcrWorker, OcrWorkerFactory } from "./types";

export interface TesseractOcrRecognizerOptions {
  readonly cachePath: string;
  readonly workerFactory?: OcrWorkerFactory;
  readonly maximumInputBytes?: number;
}

async function createTesseractWorker(cachePath: string): Promise<OcrWorker> {
  await mkdir(cachePath, { recursive: true, mode: 0o700 });
  const tesseract = await import("tesseract.js");
  const require = createRequire(join(process.cwd(), "package.json"));
  const workerPath = require.resolve("tesseract.js/src/worker-script/node/index.js");
  const coreEntry = require.resolve("tesseract.js-core/tesseract-core.wasm.js");
  const languageDataRoot = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
  const corePath = dirname(coreEntry);
  const langPath = join(languageDataRoot, "4.0.0_best_int");
  return tesseract.createWorker("eng", 1, { workerPath, corePath, langPath, cachePath, cacheMethod: "write", logger: () => undefined }) as unknown as OcrWorker;
}

export class TesseractOcrRecognizer implements OcrRecognizer {
  private readonly cachePath: string;
  private readonly workerFactory: OcrWorkerFactory;
  private readonly maximumInputBytes: number;
  private worker?: Promise<OcrWorker>;

  constructor(options: TesseractOcrRecognizerOptions) {
    this.cachePath = options.cachePath;
    this.workerFactory = options.workerFactory ?? (() => createTesseractWorker(options.cachePath));
    this.maximumInputBytes = options.maximumInputBytes ?? 50 * 1024 * 1024;
  }

  async recognizeName(imageBytes: Uint8Array, options: { readonly signal?: AbortSignal } = {}): Promise<string | undefined> {
    if (typeof window !== "undefined") throw new Error("Tesseract OCR is available only in the server-side Node runtime.");
    if (options.signal?.aborted) throw new DOMException("OCR cancelled.", "AbortError");
    if (imageBytes.byteLength === 0 || imageBytes.byteLength > this.maximumInputBytes) throw new RangeError("OCR input is empty or exceeds the configured image size limit.");
    if (!this.worker) this.worker = this.workerFactory();
    let worker: OcrWorker;
    try { worker = await this.worker; } catch (error) { this.worker = undefined; throw error; }
    if (options.signal?.aborted) throw new DOMException("OCR cancelled.", "AbortError");
    const metadata = await sharp(Buffer.from(imageBytes), { failOn: "error", limitInputPixels: 100_000_000 }).metadata();
    if (!metadata.width || !metadata.height) return undefined;
    const height = Math.max(1, Math.min(metadata.height, Math.round(metadata.height * IDENTITY_RESOLUTION_POLICY.ocrTitleBandHeightRatio)));
    const titleBand = new Uint8Array(await sharp(Buffer.from(imageBytes), { failOn: "error", limitInputPixels: 100_000_000 })
      .extract({ left: 0, top: 0, width: metadata.width, height })
      .png()
      .withMetadata({ density: IDENTITY_RESOLUTION_POLICY.ocrOutputDpi })
      .toBuffer());
    if (options.signal?.aborted) throw new DOMException("OCR cancelled.", "AbortError");
    const output = await worker.recognize(titleBand);
    if (options.signal?.aborted) throw new DOMException("OCR cancelled.", "AbortError");
    const name = output.data.text?.replace(/\s+/g, " ").trim();
    return name || undefined;
  }

  async dispose(): Promise<void> {
    const pending = this.worker;
    this.worker = undefined;
    const worker = await pending?.catch(() => undefined);
    if (worker) await worker.terminate();
  }
}
