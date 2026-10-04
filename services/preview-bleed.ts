import {
  addRasterBleed,
  applyRoundedCornerMask,
  calculateRasterBleedDimensions,
  decodeRaster,
  encodeRasterPng,
  inspectRasterMetadata,
} from "../image-engine/bleed/raster";

export interface PreviewBleedRequest {
  readonly bleedMm: number;
  readonly trimWidthMm: number;
  readonly trimHeightMm: number;
  readonly roundedCorners?: boolean;
  readonly cornerRadiusMm?: number;
}

export interface PreviewBleedResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const MAX_PREVIEW_INPUT_PIXELS = 24_000_000;

/** Adds only a small edge-copy preview around a cached thumbnail. It never reads or creates a print original. */
export async function extendPreviewBleed(
  bytes: Uint8Array,
  contentType: string,
  request: PreviewBleedRequest,
): Promise<PreviewBleedResult> {
  if (!Number.isFinite(request.bleedMm) || request.bleedMm < 0 || request.bleedMm > 3
    || !Number.isFinite(request.trimWidthMm) || request.trimWidthMm <= 0 || request.trimWidthMm > 2_000
    || !Number.isFinite(request.trimHeightMm) || request.trimHeightMm <= 0 || request.trimHeightMm > 2_000) {
    throw new RangeError("Preview bleed dimensions are invalid.");
  }
  if (request.bleedMm === 0 && !request.roundedCorners) return { bytes: new Uint8Array(bytes), contentType };

  const metadata = await inspectRasterMetadata(bytes);
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PREVIEW_INPUT_PIXELS) {
    throw new RangeError("Artwork preview exceeds the pixel processing limit.");
  }
  const dimensions = calculateRasterBleedDimensions(metadata.width, metadata.height, request.bleedMm, request.trimWidthMm, request.trimHeightMm);
  if (dimensions.bleedXPx > 10_000 || dimensions.bleedYPx > 10_000) throw new RangeError("Preview bleed exceeds the image processing limit.");
  const decoded = await decodeRaster(bytes, metadata);
  const source = request.roundedCorners
    ? applyRoundedCornerMask(decoded, request.trimWidthMm, request.trimHeightMm, request.cornerRadiusMm ?? 0)
    : decoded;
  const extended = addRasterBleed(source, dimensions);
  const output = await encodeRasterPng(source, extended.width, extended.height, extended.samples);
  return { bytes: output, contentType: "image/png" };
}
