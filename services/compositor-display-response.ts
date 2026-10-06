import { createHash } from "node:crypto";
import { isArtworkDisplayWidthBucket, type ArtworkDisplayWidthBucket } from "../artwork/display-buckets";
import type { ArtworkDisplayAsset } from "../artwork/storage/display-store";
import { extendPreviewBleed, type PreviewBleedRequest } from "./preview-bleed";
import { inspectRasterMetadata } from "../image-engine/bleed/raster";

export class DisplayRequestError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DisplayRequestError";
  }
}

export function parseDisplayWidth(url: URL): ArtworkDisplayWidthBucket {
  const values = url.searchParams.getAll("width");
  if (values.length !== 1 || !/^(512|768|1024|1280)$/.test(values[0]!)) {
    throw new DisplayRequestError("width must be one of 512, 768, 1024, or 1280.");
  }
  const width = Number(values[0]);
  if (!isArtworkDisplayWidthBucket(width)) throw new DisplayRequestError("width must be one of 512, 768, 1024, or 1280.");
  return width;
}

export function parseDisplayBleedGeometry(url: URL): PreviewBleedRequest | undefined {
  const bleedValue = url.searchParams.get("bleedMm");
  const trimWidthValue = url.searchParams.get("trimWidthMm");
  const trimHeightValue = url.searchParams.get("trimHeightMm");
  const roundedValue = url.searchParams.get("roundedCorners");
  const cornerRadiusValue = url.searchParams.get("cornerRadiusMm");
  if (bleedValue === null && trimWidthValue === null && trimHeightValue === null && roundedValue === null && cornerRadiusValue === null) return undefined;
  if (bleedValue === null || trimWidthValue === null || trimHeightValue === null) {
    throw new DisplayRequestError("Display bleed requires bleed and physical trim dimensions.");
  }
  if (roundedValue !== null && roundedValue !== "true" && roundedValue !== "false") {
    throw new DisplayRequestError("roundedCorners must be true or false.");
  }
  if (cornerRadiusValue !== null && (roundedValue !== "true" || !Number.isFinite(Number(cornerRadiusValue)))) {
    throw new DisplayRequestError("A physical corner radius requires rounded corners.");
  }
  return {
    bleedMm: Number(bleedValue),
    trimWidthMm: Number(trimWidthValue),
    trimHeightMm: Number(trimHeightValue),
    roundedCorners: roundedValue === "true",
    ...(cornerRadiusValue !== null ? { cornerRadiusMm: Number(cornerRadiusValue) } : {}),
  };
}

function matchesEntityTag(request: Request, etag: string): boolean {
  return (request.headers.get("if-none-match") ?? "").split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate.replace(/^W\//, "") === etag;
  });
}

export async function compositorDisplayResponse(
  request: Request,
  asset: ArtworkDisplayAsset,
  bucket: ArtworkDisplayWidthBucket,
): Promise<Response> {
  const geometry = parseDisplayBleedGeometry(new URL(request.url));
  let bytes = new Uint8Array(asset.bytes);
  let contentType: string = asset.contentType;
  if (geometry) {
    try {
      const extended = await extendPreviewBleed(bytes, contentType, geometry);
      bytes = new Uint8Array(extended.bytes);
      contentType = extended.contentType;
    } catch (error) {
      if (error instanceof RangeError) throw new DisplayRequestError(error.message, error);
      throw error;
    }
  }
  let metadata: Awaited<ReturnType<typeof inspectRasterMetadata>>;
  try { metadata = await inspectRasterMetadata(bytes); }
  catch (error) { throw new Error("Compositor display derivative is not a bounded raster image.", { cause: error }); }
  const etag = `"sha256-${createHash("sha256").update(bytes).digest("hex")}"`;
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: etag,
    "X-TCGPrint-Artwork-Role": "compositor-display",
    "X-TCGPrint-Display-Bucket": String(bucket),
    "X-TCGPrint-Display-Width": String(metadata.width),
    "X-TCGPrint-Display-Height": String(metadata.height),
  });
  if (matchesEntityTag(request, etag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(bytes.byteLength));
  return new Response(bytes, { headers });
}
