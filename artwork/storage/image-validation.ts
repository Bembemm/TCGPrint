import sharp from "sharp";
import { ArtworkStorageError } from "./types";

const FORMAT_EXTENSION: Readonly<Record<string, string>> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  avif: "avif",
  gif: "gif",
  svg: "svg",
  tiff: "tif",
};

export interface ValidatedImage {
  readonly format: string;
  readonly extension: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export async function validateImageBytes(bytes: Uint8Array, maximumBytes: number): Promise<ValidatedImage> {
  if (bytes.byteLength === 0) throw new ArtworkStorageError("ARTWORK_INVALID_IMAGE", "Artwork is empty.");
  if (bytes.byteLength > maximumBytes) throw new ArtworkStorageError("ARTWORK_TOO_LARGE", `Artwork exceeds the ${maximumBytes} byte limit.`);
  try {
    const image = sharp(Buffer.from(bytes), { failOn: "error", limitInputPixels: 100_000_000 });
    const metadata = await image.metadata();
    const dimensions = await sharp(Buffer.from(bytes), { failOn: "error", limitInputPixels: 100_000_000 }).stats();
    const format = metadata.format;
    const extension = format ? FORMAT_EXTENSION[format] : undefined;
    const widthPx = metadata.width;
    const heightPx = metadata.height;
    if (!format || !extension) throw new ArtworkStorageError("ARTWORK_UNSUPPORTED_FORMAT", `Artwork format ${format ?? "unknown"} is not supported.`);
    if (!widthPx || !heightPx || !metadata.channels || dimensions.channels.length === 0) throw new ArtworkStorageError("ARTWORK_INVALID_IMAGE", "Artwork image has invalid dimensions or pixels.");
    return { format, extension, widthPx, heightPx };
  } catch (error) {
    if (error instanceof ArtworkStorageError) throw error;
    throw new ArtworkStorageError("ARTWORK_INVALID_IMAGE", "Artwork bytes could not be fully decoded as an image.", error);
  }
}
