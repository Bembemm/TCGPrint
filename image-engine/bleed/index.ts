import { createHash } from "node:crypto";
import { MAGIC_STANDARD_CARD } from "../../core/geometry";
import { FileBleedCache, MemoryBleedCache } from "./cache";
import {
  addRasterBleed,
  calculateRasterBleedDimensions,
  decodeRaster,
  encodeRasterPng,
  inspectRasterMetadata,
  type RasterBleedSideSources,
  type RasterPixels,
} from "./raster";
import {
  classifySmartBorderFillSides,
  resolveSmartBorderFillConfig,
  SMART_BORDER_FILL_CONFIG,
  type BleedSide,
  type SmartBorderFillConfig,
  type SmartBorderFillConfigOverrides,
} from "./smart-border";
import {
  BLEED_ALGORITHM_VERSION,
  type BleedCache,
  type BleedMode,
  type BleedPreview,
  type BleedRequest,
  type BleedResult,
  type BleedSideDiagnostic,
  type BleedSourceStrip,
  type TrimSizeMm,
} from "./types";
export {
  resolveBleedSourcePolicy,
  type BleedModePreference,
  type BleedSourcePolicyRequest,
  type ResolvedBleedSourcePolicy,
} from "./policy";

export {
  SMART_BORDER_FILL_CONFIG,
  SMART_BORDER_FILL_CONFIG_VERSION,
  resolveSmartBorderFillConfig,
  type BleedSide,
  type SmartBorderFillConfig,
  type SmartBorderFillConfigOverrides,
} from "./smart-border";

export {
  BLEED_ALGORITHM_VERSION,
  BLEED_SOURCE_STRIP_SUGGESTIONS_MM,
  type AutoSourceStrip,
  type BleedCache,
  type BleedDerivativeResult,
  type BleedMode,
  type BleedPassthroughResult,
  type BleedPreview,
  type BleedRequest,
  type BleedResult,
  type BleedSideDiagnostic,
  type BleedSourceStrip,
  type CustomSourceStrip,
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
  readonly smartBorderFillConfig?: SmartBorderFillConfigOverrides;
}

export interface BleedCacheIdentity {
  readonly originalSha256: string;
  readonly bleedMm: number;
  readonly mode: BleedMode;
  readonly policyId: string;
  readonly sourceStrip: BleedSourceStrip;
  readonly trimWidthMm: number;
  readonly trimHeightMm: number;
  readonly smartBorderFillConfig: SmartBorderFillConfig;
}

