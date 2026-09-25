import { createHash } from "node:crypto";
import sharp from "sharp";
import { ImportFailureError } from "../errors";
import { detectImport } from "../detection";
import { resolveImportLimits } from "../limits";
import type { ImportLimits, ImportSource, ImportedAsset } from "../types";
import { parseSafeXml } from "./xml";
import type { SafeXmlDocument } from "./xml";
import type { SingleEntryImporterOutput } from "./types";

const EXTENSION_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
  tif: "tiff",
  tiff: "tiff",
  svg: "svg",
});

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tiff: "image/tiff",
  svg: "image/svg+xml",
});

function inputBytes(source: ImportSource): Uint8Array {
  if (!source.originalBytes || source.originalBytes.byteLength === 0) {
    throw new ImportFailureError("Image import requires non-empty original file bytes.", "UNSUPPORTED_INPUT", source.id, source.sourcePath);
  }
  return source.originalBytes;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256")
    .update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest("hex");
}

function readExtension(filename?: string): string | undefined {
  const baseName = filename?.split(/[\\/]/).pop();
  const extension = baseName?.split(".").pop();
  if (!extension || extension === baseName) return undefined;
  return extension.toLowerCase();
}

function nameSuggestion(filename?: string): string | undefined {
  const baseName = filename?.split(/[\\/]/).pop();
  if (!baseName) return undefined;
  const dot = baseName.lastIndexOf(".");
  return dot > 0 ? baseName.slice(0, dot) : baseName;
}

function parseSvgLength(rawValue: string | null): number | undefined {
  if (!rawValue) return undefined;
  const match = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(px|in|cm|mm|pt|pc)?\s*$/i.exec(rawValue);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = (match[2] ?? "px").toLowerCase();
  const multiplier = unit === "in" ? 96
    : unit === "cm" ? 96 / 2.54
      : unit === "mm" ? 96 / 25.4
        : unit === "pt" ? 96 / 72
          : unit === "pc" ? 16
            : 1;
  return value * multiplier;
}

function svgAsset(source: ImportSource, bytes: Uint8Array, limits: ImportLimits): ImportedAsset {
  if (bytes.byteLength > limits.maxSvgBytes) {
    throw new ImportFailureError(
      `SVG is ${bytes.byteLength} bytes; the configured limit is ${limits.maxSvgBytes} bytes.`,
      "INPUT_TOO_LARGE",
      source.id,
      source.sourcePath,
    );
  }
  let document: SafeXmlDocument;
  try {
    document = parseSafeXml(bytes, {
      maxXmlBytes: limits.maxSvgBytes,
      maxXmlDepth: limits.maxXmlDepth,
      maxXmlNodes: limits.maxXmlNodes,
    });
  } catch (error) {
    if (error instanceof ImportFailureError && error.code === "XML_DTD_BLOCKED") throw error;
    throw new ImportFailureError(
      `SVG is not a safe, well formed XML image. ${error instanceof Error ? error.message : "XML parser error."}`,
      "INVALID_SVG",
      source.id,
      source.sourcePath,
      { cause: error },
    );
  }

  const root = document.documentElement;
  if (!root || root.localName !== "svg") {
    throw new ImportFailureError("SVG input must have an <svg> document element.", "INVALID_SVG", source.id, source.sourcePath);
  }
  const viewBox = root.getAttribute("viewBox") || root.getAttribute("viewbox") || undefined;
  const widthPx = parseSvgLength(root.getAttribute("width"));
  const heightPx = parseSvgLength(root.getAttribute("height"));

  return {
    id: `${source.id}:asset`,
    sourceId: source.id,
    sourceFilename: source.filename,
    sourcePath: source.sourcePath,
    originalFormat: "svg",
    mediaType: MIME_TYPES.svg,
    sha256: hashBytes(bytes),
    ...(widthPx ? { widthPx } : {}),
    ...(heightPx ? { heightPx } : {}),
    originalBytes: bytes,
    metadata: Object.freeze({ vector: true, ...(viewBox ? { viewBox } : {}) }),
  };
}

