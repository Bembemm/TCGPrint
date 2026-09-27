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

export function applyRoundedCornerMask(
  source: RasterPixels,
  trimWidthMm: number,
  trimHeightMm: number,
  cornerRadiusMm: number,
): RasterPixels {
  const radiusXPx = (source.width * cornerRadiusMm) / trimWidthMm;
  const radiusYPx = (source.height * cornerRadiusMm) / trimHeightMm;
  if (!(radiusXPx > 0 && radiusYPx > 0 && radiusXPx < source.width / 2 && radiusYPx < source.height / 2)) {
    throw new RangeError("Rounded-corner radius must be positive and smaller than half of both trim dimensions.");
  }

  const hasAlpha = source.channels === 2 || source.channels === 4;
  const colourChannels = hasAlpha ? source.channels - 1 : source.channels;
  const outputChannels = (hasAlpha ? source.channels : source.channels + 1) as SharpChannels;
  const maxSample = source.depth === "ushort" ? 0xffff : 0xff;
  const samples = source.depth === "ushort"
    ? new Uint16Array(source.width * source.height * outputChannels)
    : new Uint8Array(source.width * source.height * outputChannels);
  const subsamplesPerAxis = 4;
  const subsampleCount = subsamplesPerAxis * subsamplesPerAxis;

  for (let y = 0; y < source.height; y += 1) {
    const inTopCorner = y < radiusYPx;
    const inBottomCorner = y >= source.height - radiusYPx;
    for (let x = 0; x < source.width; x += 1) {
      const sourceOffset = (y * source.width + x) * source.channels;
      const targetOffset = (y * source.width + x) * outputChannels;
      samples.set(source.samples.subarray(sourceOffset, sourceOffset + colourChannels), targetOffset);

      let existingAlpha = hasAlpha ? source.samples[sourceOffset + colourChannels]! : maxSample;
      const inLeftCorner = x < radiusXPx;
      const inRightCorner = x >= source.width - radiusXPx;
      if ((inTopCorner || inBottomCorner) && (inLeftCorner || inRightCorner)) {
        const centerX = inLeftCorner ? radiusXPx : source.width - radiusXPx;
        const centerY = inTopCorner ? radiusYPx : source.height - radiusYPx;
        let insideSamples = 0;

        for (let subY = 0; subY < subsamplesPerAxis; subY += 1) {
          const sampleY = y + (subY + 0.5) / subsamplesPerAxis;
          for (let subX = 0; subX < subsamplesPerAxis; subX += 1) {
            const sampleX = x + (subX + 0.5) / subsamplesPerAxis;
            const normalizedX = (sampleX - centerX) / radiusXPx;
            const normalizedY = (sampleY - centerY) / radiusYPx;
            if (normalizedX * normalizedX + normalizedY * normalizedY <= 1) insideSamples += 1;
          }
        }

        const maskAlpha = Math.round((maxSample * insideSamples) / subsampleCount);
        existingAlpha = Math.min(existingAlpha, maskAlpha);
      }

      samples[targetOffset + colourChannels] = existingAlpha;
    }
  }

  return {
    ...source,
    channels: outputChannels,
    samples,
  };
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
  const { bleedXPx, bleedYPx } = dimensions;
  const width = source.width + bleedXPx * 2;
  const height = source.height + bleedYPx * 2;
  const sampleCount = width * height * source.channels;
  const samples = source.depth === "ushort" ? new Uint16Array(sampleCount) : new Uint8Array(sampleCount);

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(0, Math.min(source.height - 1, y - bleedYPx));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(source.width - 1, x - bleedXPx));
      copyPixel(source, samples, sourceX, sourceY, y * width + x);
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
  trimWidthMm: number,
  trimHeightMm: number,
): RasterBleedDimensions {
  const bleedXPx = Math.max(1, Math.ceil((sourceWidthPx * bleedMm) / trimWidthMm));
  const bleedYPx = Math.max(1, Math.ceil((sourceHeightPx * bleedMm) / trimHeightMm));

  return { bleedXPx, bleedYPx };
}
