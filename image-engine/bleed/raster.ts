import sharp from "sharp";

type SharpMetadata = import("sharp").Metadata;
type SharpChannels = import("sharp").Channels;

export interface RasterPixels {
  readonly width: number;
  readonly height: number;
  readonly channels: SharpChannels;
  readonly depth: "uchar" | "ushort";
  readonly samples: Uint8Array | Uint16Array;
  readonly outputColourspace?: "rgb16" | "grey16";
}

export interface RasterBleedDimensions {
  readonly bleedXPx: number;
  readonly bleedYPx: number;
  readonly sourceStripXPx: number;
  readonly sourceStripYPx: number;
}

export async function inspectRasterMetadata(imageBytes: Uint8Array): Promise<SharpMetadata> {
  const input = Buffer.from(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength);
  const metadata = await sharp(input, { failOn: "error" }).metadata();
  if (!(metadata.width && metadata.height)) throw new Error("Image dimensions are missing.");
  if (!["jpeg", "png", "webp", "tiff"].includes(metadata.format ?? "")) {
    throw new Error(`Raster format ${metadata.format ?? "unknown"} is not supported for bleed.`);
  }
  return metadata;
}

function sourceColourspace(metadata: SharpMetadata): "grey16" | "rgb16" | undefined {
  if (metadata.depth !== "ushort") return undefined;

  const isGray = metadata.space === "b-w"
    || metadata.space === "grey16"
    || metadata.channels === 1
    || (metadata.channels === 2 && metadata.hasAlpha);

  return isGray ? "grey16" : "rgb16";
}

function needsEightBitColourConversion(metadata: SharpMetadata): boolean {
  const isGray = metadata.space === "b-w"
    || metadata.space === "grey16"
    || metadata.channels === 1
    || (metadata.channels === 2 && metadata.hasAlpha);

  if (isGray) return metadata.channels !== (metadata.hasAlpha ? 2 : 1);
  return metadata.channels !== (metadata.hasAlpha ? 4 : 3);
}