async function rasterAsset(source: ImportSource, bytes: Uint8Array, format: string, limits: ImportLimits): Promise<ImportedAsset> {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const options = { failOn: "error" as const, limitInputPixels: limits.maxRasterPixels, pages: 1 };
    const metadata = await sharp(input, options).metadata();
    if (!metadata.width || !metadata.height || metadata.format !== format) {
      throw new Error(`Raster decoder identified ${metadata.format ?? "an unknown format"}; expected ${format}.`);
    }
    if (metadata.width * metadata.height > limits.maxRasterPixels) {
      throw new ImportFailureError(
        `Raster dimensions ${metadata.width} × ${metadata.height} exceed the configured pixel limit.`,
        "INPUT_TOO_LARGE",
        source.id,
        source.sourcePath,
      );
    }

    // Force a full decode so truncated/corrupt data cannot pass as a metadata-only image.
    const { data, info } = await sharp(input, options).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== metadata.width || info.height !== metadata.height || data.byteLength === 0) {
      throw new Error("Raster decoder returned inconsistent dimensions or no decoded pixels.");
    }

    return {
      id: `${source.id}:asset`,
      sourceId: source.id,
      sourceFilename: source.filename,
      sourcePath: source.sourcePath,
      originalFormat: format,
      mediaType: MIME_TYPES[format],
      sha256: hashBytes(bytes),
      widthPx: metadata.width,
      heightPx: metadata.height,
      originalBytes: bytes,
      metadata: Object.freeze({
        validatedBy: "sharp-decode",
        channels: metadata.channels,
        depth: metadata.depth,
        pages: metadata.pages ?? 1,
      }),
    };
  } catch (error) {
    if (error instanceof ImportFailureError) throw error;
    throw new ImportFailureError(
      `Could not safely decode the ${format.toUpperCase()} image. ${error instanceof Error ? error.message : "Decoder error."}`,
      "IMAGE_DECODE_FAILED",
      source.id,
      source.sourcePath,
      { cause: error },
    );
  }
}

function validateExtension(source: ImportSource, actualFormat: string): readonly { code: string; message: string; sourceId: string; sourceFilename?: string; sourcePath?: string }[] {
  const extension = readExtension(source.filename);
  const expectedFormat = extension ? EXTENSION_FORMATS[extension] : undefined;
  if (!extension || !expectedFormat || expectedFormat === actualFormat) return [];
  return [{
    code: "EXTENSION_MISMATCH",
    message: `A extensão .${extension} não corresponde ao conteúdo ${actualFormat}; o formato foi determinado pelos bytes.`,
    sourceId: source.id,
    sourceFilename: source.filename,
    sourcePath: source.sourcePath,
  }];
}

export async function importImageSource(
  source: ImportSource,
  overrides?: Partial<ImportLimits>,
): Promise<SingleEntryImporterOutput> {
  const limits = resolveImportLimits(overrides);
  const bytes = inputBytes(source);
  if (bytes.byteLength > limits.maxInputBytes) {
    throw new ImportFailureError(
      `Image is ${bytes.byteLength} bytes; the configured input limit is ${limits.maxInputBytes} bytes.`,
      "INPUT_TOO_LARGE",
      source.id,
      source.sourcePath,
    );
  }

  const detection = detectImport({ bytes, fileName: source.filename });
  const format = detection.selected?.originalFormat;
  if (!format || (detection.selected?.kind !== "image" && detection.selected?.kind !== "svg")) {
    throw new ImportFailureError("Input bytes do not identify a supported image format.", "UNSUPPORTED_INPUT", source.id, source.sourcePath);
  }

  const asset = format === "svg"
    ? svgAsset(source, bytes, limits)
    : await rasterAsset(source, bytes, format, limits);
  const warnings = validateExtension(source, format);
  const entry = {
    id: `${source.id}:entry`,
    kind: "custom-card" as const,
    order: source.order,
    quantity: 1,
    sourceId: source.id,
    sourceFilename: source.filename,
    sourcePath: source.sourcePath,
    ...(nameSuggestion(source.filename) ? { nameSuggestion: nameSuggestion(source.filename) } : {}),
    asset,
    metadata: Object.freeze({ importKind: detection.selected?.kind, originalFormat: format }),
  };
  return { entry, warnings };
}
