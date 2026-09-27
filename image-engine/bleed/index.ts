import { createHash } from "node:crypto";
import { MAGIC_STANDARD_CARD } from "../../core/geometry";
import { FileBleedCache, MemoryBleedCache } from "./cache";
import {
  applyRoundedCornerMask,
  addRasterBleed,
  calculateRasterBleedDimensions,
  decodeRaster,
  encodeRasterPng,
  inspectRasterMetadata,
  type RasterPixels,
} from "./raster";
import {
  BLEED_ALGORITHM_VERSION,
  ROUNDED_CORNERS_VERSION,
  type BleedCache,
  type BleedMode,
  type BleedPreview,
  type BleedRequest,
  type BleedResult,
  type BleedSideDiagnostic,
  type BleedSide,
  type TrimSizeMm,
} from "./types";
export {
  resolveBleedSourcePolicy,
  type BleedModePreference,
  type BleedSourcePolicyRequest,
  type ResolvedBleedSourcePolicy,
} from "./policy";

export {
  BLEED_ALGORITHM_VERSION,
  ROUNDED_CORNERS_VERSION,
  type BleedCache,
  type BleedDerivativeResult,
  type BleedMode,
  type BleedPassthroughResult,
  type BleedPreview,
  type BleedRequest,
  type BleedResult,
  type BleedSide,
  type BleedSideDiagnostic,
  type PixelRect,
  type TrimSizeMm,
} from "./types";
export { FileBleedCache, MemoryBleedCache } from "./cache";

type BleedGenerationErrorCode =
  | "INVALID_BLEED_CONFIGURATION"
  | "IMAGE_DECODE_FAILED"
  | "CACHE_FAILED"
  | "SVG_VECTOR_BLEED_UNSUPPORTED";

export class BleedGenerationError extends Error {
  constructor(
    message: string,
    readonly code: BleedGenerationErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BleedGenerationError";
  }
}

export interface BleedEngineOptions {
  readonly cache?: BleedCache;
}

export interface BleedCacheIdentity {
  readonly originalSha256: string;
  readonly bleedMm: number;
  readonly trimWidthMm: number;
  readonly trimHeightMm: number;
  readonly roundedCorners?: boolean;
  readonly cornerRadiusMm?: number;
}