export async function decodeRaster(
  imageBytes: Uint8Array,
  knownMetadata?: SharpMetadata,
): Promise<RasterPixels> {
  const input = Buffer.from(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength);

  try {
    const metadata = knownMetadata ?? await inspectRasterMetadata(imageBytes);

    const colourspace = sourceColourspace(metadata);
    const pipeline = sharp(input, { failOn: "error" });
    if (colourspace) {
      pipeline.toColourspace(colourspace);
    } else if (needsEightBitColourConversion(metadata)) {
      pipeline.toColourspace("srgb");
    }

    const depth = metadata.depth === "ushort" ? "ushort" : "uchar";
    const { data, info } = await pipeline.raw({ depth }).toBuffer({ resolveWithObject: true });
    if (
      info.width !== metadata.width
      || info.height !== metadata.height
      || ![1, 2, 3, 4].includes(info.channels)
      || data.byteLength !== info.width * info.height * info.channels * (depth === "ushort" ? 2 : 1)
    ) {
      throw new Error("Raster decoder returned incompatible pixel dimensions or channels.");
    }

    const samples = depth === "ushort"
      ? new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
      : data;

    return {
      width: info.width,
      height: info.height,
      channels: info.channels,
      depth,
      samples,
      outputColourspace: colourspace,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown image decoder error.";
    throw new Error(`Could not decode raster image for bleed: ${message}`, { cause: error });
  }
}

function mapBleedDepthToSourceStrip(depthPx: number, bleedPx: number, stripPx: number): number {
  return Math.min(stripPx - 1, Math.floor(((depthPx - 1) * stripPx) / bleedPx));
}

function copyPixel(
  source: RasterPixels,
  target: Uint8Array | Uint16Array,
  sourceX: number,
  sourceY: number,
  targetPixel: number,
): void {
  const sourceStart = (sourceY * source.width + sourceX) * source.channels;
  const targetStart = targetPixel * source.channels;
  target.set(source.samples.subarray(sourceStart, sourceStart + source.channels), targetStart);
}

export function addRasterBleed(
  source: RasterPixels,
  dimensions: RasterBleedDimensions,
): { readonly width: number; readonly height: number; readonly samples: Uint8Array | Uint16Array } {
  const { bleedXPx, bleedYPx, sourceStripXPx, sourceStripYPx } = dimensions;
  const width = source.width + bleedXPx * 2;
  const height = source.height + bleedYPx * 2;
  const sampleCount = width * height * source.channels;
  const samples = source.depth === "ushort" ? new Uint16Array(sampleCount) : new Uint8Array(sampleCount);

  for (let y = 0; y < height; y += 1) {
    const sourceY = y - bleedYPx;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - bleedXPx;
      const outsideX = sourceX < 0 || sourceX >= source.width;
      const outsideY = sourceY < 0 || sourceY >= source.height;
      let sampleX: number;
      let sampleY: number;

      if (!outsideX && !outsideY) {
        sampleX = sourceX;
        sampleY = sourceY;
      } else if (outsideX && outsideY) {
        const depthX = sourceX < 0 ? -sourceX : sourceX - source.width + 1;
        const depthY = sourceY < 0 ? -sourceY : sourceY - source.height + 1;
        const stripOffsetX = mapBleedDepthToSourceStrip(depthX, bleedXPx, sourceStripXPx);
        const stripOffsetY = mapBleedDepthToSourceStrip(depthY, bleedYPx, sourceStripYPx);
        sampleX = sourceX < 0 ? stripOffsetX : source.width - 1 - stripOffsetX;
        sampleY = sourceY < 0 ? stripOffsetY : source.height - 1 - stripOffsetY;
      } else if (outsideY) {
        const depthY = sourceY < 0 ? -sourceY : sourceY - source.height + 1;
        const stripOffsetY = mapBleedDepthToSourceStrip(depthY, bleedYPx, sourceStripYPx);
        sampleX = sourceX;
        sampleY = sourceY < 0 ? stripOffsetY : source.height - 1 - stripOffsetY;
      } else {
        const depthX = sourceX < 0 ? -sourceX : sourceX - source.width + 1;
        const stripOffsetX = mapBleedDepthToSourceStrip(depthX, bleedXPx, sourceStripXPx);
        sampleX = sourceX < 0 ? stripOffsetX : source.width - 1 - stripOffsetX;
        sampleY = sourceY;
      }

      copyPixel(source, samples, sampleX, sampleY, y * width + x);
    }
  }

  return { width, height, samples };
}

export async function encodeRasterPng(
  source: RasterPixels,
  width: number,
  height: number,
  samples: Uint8Array | Uint16Array,
): Promise<Uint8Array> {
  const rawBytes = source.depth === "ushort"
    ? new Uint16Array(samples as Uint16Array)
    : new Uint8Array(samples as Uint8Array);
  const pipeline = sharp(rawBytes, {
    raw: {
      width,
      height,
      channels: source.channels as SharpChannels,
    },
  });

  if (source.outputColourspace) pipeline.toColourspace(source.outputColourspace);
  return new Uint8Array(await pipeline.png({ compressionLevel: 6 }).toBuffer());
}

export function calculateRasterBleedDimensions(
  sourceWidthPx: number,
  sourceHeightPx: number,
  bleedMm: number,
  sourceStripMm: number,
  trimWidthMm: number,
  trimHeightMm: number,
): RasterBleedDimensions {
  const bleedXPx = Math.max(1, Math.ceil((sourceWidthPx * bleedMm) / trimWidthMm));
  const bleedYPx = Math.max(1, Math.ceil((sourceHeightPx * bleedMm) / trimHeightMm));
  const sourceStripXPx = Math.min(
    sourceWidthPx,
    Math.max(1, Math.ceil((sourceWidthPx * sourceStripMm) / trimWidthMm)),
  );
  const sourceStripYPx = Math.min(
    sourceHeightPx,
    Math.max(1, Math.ceil((sourceHeightPx * sourceStripMm) / trimHeightMm)),
  );

  return { bleedXPx, bleedYPx, sourceStripXPx, sourceStripYPx };
}