/** Shared by the engine cache and CardExportService's in-batch de-duplication. */
export function createBleedCacheKey(identity: BleedCacheIdentity): string {
  const serialized = JSON.stringify({ algorithmVersion: BLEED_ALGORITHM_VERSION, ...identity });
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
  readonly sourceStrip: BleedSourceStrip;
  readonly trimWidthMm: number;
  readonly trimHeightMm: number;
} {
  if (!Number.isFinite(request.bleedMm) || request.bleedMm < 0 || request.bleedMm > 3) {
    throw new RangeError("Bleed must be a finite number from 0.000 mm through 3.000 mm.");
  }
  if (!(request.imageBytes instanceof Uint8Array)) {
    throw new TypeError("Bleed input must be a Uint8Array of the original image bytes.");
  }

  const mode = request.mode ?? "subtle-edge-stretch";
  if (mode !== "subtle-edge-stretch" && mode !== "smart-border-fill") {
    throw new BleedGenerationError(`Unsupported bleed mode: ${String(mode)}.`, "INVALID_BLEED_CONFIGURATION");
  }

  const sourceStrip = request.sourceStrip ?? { mode: "auto" };
  if (sourceStrip.mode === "custom") {
    if (!Number.isFinite(sourceStrip.widthMm) || sourceStrip.widthMm <= 0 || sourceStrip.widthMm > 3) {
      throw new RangeError("Custom source strip must be a finite width greater than 0 mm and at most 3 mm.");
    }
  } else if (sourceStrip.mode !== "auto") {
    throw new BleedGenerationError("Unsupported source strip mode.", "INVALID_BLEED_CONFIGURATION");
  }

  const trimWidthMm = request.trimSizeMm?.widthMm ?? MAGIC_STANDARD_CARD.widthMm;
  const trimHeightMm = request.trimSizeMm?.heightMm ?? MAGIC_STANDARD_CARD.heightMm;
  for (const [value, label] of [[trimWidthMm, "Trim width"], [trimHeightMm, "Trim height"]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${label} must be a finite number greater than zero.`);
    }
  }

  return {
    mode,
    sourceStrip: Object.freeze({ ...sourceStrip }),
    trimWidthMm,
    trimHeightMm,
  };
}

function hasPngHeader(bytes: Uint8Array, width: number, height: number): boolean {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.readUInt32BE(16) === width && view.readUInt32BE(20) === height;
}

function calculateStripWidth(sourceStrip: BleedSourceStrip, bleedMm: number): number {
  return sourceStrip.mode === "auto"
    ? Math.min(bleedMm, 1)
    : Math.min(sourceStrip.widthMm, bleedMm);
}

export class BleedEngine {
  private readonly cache: BleedCache;
  private readonly smartBorderFillConfig: SmartBorderFillConfig;

  constructor(options: BleedEngineOptions = {}) {
    this.cache = options.cache ?? new MemoryBleedCache();
    this.smartBorderFillConfig = resolveSmartBorderFillConfig(options.smartBorderFillConfig);
  }

  async generate(request: BleedRequest): Promise<BleedResult> {
    const { mode, sourceStrip, trimWidthMm, trimHeightMm } = validateRequest(request);
    if (request.bleedMm === 0) {
      return {
        status: "passthrough",
        bleedMm: 0,
        mode,
        requestedMode: mode,
        effectiveMode: mode,
        policyId: request.policyId ?? "direct-mode-v1",
        sourceStrip,
        trimSizeMm: Object.freeze({ widthMm: trimWidthMm, heightMm: trimHeightMm }),
        cacheStatus: "bypass",
        preview: {
          bytes: request.imageBytes,
          mimeType: sniffMimeType(request.imageBytes),
        },
      };
    }

    const sourceMimeType = sniffMimeType(request.imageBytes);
    if (sourceMimeType === "image/svg+xml") {
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
    const resolvedSourceStripMm = calculateStripWidth(sourceStrip, request.bleedMm);
    const dimensions = calculateRasterBleedDimensions(
      sourceWidthPx,
      sourceHeightPx,
      request.bleedMm,
      resolvedSourceStripMm,
      trimWidthMm,
      trimHeightMm,
    );
    const outputWidthPx = sourceWidthPx + 2 * dimensions.bleedXPx;
    const outputHeightPx = sourceHeightPx + 2 * dimensions.bleedYPx;
    const sourceSha256 = createHash("sha256").update(bufferView(request.imageBytes)).digest("hex");
    const policyId = request.policyId ?? "direct-mode-v1";

    let source: RasterPixels | undefined;
    let rasterSideSources: RasterBleedSideSources | undefined;
    let sideDiagnostics: Readonly<Record<BleedSide, BleedSideDiagnostic>>;
    if (mode === "smart-border-fill") {
      try {
        source = await decodeRaster(request.imageBytes, metadata);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown decoder error.";
        throw new BleedGenerationError(`Could not create bleed for this raster image. ${message}`, "IMAGE_DECODE_FAILED", { cause: error });
      }
      const classified = classifySmartBorderFillSides(
        source,
        dimensions.sourceStripXPx,
        dimensions.sourceStripYPx,
        trimWidthMm,
        trimHeightMm,
        this.smartBorderFillConfig,
      );
      const rasterSource = (side: BleedSide) => ({
        offsetPx: classified[side].offsetPx,
        sourceStripPx: classified[side].sourceStripPx,
      });
      const diagnostic = (side: BleedSide): BleedSideDiagnostic => ({
        requestedMode: mode,
        effectiveMode: classified[side].effectiveMode,
        classification: classified[side].classification,
        sourceOffsetPx: classified[side].offsetPx,
        sourceStripPx: classified[side].sourceStripPx,
        ...(classified[side].fallbackReason ? { fallbackReason: classified[side].fallbackReason } : {}),
      });
      rasterSideSources = {
        top: rasterSource("top"),
        right: rasterSource("right"),
        bottom: rasterSource("bottom"),
        left: rasterSource("left"),
      };
      sideDiagnostics = {
        top: diagnostic("top"),
        right: diagnostic("right"),
        bottom: diagnostic("bottom"),
        left: diagnostic("left"),
      };
    } else {
      sideDiagnostics = Object.fromEntries((["top", "right", "bottom", "left"] as const).map((side) => [side, {
        requestedMode: mode,
        effectiveMode: mode,
        classification: "not-analyzed" as const,
        sourceOffsetPx: 0,
        sourceStripPx: side === "left" || side === "right" ? dimensions.sourceStripXPx : dimensions.sourceStripYPx,
      }])) as Readonly<Record<BleedSide, BleedSideDiagnostic>>;
    }
    const effectiveSides = Object.values(sideDiagnostics).map((diagnostic) => diagnostic.effectiveMode);
    const effectiveMode = effectiveSides.every((sideMode) => sideMode === effectiveSides[0])
      ? effectiveSides[0]!
      : "mixed";
    const cacheKey = createBleedCacheKey({
      originalSha256: sourceSha256,
      bleedMm: request.bleedMm,
      mode,
      policyId,
      sourceStrip,
      trimWidthMm,
      trimHeightMm,
      smartBorderFillConfig: this.smartBorderFillConfig,
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
        sourceStrip,
        trimWidthMm,
        trimHeightMm,
        sourceSha256,
        cacheKey,
        resolvedSourceStripMm,
        cacheStatus: "hit",
      });
    }

    if (!source) {
      try {
        source = await decodeRaster(request.imageBytes, metadata);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown decoder error.";
        throw new BleedGenerationError(
          `Could not create bleed for this raster image. ${message}`,
          "IMAGE_DECODE_FAILED",
          { cause: error },
        );
      }
    }

    const extended = addRasterBleed(source, dimensions, rasterSideSources);
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
      sourceStrip,
      trimWidthMm,
      trimHeightMm,
      sourceSha256,
      cacheKey,
      resolvedSourceStripMm,
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
    readonly sourceStrip: BleedSourceStrip;
    readonly trimWidthMm: number;
    readonly trimHeightMm: number;
    readonly sourceSha256: string;
    readonly cacheKey: string;
    readonly resolvedSourceStripMm: number;
    readonly cacheStatus: "hit" | "miss";
  }): BleedResult {
    return {
      status: "derived",
      bleedMm: options.request.bleedMm,
      mode: options.mode,
      requestedMode: options.mode,
      effectiveMode: options.effectiveMode,
      policyId: options.policyId,
      sourceStrip: options.sourceStrip,
      trimSizeMm: Object.freeze({
        widthMm: options.trimWidthMm,
        heightMm: options.trimHeightMm,
      }),
      resolvedSourceStripMm: options.resolvedSourceStripMm,
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