/** Shared by the engine cache and CardExportService's in-batch de-duplication. */
export function createBleedCacheKey(identity: BleedCacheIdentity): string {
  const roundedCorners = identity.roundedCorners ?? false;
  const serialized = JSON.stringify({
    algorithmVersion: BLEED_ALGORITHM_VERSION,
    originalSha256: identity.originalSha256,
    bleedMm: identity.bleedMm,
    trimWidthMm: identity.trimWidthMm,
    trimHeightMm: identity.trimHeightMm,
    roundedCorners,
    ...(roundedCorners ? {
      roundedCornersVersion: ROUNDED_CORNERS_VERSION,
      cornerRadiusMm: identity.cornerRadiusMm,
    } : {}),
  });
  return createHash("sha256").update(serialized).digest("hex");
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function bufferView(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sniffMimeType(bytes: Uint8Array): string {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (
    bytes.length >= 12
    && Buffer.from(bytes.buffer, bytes.byteOffset, 4).toString("ascii") === "RIFF"
    && Buffer.from(bytes.buffer, bytes.byteOffset + 8, 4).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (
    bytes.length >= 4
    && ((bytes[0] === 0x49 && bytes[1] === 0x49 && (bytes[2] === 0x2a || bytes[2] === 0x2b) && bytes[3] === 0)
      || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && (bytes[3] === 0x2a || bytes[3] === 0x2b)))
  ) return "image/tiff";

  try {
    const prefix = bytes.subarray(0, Math.min(bytes.byteLength, 512));
    const prefixText = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
    if (!prefixText.replace(/^\uFEFF/, "").trimStart().startsWith("<")) {
      return "application/octet-stream";
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const source = text
      .replace(/^\uFEFF/, "")
      .replace(/^(?:\s+|<\?xml\b[\s\S]*?\?>|<!--[\s\S]*?-->)+/i, "");
    if (/^<svg\b/i.test(source)) return "image/svg+xml";
  } catch {
    // Binary formats do not need a text format probe.
  }

  return "application/octet-stream";
}

function validateRequest(request: BleedRequest): {
  readonly mode: BleedMode;
  readonly trimWidthMm: number;
  readonly trimHeightMm: number;
  readonly roundedCorners: boolean;
  readonly cornerRadiusMm?: number;
} {
  if (!Number.isFinite(request.bleedMm) || request.bleedMm < 0 || request.bleedMm > 3) {
    throw new RangeError("Bleed must be a finite number from 0.000 mm through 3.000 mm.");
  }
  if (!(request.imageBytes instanceof Uint8Array)) {
    throw new TypeError("Bleed input must be a Uint8Array of the original image bytes.");
  }
  if (request.roundedCorners !== undefined && typeof request.roundedCorners !== "boolean") {
    throw new TypeError("roundedCorners must be a boolean when provided.");
  }

  const mode = request.mode ?? "edge-extension";
  if (mode !== "edge-extension") {
    throw new BleedGenerationError(`Unsupported bleed mode: ${String(mode)}.`, "INVALID_BLEED_CONFIGURATION");
  }

  const trimWidthMm = request.trimSizeMm?.widthMm ?? MAGIC_STANDARD_CARD.widthMm;
  const trimHeightMm = request.trimSizeMm?.heightMm ?? MAGIC_STANDARD_CARD.heightMm;
  const roundedCorners = request.roundedCorners ?? false;
  const hasMagicStandardTrim = trimWidthMm === MAGIC_STANDARD_CARD.widthMm
    && trimHeightMm === MAGIC_STANDARD_CARD.heightMm;
  const cornerRadiusMm = request.cornerRadiusMm
    ?? (hasMagicStandardTrim ? MAGIC_STANDARD_CARD.cornerRadiusMm : undefined);
  if (roundedCorners && (cornerRadiusMm === undefined || !Number.isFinite(cornerRadiusMm) || cornerRadiusMm <= 0)) {
    throw new RangeError("A positive CardFormat cornerRadiusMm is required when roundedCorners is enabled.");
  }
  for (const [value, label] of [[trimWidthMm, "Trim width"], [trimHeightMm, "Trim height"]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${label} must be a finite number greater than zero.`);
    }
  }

  return {
    mode,
    trimWidthMm,
    trimHeightMm,
    roundedCorners,
    cornerRadiusMm: roundedCorners ? cornerRadiusMm : undefined,
  };
}

function hasPngHeader(bytes: Uint8Array, width: number, height: number): boolean {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.readUInt32BE(16) === width && view.readUInt32BE(20) === height;
}

export class BleedEngine {
  private readonly cache: BleedCache;

  constructor(options: BleedEngineOptions = {}) {
    this.cache = options.cache ?? new MemoryBleedCache();
  }

  async generate(request: BleedRequest): Promise<BleedResult> {
    const { mode, trimWidthMm, trimHeightMm, roundedCorners, cornerRadiusMm } = validateRequest(request);
    if (request.bleedMm === 0 && !roundedCorners) {
      return {
        status: "passthrough",
        bleedMm: 0,
        mode,
        requestedMode: mode,
        effectiveMode: mode,
        policyId: request.policyId ?? "direct-mode-v1",
        roundedCorners: false,
        trimSizeMm: Object.freeze({ widthMm: trimWidthMm, heightMm: trimHeightMm }),
        cacheStatus: "bypass",
        preview: {
          bytes: request.imageBytes,
          mimeType: sniffMimeType(request.imageBytes),
        },
      };
    }

    const sourceMimeType = sniffMimeType(request.imageBytes);
    if (sourceMimeType === "image/svg+xml" && request.bleedMm > 0) {
      throw new BleedGenerationError(
        "Non-zero SVG bleed is not supported yet. The SVG trim remains vector-only; no raster fallback was generated.",
        "SVG_VECTOR_BLEED_UNSUPPORTED",
      );
    }

    let metadata: Awaited<ReturnType<typeof inspectRasterMetadata>>;
    try {
      metadata = await inspectRasterMetadata(request.imageBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown decoder error.";
      throw new BleedGenerationError(
        `Could not create bleed for this raster image. ${message}`,
        "IMAGE_DECODE_FAILED",
        { cause: error },
      );
    }

    const sourceWidthPx = metadata.width!;
    const sourceHeightPx = metadata.height!;
    const dimensions = request.bleedMm === 0
      ? { bleedXPx: 0, bleedYPx: 0 }
      : calculateRasterBleedDimensions(sourceWidthPx, sourceHeightPx, request.bleedMm, trimWidthMm, trimHeightMm);
    const outputWidthPx = sourceWidthPx + 2 * dimensions.bleedXPx;
    const outputHeightPx = sourceHeightPx + 2 * dimensions.bleedYPx;
    const sourceSha256 = createHash("sha256").update(bufferView(request.imageBytes)).digest("hex");
    const policyId = request.policyId ?? "direct-mode-v1";

    const decodedSource = await decodeRaster(request.imageBytes, metadata);
    const source = roundedCorners
      ? applyRoundedCornerMask(decodedSource, trimWidthMm, trimHeightMm, cornerRadiusMm!)
      : decodedSource;
    const sideDiagnostics: Readonly<Record<BleedSide, BleedSideDiagnostic>> = {
      top: { strategy: "nearest-edge-pixel" },
      right: { strategy: "nearest-edge-pixel" },
      bottom: { strategy: "nearest-edge-pixel" },
      left: { strategy: "nearest-edge-pixel" },
    };
    const effectiveMode = mode;
    const cacheKey = createBleedCacheKey({
      originalSha256: sourceSha256,
      bleedMm: request.bleedMm,
      trimWidthMm,
      trimHeightMm,
      roundedCorners,
      ...(roundedCorners ? { cornerRadiusMm } : {}),
    });

    let cached: Uint8Array | undefined;
    try {
      cached = await this.cache.get(cacheKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown cache error.";
      throw new BleedGenerationError(`Could not read the bleed derivative cache. ${message}`, "CACHE_FAILED", { cause: error });
    }
    if (cached && hasPngHeader(cached, outputWidthPx, outputHeightPx)) {
      return this.createDerivedResult({
        bytes: cached,
        outputWidthPx,
        outputHeightPx,
        sourceWidthPx,
        sourceHeightPx,
        request,
        mode,
        effectiveMode,
        policyId,
        sideDiagnostics,
        roundedCorners,
        cornerRadiusMm,
        trimWidthMm,
        trimHeightMm,
        sourceSha256,
        cacheKey,
        cacheStatus: "hit",
      });
    }

    const extended = addRasterBleed(source, dimensions);
    const derivedBytes = await encodeRasterPng(source, extended.width, extended.height, extended.samples);
    try {
      await this.cache.set(cacheKey, derivedBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown cache error.";
      throw new BleedGenerationError(`Could not write the bleed derivative cache. ${message}`, "CACHE_FAILED", { cause: error });
    }

    return this.createDerivedResult({
      bytes: derivedBytes,
      outputWidthPx,
      outputHeightPx,
      sourceWidthPx,
      sourceHeightPx,
      request,
      mode,
      effectiveMode,
      policyId,
      sideDiagnostics,
      roundedCorners,
      cornerRadiusMm,
      trimWidthMm,
      trimHeightMm,
      sourceSha256,
      cacheKey,
      cacheStatus: "miss",
    });
  }

  private createDerivedResult(options: {
    readonly bytes: Uint8Array;
    readonly outputWidthPx: number;
    readonly outputHeightPx: number;
    readonly sourceWidthPx: number;
    readonly sourceHeightPx: number;
    readonly request: BleedRequest;
    readonly mode: BleedMode;
    readonly effectiveMode: BleedResult["effectiveMode"];
    readonly policyId: string;
    readonly sideDiagnostics: Readonly<Record<BleedSide, BleedSideDiagnostic>>;
    readonly roundedCorners: boolean;
    readonly cornerRadiusMm?: number;
    readonly trimWidthMm: number;
    readonly trimHeightMm: number;
    readonly sourceSha256: string;
    readonly cacheKey: string;
    readonly cacheStatus: "hit" | "miss";
  }): BleedResult {
    return {
      status: "derived",
      bleedMm: options.request.bleedMm,
      mode: options.mode,
      requestedMode: options.mode,
      effectiveMode: options.effectiveMode,
      policyId: options.policyId,
      roundedCorners: options.roundedCorners,
      ...(options.roundedCorners && options.cornerRadiusMm !== undefined
        ? { cornerRadiusMm: options.cornerRadiusMm }
        : {}),
      trimSizeMm: Object.freeze({
        widthMm: options.trimWidthMm,
        heightMm: options.trimHeightMm,
      }),
      sideDiagnostics: options.sideDiagnostics,
      originalSha256: options.sourceSha256,
      algorithmVersion: BLEED_ALGORITHM_VERSION,
      cacheKey: options.cacheKey,
      cacheStatus: options.cacheStatus,
      preview: {
        bytes: options.bytes,
        mimeType: "image/png",
        widthPx: options.outputWidthPx,
        heightPx: options.outputHeightPx,
        trimRectPx: {
          x: Math.floor((options.outputWidthPx - options.sourceWidthPx) / 2),
          y: Math.floor((options.outputHeightPx - options.sourceHeightPx) / 2),
          width: options.sourceWidthPx,
          height: options.sourceHeightPx,
        },
      },
    };
  }
}
