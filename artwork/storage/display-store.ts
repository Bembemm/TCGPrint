import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { createCoalescedRequestRegistry } from "../mpc-request-coalescer";
import { isArtworkDisplayWidthBucket, type ArtworkDisplayWidthBucket } from "../display-buckets";

const DISPLAY_ALGORITHM_VERSION = "compositor-display-v1";
const MAX_DISPLAY_INPUT_PIXELS = 100_000_000;
const MAX_DISPLAY_OUTPUT_HEIGHT_PX = 4_096;

export interface ArtworkDisplayAsset {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png";
  readonly widthPx: number;
  readonly heightPx: number;
  readonly sourceHash: string;
  readonly bucket: ArtworkDisplayWidthBucket;
}

export interface ArtworkDisplayDerivative {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png";
  readonly widthPx: number;
  readonly heightPx: number;
}

export type ArtworkDisplayDerivativeGenerator = (
  source: Uint8Array,
  bucket: ArtworkDisplayWidthBucket,
  signal: AbortSignal,
) => Promise<ArtworkDisplayDerivative>;

export interface ArtworkDisplayStoreOptions {
  readonly generateDerivative?: ArtworkDisplayDerivativeGenerator;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function abortError(): Error {
  return Object.assign(new Error("The display image request was cancelled."), { name: "AbortError" });
}

function cacheKey(assetId: string, sourceHash: string, bucket: ArtworkDisplayWidthBucket): string {
  return digest(`${DISPLAY_ALGORITHM_VERSION}\0${assetId}\0${sourceHash}\0${bucket}`);
}

async function generateDisplayDerivative(
  source: Uint8Array,
  bucket: ArtworkDisplayWidthBucket,
  signal: AbortSignal,
): Promise<ArtworkDisplayDerivative> {
  const pipeline = sharp(Buffer.from(source.buffer, source.byteOffset, source.byteLength), {
    failOn: "error",
    limitInputPixels: MAX_DISPLAY_INPUT_PIXELS,
  }).rotate().resize({
    width: bucket,
    height: MAX_DISPLAY_OUTPUT_HEIGHT_PX,
    fit: "inside",
    withoutEnlargement: true,
  }).png({ compressionLevel: 7, adaptiveFiltering: true });
  const cancel = () => pipeline.destroy(abortError());
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (signal.aborted) throw abortError();
    return { bytes: new Uint8Array(data), contentType: "image/png", widthPx: info.width, heightPx: info.height };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export class ArtworkDisplayStore {
  private readonly directory: string;
  private readonly generateDerivative: ArtworkDisplayDerivativeGenerator;
  private readonly generations = createCoalescedRequestRegistry<ArtworkDisplayAsset>();

  constructor(directory: string, options: ArtworkDisplayStoreOptions = {}) {
    this.directory = directory;
    this.generateDerivative = options.generateDerivative ?? generateDisplayDerivative;
  }

  async getOrCreate(
    assetId: string,
    sourceHash: string,
    sourceBytes: Uint8Array,
    bucket: ArtworkDisplayWidthBucket,
    signal?: AbortSignal,
  ): Promise<ArtworkDisplayAsset> {
    if (typeof assetId !== "string" || !assetId.length || assetId.length > 256 || /[\u0000-\u001f\u007f]/.test(assetId)) {
      throw new TypeError("Display asset ID must be a bounded visible string.");
    }
    if (!/^[a-f0-9]{64}$/.test(sourceHash) || digest(sourceBytes) !== sourceHash) {
      throw new TypeError("Display source hash must match the validated source bytes.");
    }
    if (!isArtworkDisplayWidthBucket(bucket)) throw new TypeError("Display width must be one of the supported buckets.");
    const key = cacheKey(assetId, sourceHash, bucket);
    return this.generations.run(key, signal, async (sharedSignal) => {
      if (sharedSignal.aborted) throw abortError();
      const path = this.pathForKey(key);
      const cached = await this.readCached(path, bucket);
      if (cached) return { ...cached, sourceHash, bucket };

      const derivative = await this.generateDerivative(sourceBytes, bucket, sharedSignal);
      if (sharedSignal.aborted) throw abortError();
      if (derivative.contentType !== "image/png"
        || derivative.widthPx <= 0 || derivative.widthPx > bucket
        || derivative.heightPx <= 0 || derivative.heightPx > MAX_DISPLAY_OUTPUT_HEIGHT_PX
        || derivative.widthPx * derivative.heightPx > bucket * MAX_DISPLAY_OUTPUT_HEIGHT_PX) {
        throw new Error("The display derivative exceeded its output dimensions.");
      }
      await this.writeAtomically(path, derivative.bytes, sharedSignal);
      return { ...derivative, sourceHash, bucket };
    }, abortError);
  }

  private pathForKey(key: string): string {
    return join(/*turbopackIgnore: true*/ this.directory, key.slice(0, 2), `${key}.png`);
  }

  private async readCached(path: string, bucket: ArtworkDisplayWidthBucket): Promise<ArtworkDisplayDerivative | undefined> {
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await readFile(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const metadata = await sharp(Buffer.from(bytes), { failOn: "error", limitInputPixels: bucket * MAX_DISPLAY_OUTPUT_HEIGHT_PX }).metadata();
      if (metadata.format !== "png" || !metadata.width || !metadata.height
        || metadata.width > bucket || metadata.height > MAX_DISPLAY_OUTPUT_HEIGHT_PX) throw new Error("Cached display derivative is invalid.");
      return { bytes, contentType: "image/png", widthPx: metadata.width, heightPx: metadata.height };
    } catch {
      await unlink(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      });
      return undefined;
    }
  }

  private async writeAtomically(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (signal.aborted) throw abortError();
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (signal.aborted) throw abortError();
      await rename(temporaryPath, path);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      });
    }
  }
}
