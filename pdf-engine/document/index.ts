import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import {
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  LineCapStyle,
  lineTo,
  moveTo,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  rectangle,
  setLineCap,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
} from "@pdfme/pdf-lib";
import { drawSvg } from "svg4pdf-lib";
import type { BleedResult } from "../../image-engine/bleed";
import {
  MAGIC_STANDARD_CARD,
  GUIDE_COLOR_HEX,
  TRIM_GUIDE_STROKE_WIDTH_PT,
  PAPER_FORMATS,
  calculateGridPagePlacements,
  CutGuideEngine,
  type GridPlacementPage,
  parseCutGuideConfig,
  type CutGuideConfig,
  type CutGuideCardMm,
  type CutGuideGeometry,
  type CardFormat,
  type PageMarginsMm,
  type PageOrientation,
  type PaperFormat,
  type TemplateLayoutGeometryMm,
} from "../../core/geometry";
import { mmToPoints } from "../../core/units";
import { generateRegistrationGeometry, type RegistrationConfig, type RegistrationPrimitive } from "../../core/registration";
import { transformRegistrationGeometry } from "../../core/registration";
import { getCutGuideStrokeBoundsMm } from "../../core/geometry/cut-guides";
import type { DuplexBackPageTransform } from "../../core/duplex";
import { CalibrationError, createPrintCalibrationTransform, getCalibrationPageOverflowMm, parseSideCalibration, type CalibrationSide, type SideCalibration } from "../../core/calibration";
import { associatePdfRasterCacheDiagnostics, countRasterReuseOccurrences, type PdfRasterCacheDiagnostics } from "./raster-resource-policy";

export interface LosslessPdfRequest {
  /** Image bytes read from local files. Repeated entries produce repeated cards. */
  readonly images: readonly Uint8Array[];
  /** SHA-256 digests already computed by the validated export pipeline, in physical image order. */
  readonly imageSha256?: readonly (string | undefined)[];
  /** Precomputed derivatives; the PDF engine places them without generating bleed. */
  readonly bleedResults?: readonly (BleedResult | undefined)[];
  /** Physical vector guides calculated from trim rectangles in millimeters. */
  readonly cutGuides?: CutGuideConfig;
  readonly paperFormat?: PaperFormat;
  readonly cardFormat?: CardFormat;
  readonly pageOrientation?: PageOrientation;
  readonly cardOrientation?: PageOrientation;
  readonly marginsMm?: PageMarginsMm;
  readonly horizontalGapMm?: number;
  readonly verticalGapMm?: number;
  readonly registration?: RegistrationConfig;
  readonly templateGeometry?: TemplateLayoutGeometryMm;
  readonly layoutRows?: number;
  readonly layoutColumns?: number;
  readonly skippedSlotIndices?: readonly number[];
  /** The canonical placements shared by front/back preview and export. */
  readonly pagePlacements?: readonly GridPlacementPage[];
  /** Physical slot, registration, and vector artwork transforms for a paired back PDF. */
  readonly duplexBackPageTransform?: DuplexBackPageTransform;
  /** Physical image indexes intentionally left blank while their slots remain in the page plan. */
  readonly skipImageIndexes?: ReadonlySet<number>;
  /** Optional physical page correction. It wraps the whole page after duplex pairing. */
  readonly printCalibration?: SideCalibration;
  readonly calibrationSide?: CalibrationSide;
}

export interface LosslessPdfFileRequest {
  readonly imagePaths: readonly string[];
  readonly paperFormat?: PaperFormat;
  readonly cardFormat?: CardFormat;
  readonly pageOrientation?: PageOrientation;
  readonly cardOrientation?: PageOrientation;
  readonly marginsMm?: PageMarginsMm;
  readonly horizontalGapMm?: number;
  readonly verticalGapMm?: number;
  readonly cutGuides?: CutGuideConfig;
  readonly registration?: RegistrationConfig;
  readonly templateGeometry?: TemplateLayoutGeometryMm;
  readonly layoutRows?: number;
  readonly layoutColumns?: number;
  readonly skippedSlotIndices?: readonly number[];
}

type SupportedImageFormat = "jpeg" | "png" | "svg";

interface Png16Image {
  readonly width: number;
  readonly height: number;
  readonly colorType: 0 | 2 | 4 | 6;
  readonly samples: Uint8Array;
  readonly alpha?: Uint8Array;
}

interface PdfClipRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type PdfAffineMatrix = readonly [number, number, number, number, number, number];

interface SvgTag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
}

const SUPPORTED_SVG_ELEMENTS = new Set([
  "svg",
  "rect",
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
]);

const SUPPORTED_SVG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(["xmlns", "width", "height", "viewbox"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry", "fill", "stroke", "stroke-width"]),
  path: new Set(["d", "fill", "stroke", "stroke-width"]),
  circle: new Set(["cx", "cy", "r", "fill", "stroke", "stroke-width"]),
  ellipse: new Set(["cx", "cy", "rx", "ry", "fill", "stroke", "stroke-width"]),
  line: new Set(["x1", "y1", "x2", "y2", "stroke", "stroke-width"]),
  polyline: new Set(["points", "fill", "stroke", "stroke-width"]),
  polygon: new Set(["points", "fill", "stroke", "stroke-width"]),
};

const SUPPORTED_SVG_NUMERIC_ATTRIBUTES = new Set([
  "width", "height", "x", "y", "rx", "ry", "cx", "cy", "r",
  "x1", "y1", "x2", "y2", "stroke-width",
]);

const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const PNG_COLOR_CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  4: 2,
  6: 4,
};

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function unfilterPngRow(
  filtered: Uint8Array,
  previous: Uint8Array,
  bytesPerPixel: number,
  filter: number,
): Uint8Array {
  const row = new Uint8Array(filtered.length);

  for (let index = 0; index < filtered.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const above = previous[index] ?? 0;
    const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
    let predictor = 0;

    switch (filter) {
      case 0:
        break;
      case 1:
        predictor = left;
        break;
      case 2:
        predictor = above;
        break;
      case 3:
        predictor = Math.floor((left + above) / 2);
        break;
      case 4:
        predictor = paethPredictor(left, above, upperLeft);
        break;
      default:
        throw new PdfExportError(`Unsupported PNG row filter ${filter}.`);
    }

    row[index] = (filtered[index] + predictor) & 0xff;
  }

  return row;
}

function parsePng16(bytes: Uint8Array): Png16Image | undefined {
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return undefined;

  const input = Buffer.from(bytes);
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let transparencyKey: Buffer | undefined;
  let hasHeader = false;
  let hasEnd = false;
  let offset = PNG_SIGNATURE.length;

  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const chunkType = input.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > input.length) throw new PdfExportError("PNG contains a truncated chunk.");

    if (chunkType === "IHDR") {
      if (hasHeader || length !== 13) throw new PdfExportError("PNG has an invalid IHDR chunk.");
      width = input.readUInt32BE(dataStart);
      height = input.readUInt32BE(dataStart + 4);
      bitDepth = input[dataStart + 8];
      colorType = input[dataStart + 9];
      interlace = input[dataStart + 12];
      hasHeader = true;
    } else if (chunkType === "IDAT") {
      idat.push(input.subarray(dataStart, dataEnd));
    } else if (chunkType === "tRNS") {
      transparencyKey = Buffer.from(input.subarray(dataStart, dataEnd));
    } else if (chunkType === "IEND") {
      hasEnd = true;
      break;
    }

    offset = dataEnd + 4;
  }

  if (!hasHeader || !hasEnd || width < 1 || height < 1) {
    throw new PdfExportError("PNG is missing a complete image header or end chunk.");
  }
  if (bitDepth !== 16) return undefined;
  if (!(colorType in PNG_COLOR_CHANNELS) || !idat.length) {
    throw new PdfExportError(`PNG color type ${colorType} is not supported at 16-bit depth.`);
  }
  if (transparencyKey && (colorType === 4 || colorType === 6)) {
    throw new PdfExportError("PNG cannot combine an alpha channel with a transparent color key.");
  }
  if (transparencyKey && transparencyKey.length !== (colorType === 0 ? 2 : 6)) {
    throw new PdfExportError("PNG has an invalid 16-bit transparent color key.");
  }
  if (interlace !== 0 && interlace !== 1) {
    throw new PdfExportError(`PNG interlace method ${interlace} is not supported.`);
  }

  const channels = PNG_COLOR_CHANNELS[colorType];
  const bytesPerPixel = channels * 2;
  const samplesPerPixel = colorType === 0 || colorType === 4 ? 1 : 3;
  const hasAlpha = colorType === 4 || colorType === 6 || transparencyKey !== undefined;
  const decoded = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height * channels * 2);
  let decodedOffset = 0;
  const passes = interlace === 0
    ? [[0, 0, 1, 1] as const]
    : ADAM7_PASSES;

  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    if (passWidth === 0 || passHeight === 0) continue;
    const rowLength = passWidth * bytesPerPixel;
    let previous: Uint8Array = new Uint8Array(rowLength);

    for (let passRow = 0; passRow < passHeight; passRow += 1) {
      if (decodedOffset + 1 + rowLength > decoded.length) {
        throw new PdfExportError("PNG image data ends before the declared dimensions.");
      }

      const filter = decoded[decodedOffset];
      const row = unfilterPngRow(
        decoded.subarray(decodedOffset + 1, decodedOffset + 1 + rowLength),
        previous,
        bytesPerPixel,
        filter,
      );
      decodedOffset += rowLength + 1;
      previous = row;
      const y = startY + passRow * stepY;

      for (let passColumn = 0; passColumn < passWidth; passColumn += 1) {
        const x = startX + passColumn * stepX;
        const sourcePixel = passColumn * bytesPerPixel;
        const targetPixel = (y * width + x) * channels * 2;
        pixels.set(row.subarray(sourcePixel, sourcePixel + bytesPerPixel), targetPixel);
      }
    }
  }

  if (decodedOffset !== decoded.length) {
    throw new PdfExportError("PNG image data contains samples beyond the declared dimensions.");
  }

  const colorSamples = new Uint8Array(width * height * samplesPerPixel * 2);
  const alpha = hasAlpha ? new Uint8Array(width * height * 2) : undefined;
  if (channels === samplesPerPixel) {
    colorSamples.set(pixels);
  } else {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const source = pixel * channels * 2;
      const target = pixel * samplesPerPixel * 2;
      colorSamples.set(pixels.subarray(source, source + samplesPerPixel * 2), target);
      alpha!.set(pixels.subarray(source + samplesPerPixel * 2, source + channels * 2), pixel * 2);
    }
  }
  if (transparencyKey) {
    const transparentSampleCount = colorType === 0 ? 1 : 3;
    const isTransparent = (pixel: number): boolean => {
      for (let sample = 0; sample < transparentSampleCount; sample += 1) {
        const sourceOffset = pixel * samplesPerPixel * 2 + sample * 2;
        if (
          colorSamples[sourceOffset] !== transparencyKey![sample * 2]
          || colorSamples[sourceOffset + 1] !== transparencyKey![sample * 2 + 1]
        ) return false;
      }
      return true;
    };

    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const maskSample = isTransparent(pixel) ? 0 : 0xffff;
      alpha!.set([maskSample >>> 8, maskSample & 0xff], pixel * 2);
    }
  }

  return {
    width,
    height,
    colorType: colorType as Png16Image["colorType"],
    samples: colorSamples,
    alpha,
  };
}

function parseSvgTags(svg: string): SvgTag[] {
  const tags: SvgTag[] = [];
  let offset = 0;

  while (offset < svg.length) {
    const open = svg.indexOf("<", offset);
    if (open < 0) {
      if (svg.slice(offset).trim()) throw new PdfExportError("Unsupported SVG text content outside vector elements.");
      break;
    }
    if (svg.slice(offset, open).trim()) {
      throw new PdfExportError("Unsupported SVG text content outside vector elements.");
    }

    if (svg.startsWith("<!--", open)) {
      const end = svg.indexOf("-->", open + 4);
      if (end < 0) throw new PdfExportError("SVG contains an unterminated comment.");
      offset = end + 3;
      continue;
    }
    if (svg.startsWith("<![CDATA[", open)) {
      throw new PdfExportError("Unsupported SVG content: CDATA sections are not supported.");
    }
    if (/^<!doctype\b/i.test(svg.slice(open, open + 16)) || svg.startsWith("<!ENTITY", open)) {
      throw new PdfExportError("Unsupported SVG content: document type and entity declarations are not supported.");
    }
    if (svg.startsWith("<?", open)) {
      const end = svg.indexOf("?>", open + 2);
      if (end < 0) throw new PdfExportError("SVG contains an unterminated processing instruction.");
      offset = end + 2;
      continue;
    }

    let cursor = open + 1;
    let closing = false;
    if (svg[cursor] === "/") {
      closing = true;
      cursor += 1;
    }
    const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(svg.slice(cursor));
    if (!nameMatch) throw new PdfExportError("SVG contains malformed markup.");
    const name = nameMatch[0].toLowerCase();
    cursor += nameMatch[0].length;
    let quote: "'" | '"' | undefined;

    while (cursor < svg.length) {
      const character = svg[cursor];
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === "'" || character === '"') {
        quote = character;
      } else if (character === ">") {
        break;
      }
      cursor += 1;
    }
    if (cursor >= svg.length || quote) throw new PdfExportError("SVG contains an unterminated element.");

    const nameEnd = open + 1 + (closing ? 1 : 0) + nameMatch[0].length;
    const rawTagTail = svg.slice(nameEnd, cursor);
    if (closing && rawTagTail.trim()) throw new PdfExportError("SVG closing tags cannot contain attributes.");
    const rawAttributes = closing ? "" : rawTagTail;
    const selfClosing = !closing && rawAttributes.trimEnd().endsWith("/");
    const attributes = [...rawAttributes.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map((match) => ({
        name: match[1].toLowerCase(),
        value: match[2] ?? match[3] ?? "",
      }));
    const remainder = rawAttributes.replace(/([^\s=/>]+)\s*=\s*(?:"[^"]*"|'[^']*')/g, "").replace(/[\s/]/g, "");

    if (remainder.length > 0) throw new PdfExportError(`Unsupported SVG attributes on <${name}>.`);
    if (name.includes(":")) throw new PdfExportError(`Unsupported SVG namespace element <${name}>.`);
    if (new Set(attributes.map(({ name: attributeName }) => attributeName)).size !== attributes.length) {
      throw new PdfExportError(`Unsupported SVG duplicate attribute on <${name}>.`);
    }
    tags.push({ name, closing, selfClosing, attributes });
    offset = cursor + 1;
  }

  if (tags.length === 0 || tags[0].name !== "svg" || tags[0].closing) {
    throw new PdfExportError("SVG input must start with an <svg> root element.");
  }

  return tags;
}

function assertSupportedSvgContent(svg: string): void {
  const tags = parseSvgTags(svg);
  const stack: string[] = [];
  let rootSeen = false;
  let rootClosed = false;

  for (const tag of tags) {
    if (rootClosed) throw new PdfExportError("SVG content appears after the root element.");
    if (!SUPPORTED_SVG_ELEMENTS.has(tag.name)) {
      throw new PdfExportError(`Unsupported SVG element <${tag.name}>; export would omit its content.`);
    }
    for (const attribute of tag.attributes) {
      if (!SUPPORTED_SVG_ATTRIBUTES[tag.name].has(attribute.name)) {
        throw new PdfExportError(`Unsupported SVG attribute "${attribute.name}" on <${tag.name}>.`);
      }
      if (
        SUPPORTED_SVG_NUMERIC_ATTRIBUTES.has(attribute.name)
        && !(tag.name === "svg" && (attribute.name === "width" || attribute.name === "height"))
        && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(attribute.value.trim())
      ) {
        throw new PdfExportError(`Unsupported SVG measurement "${attribute.value}" for ${attribute.name}.`);
      }
      if (attribute.name === "xmlns" && attribute.value !== "http://www.w3.org/2000/svg") {
        throw new PdfExportError(`Unsupported SVG namespace "${attribute.value}".`);
      }
      if (attribute.name === "points" && !/^[\s\d+.,eE-]+$/.test(attribute.value)) {
        throw new PdfExportError("Unsupported SVG points value.");
      }
    }

    if (tag.closing) {
      if (stack.pop() !== tag.name) throw new PdfExportError(`SVG has a mismatched closing </${tag.name}> element.`);
      if (tag.name === "svg") rootClosed = true;
      continue;
    }
    if (tag.name === "svg") {
      if (rootSeen || stack.length > 0) throw new PdfExportError("Nested or repeated SVG roots are not supported.");
      rootSeen = true;
    } else if (stack.length !== 1 || stack[0] !== "svg") {
      throw new PdfExportError(`Unsupported SVG nesting: <${tag.name}> must be a direct child of <svg>.`);
    }
    if (tag.selfClosing) {
      if (tag.name === "svg") rootClosed = true;
    } else {
      stack.push(tag.name);
    }
  }

  if (stack.length > 0) throw new PdfExportError(`SVG is missing a closing </${stack.at(-1)}>.`);
  if (!rootSeen || !rootClosed) throw new PdfExportError("SVG root element is incomplete.");

  for (const tag of tags) {
    for (const attribute of tag.attributes) {
      if (attribute.name === "fill" || attribute.name === "stroke") {
        const value = attribute.value.trim();
        if (value !== "none" && !/^#[\da-f]{6}$/i.test(value)) {
          throw new PdfExportError(`Unsupported SVG paint "${value}".`);
        }
      }
    }
  }
}

function createPng16PdfResource(pdf: PDFDocument, image: Png16Image, resourceId: number) {
  const colorSpace = image.colorType === 0 || image.colorType === 4 ? "DeviceGray" : "DeviceRGB";
  const softMask = image.alpha
    ? pdf.context.register(pdf.context.flateStream(image.alpha, {
      Type: "XObject",
      Subtype: "Image",
      Width: image.width,
      Height: image.height,
      BitsPerComponent: 16,
      ColorSpace: "DeviceGray",
    }))
    : undefined;
  const imageRef = pdf.context.register(pdf.context.flateStream(image.samples, {
    Type: "XObject",
    Subtype: "Image",
    Width: image.width,
    Height: image.height,
    BitsPerComponent: 16,
    ColorSpace: colorSpace,
    ...(softMask ? { SMask: softMask } : {}),
  }));

  return { imageRef, resourceName: PDFName.of(`Png16_${resourceId}`) };
}

type Png16PdfResource = ReturnType<typeof createPng16PdfResource>;

function drawPng16(
  page: ReturnType<PDFDocument["addPage"]>,
  image: Png16PdfResource,
  x: number,
  y: number,
  width: number,
  height: number,
  clipRegions?: readonly PdfClipRectangle[],
): void {
  page.node.setXObject(image.resourceName, image.imageRef);
  if (!clipRegions) {
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(width, 0, 0, height, x, y),
      drawObject(image.resourceName),
      popGraphicsState(),
    );
    return;
  }

  for (const region of clipRegions) {
    page.pushOperators(
      pushGraphicsState(),
      rectangle(region.x, region.y, region.width, region.height),
      clip(),
      endPath(),
      concatTransformationMatrix(width, 0, 0, height, x, y),
      drawObject(image.resourceName),
      popGraphicsState(),
    );
  }
}

function stripSvgPreamble(svg: string): string {
  return svg
    .replace(/^\uFEFF/, "")
    .replace(/^(?:\s+|<\?xml\b[\s\S]*?\?>|<!--[\s\S]*?-->)+/i, "");
}

export class PdfExportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdfExportError";
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function getPdfRasterFormat(bytes: Uint8Array): "jpeg" | "png" | undefined {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  return undefined;
}

function detectFormat(bytes: Uint8Array): SupportedImageFormat {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return "png";
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "jpeg";
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PdfExportError("Unsupported image format. Use JPEG, PNG, or SVG files.");
  }

  if (/^<svg\b/i.test(stripSvgPreamble(text))) return "svg";

  throw new PdfExportError("Unsupported image format. Use JPEG, PNG, or SVG files.");
}

interface PdfRasterMetadata {
  readonly width: number;
  readonly height: number;
  readonly bitDepth?: number;
  readonly colorType?: number;
  readonly jpegPrecision?: number;
  readonly jpegComponents?: number;
}

type PdfRasterImage = Awaited<ReturnType<PDFDocument["embedPng"]>>;

type PdfRasterResource =
  | { readonly type: "image"; readonly image: PdfRasterImage; readonly width: number; readonly height: number }
  | { readonly type: "png16"; readonly image: Png16PdfResource; readonly width: number; readonly height: number };

interface PdfRasterCacheEntry {
  readonly byteSnapshot: Uint8Array;
  readonly resource: PdfRasterResource;
}

interface PdfRasterResourceCache {
  readonly entries: Map<string, PdfRasterCacheEntry[]>;
  nextPng16ResourceId: number;
  readonly diagnostics: {
    rasterEmbeds: number;
    cacheLookups: number;
    cacheHits: number;
    cacheMisses: number;
    cacheEntries: number;
    snapshotBytes: number;
  };
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset]! * 0x100 + bytes[offset + 1]!) * 0x100 + bytes[offset + 2]!) * 0x100) + bytes[offset + 3]!;
}

function inspectPngMetadata(bytes: Uint8Array): PdfRasterMetadata | undefined {
  if (bytes.byteLength < 33 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return undefined;
  if (readUint32BigEndian(bytes, 8) !== 13
    || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined;

  const width = readUint32BigEndian(bytes, 16);
  const height = readUint32BigEndian(bytes, 20);
  if (width < 1 || height < 1) return undefined;
  return { width, height, bitDepth: bytes[24], colorType: bytes[25] };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectJpegMetadata(bytes: Uint8Array): PdfRasterMetadata | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let offset = 2;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return undefined;
    const marker = bytes[offset++]!;

    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.byteLength) return undefined;

    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return undefined;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) return undefined;
      const dataOffset = offset + 2;
      const height = (bytes[dataOffset + 1]! << 8) | bytes[dataOffset + 2]!;
      const width = (bytes[dataOffset + 3]! << 8) | bytes[dataOffset + 4]!;
      const jpegComponents = bytes[dataOffset + 5]!;
      if (width < 1 || height < 1 || jpegComponents < 1) return undefined;
      return { width, height, jpegPrecision: bytes[dataOffset]!, jpegComponents };
    }
    offset += segmentLength;
  }

  return undefined;
}

function getPdfRasterMetadata(bytes: Uint8Array, format: "jpeg" | "png"): PdfRasterMetadata | undefined {
  return format === "jpeg" ? inspectJpegMetadata(bytes) : inspectPngMetadata(bytes);
}

function pdfRasterResourceKey(
  format: "jpeg" | "png",
  bytes: Uint8Array,
  metadata: PdfRasterMetadata,
  knownSha256?: string,
): string {
  const digest = knownSha256 ?? createHash("sha256").update(bytes).digest("hex");
  return JSON.stringify([
    format,
    bytes.byteLength,
    metadata.width,
    metadata.height,
    metadata.bitDepth ?? null,
    metadata.colorType ?? null,
    metadata.jpegPrecision ?? null,
    metadata.jpegComponents ?? null,
    digest,
  ]);
}

function haveSameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function embedPdfRaster(
  pdf: PDFDocument,
  sourceBytes: Uint8Array,
  exactBytes: Uint8Array,
  format: "jpeg" | "png",
  cache: PdfRasterResourceCache,
  knownSha256?: string,
  allowReuse = true,
): Promise<PdfRasterResource> {
  if (!allowReuse) {
    cache.diagnostics.rasterEmbeds += 1;
    if (format === "jpeg") {
      const image = await pdf.embedJpg(exactBytes);
      return { type: "image", image, width: image.width, height: image.height };
    }
    const png16 = parsePng16(exactBytes);
    if (png16) {
      const image = createPng16PdfResource(pdf, png16, cache.nextPng16ResourceId++);
      return { type: "png16", image, width: png16.width, height: png16.height };
    }
    const image = await pdf.embedPng(exactBytes);
    return { type: "image", image, width: image.width, height: image.height };
  }

  const metadata = getPdfRasterMetadata(exactBytes, format);
  const cacheKey = metadata ? pdfRasterResourceKey(format, exactBytes, metadata, knownSha256) : undefined;
  const existing = cacheKey ? cache.entries.get(cacheKey) : undefined;
  if (cacheKey) cache.diagnostics.cacheLookups += 1;
  const cached = existing?.find((entry) => haveSameBytes(entry.byteSnapshot, sourceBytes));
  if (cached) {
    cache.diagnostics.cacheHits += 1;
    return cached.resource;
  }
  if (cacheKey) cache.diagnostics.cacheMisses += 1;

  cache.diagnostics.rasterEmbeds += 1;
  let resource: PdfRasterResource;
  if (format === "png" && (!metadata || metadata.bitDepth === 16)) {
    const png16 = parsePng16(exactBytes);
    if (png16) {
      const image = createPng16PdfResource(pdf, png16, cache.nextPng16ResourceId++);
      resource = { type: "png16", image, width: png16.width, height: png16.height };
    } else {
      const image = await pdf.embedPng(exactBytes);
      resource = { type: "image", image, width: image.width, height: image.height };
    }
  } else if (format === "jpeg") {
    const image = await pdf.embedJpg(exactBytes);
    resource = { type: "image", image, width: image.width, height: image.height };
  } else {
    const image = await pdf.embedPng(exactBytes);
    resource = { type: "image", image, width: image.width, height: image.height };
  }

  if (cacheKey && metadata?.width === resource.width && metadata.height === resource.height) {
    const entries = cache.entries.get(cacheKey) ?? [];
    // Keep the exact private copy passed to pdf-lib. Retaining the caller's
    // mutable view could let a later mutation make a stale resource compare
    // equal to different bytes under a repeated or colliding digest.
    entries.push({ byteSnapshot: exactBytes, resource });
    cache.entries.set(cacheKey, entries);
    cache.diagnostics.cacheEntries += 1;
    cache.diagnostics.snapshotBytes += exactBytes.byteLength;
  }
  return resource;
}

function drawPdfRaster(
  page: ReturnType<PDFDocument["addPage"]>,
  resource: PdfRasterResource,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (resource.type === "png16") {
    drawPng16(page, resource.image, x, y, width, height);
    return;
  }
  page.drawImage(resource.image, { x, y, width, height });
}

async function drawClippedBleedRaster(
  pdf: PDFDocument,
  page: ReturnType<PDFDocument["addPage"]>,
  bytes: Uint8Array,
  expectedWidthPx: number,
  expectedHeightPx: number,
  cache: PdfRasterResourceCache,
  knownSha256: string,
  allowReuse: boolean,
  x: number,
  y: number,
  width: number,
  height: number,
  clipRegions: readonly PdfClipRectangle[],
): Promise<void> {
  const exactBytes = copyBytes(bytes);
  const format = detectFormat(exactBytes);

  if (format !== "png") {
    throw new PdfExportError("Bleed derivatives must be lossless raster PNG images.");
  }

  const image = await embedPdfRaster(pdf, bytes, exactBytes, format, cache, knownSha256, allowReuse);
  if (image.width !== expectedWidthPx || image.height !== expectedHeightPx) {
    throw new PdfExportError("Bleed preview dimensions do not match its PNG pixels.");
  }
  if (image.type === "png16") {
    drawPng16(page, image.image, x, y, width, height, clipRegions);
    return;
  }
  for (const region of clipRegions) {
    page.pushOperators(
      pushGraphicsState(),
      rectangle(region.x, region.y, region.width, region.height),
      clip(),
      endPath(),
    );
    page.drawImage(image.image, { x, y, width, height });
    page.pushOperators(popGraphicsState());
  }
}

function makeBleedClipRegions(
  trimX: number,
  trimY: number,
  trimWidth: number,
  trimHeight: number,
  bleedPoints: number,
): readonly PdfClipRectangle[] {
  return [
    {
      x: trimX - bleedPoints,
      y: trimY - bleedPoints,
      width: bleedPoints,
      height: trimHeight + 2 * bleedPoints,
    },
    {
      x: trimX + trimWidth,
      y: trimY - bleedPoints,
      width: bleedPoints,
      height: trimHeight + 2 * bleedPoints,
    },
    {
      x: trimX,
      y: trimY + trimHeight,
      width: trimWidth,
      height: bleedPoints,
    },
    {
      x: trimX,
      y: trimY - bleedPoints,
      width: trimWidth,
      height: bleedPoints,
    },
  ];
}

function readSvgRootTag(svg: string): { readonly rootTag: string; readonly start: number; readonly end: number } {
  const match = /<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(svg);
  if (!match || match.index === undefined) {
    throw new PdfExportError("SVG input does not contain a readable <svg> root element.");
  }

  return { rootTag: match[0], start: match.index, end: match.index + match[0].length };
}

function readXmlAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function setXmlAttribute(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`\\s+${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  const attribute = ` ${name}="${value}"`;

  if (pattern.test(tag)) return tag.replace(pattern, attribute);

  const selfClosing = tag.endsWith("/>");
  const withoutClose = tag.slice(0, selfClosing ? -2 : -1);
  return `${withoutClose}${attribute}${selfClosing ? "/>" : ">"}`;
}

function normalizeSvgForPhysicalSize(svg: string, widthPoints: number, heightPoints: number): string {
  const source = stripSvgPreamble(svg);
  const { rootTag, start, end } = readSvgRootTag(source);
  const rawViewBox = readXmlAttribute(rootTag, "viewBox");
  const viewBox = rawViewBox?.trim().split(/[\s,]+/).map(Number);

  if (
    !viewBox
    || viewBox.length !== 4
    || !viewBox.every(Number.isFinite)
    || viewBox[2] <= 0
    || viewBox[3] <= 0
  ) {
    throw new PdfExportError("SVG export requires a numeric viewBox with positive width and height.");
  }

  const sizedRoot = setXmlAttribute(
    setXmlAttribute(rootTag, "width", `${widthPoints}pt`),
    "height",
    `${heightPoints}pt`,
  );

  return `${source.slice(0, start)}${sizedRoot}${source.slice(end)}`;
}

function drawCutGuides(
  page: ReturnType<PDFDocument["addPage"]>,
  pageSize: PaperFormat,
  config: CutGuideConfig,
  geometry: CutGuideGeometry,
): void {
  const normalizedConfig = parseCutGuideConfig(config);

  const drawSegments = (segments: CutGuideGeometry["trimSegments"], colorHex: string, strokeWidthPoints: number) => {
    if (segments.length === 0) return;
    const color = colorHex.slice(1);
    const red = Number.parseInt(color.slice(0, 2), 16) / 255;
    const green = Number.parseInt(color.slice(2, 4), 16) / 255;
    const blue = Number.parseInt(color.slice(4, 6), 16) / 255;
    page.pushOperators(
      pushGraphicsState(),
      setStrokingRgbColor(red, green, blue),
      setLineWidth(strokeWidthPoints),
      setLineCap(LineCapStyle.Butt),
    );
    for (const segment of segments) {
      page.pushOperators(
        moveTo(mmToPoints(segment.x1Mm), mmToPoints(pageSize.heightMm - segment.y1Mm)),
        lineTo(mmToPoints(segment.x2Mm), mmToPoints(pageSize.heightMm - segment.y2Mm)),
        stroke(),
      );
    }
    page.pushOperators(popGraphicsState());
  };

  drawSegments(geometry.trimSegments, GUIDE_COLOR_HEX[normalizedConfig.trim.color], TRIM_GUIDE_STROKE_WIDTH_PT);
  drawSegments(geometry.externalSegments, GUIDE_COLOR_HEX[normalizedConfig.external.color], normalizedConfig.external.strokeWidthPt);
}

function drawRegistrationMarks(
  page: ReturnType<PDFDocument["addPage"]>,
  pageSizeMm: { readonly widthMm: number; readonly heightMm: number },
  geometry: ReturnType<typeof generateRegistrationGeometry>,
): void {
  const black = rgb(0, 0, 0);
  const drawPrimitive = (primitive: RegistrationPrimitive) => {
    if (primitive.type === "line") {
      page.drawLine({
        start: { x: mmToPoints(primitive.x1Mm), y: mmToPoints(pageSizeMm.heightMm - primitive.y1Mm) },
        end: { x: mmToPoints(primitive.x2Mm), y: mmToPoints(pageSizeMm.heightMm - primitive.y2Mm) },
        thickness: mmToPoints(primitive.strokeWidthMm),
        color: black,
      });
    } else if (primitive.type === "rect") {
      page.drawRectangle({
        x: mmToPoints(primitive.xMm),
        y: mmToPoints(pageSizeMm.heightMm - primitive.yMm - primitive.heightMm),
        width: mmToPoints(primitive.widthMm),
        height: mmToPoints(primitive.heightMm),
        ...(primitive.fill ? { color: black } : {}),
        ...(primitive.strokeWidthMm > 0 ? { borderColor: black, borderWidth: mmToPoints(primitive.strokeWidthMm) } : {}),
      });
    } else {
      page.drawCircle({
        x: mmToPoints(primitive.cxMm),
        y: mmToPoints(pageSizeMm.heightMm - primitive.cyMm),
        size: mmToPoints(primitive.radiusMm),
        ...(primitive.fill ? { color: black } : {}),
        ...(primitive.strokeWidthMm > 0 ? { borderColor: black, borderWidth: mmToPoints(primitive.strokeWidthMm) } : {}),
      });
    }
  };
  for (const mark of geometry.marks) for (const primitive of mark.primitives) drawPrimitive(primitive);
}

export class LosslessPdfEngine {
  async generate(request: LosslessPdfRequest): Promise<Uint8Array> {
    if (request.bleedResults && request.bleedResults.length !== request.images.length) {
      throw new PdfExportError("PDF bleed results must contain one result per image.");
    }
    if (request.imageSha256 && request.imageSha256.length !== request.images.length) {
      throw new PdfExportError("PDF image SHA-256 values must contain one value per image.");
    }
    if (request.imageSha256?.some((sha256) => sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256))) {
      throw new PdfExportError("PDF image SHA-256 values must use 64 lowercase hexadecimal characters.");
    }
    const rasterDigestsByBytes = new WeakMap<Uint8Array, string>();
    const getRasterDigest = (bytes: Uint8Array): string => {
      const cached = rasterDigestsByBytes.get(bytes);
      if (cached) return cached;
      const digest = createHash("sha256").update(bytes).digest("hex");
      rasterDigestsByBytes.set(bytes, digest);
      return digest;
    };
    const imageRasterIdentities = request.images.map((bytes, index) => {
      if (!getPdfRasterFormat(bytes)) return undefined;
      const sha256 = request.imageSha256?.[index] ?? getRasterDigest(bytes);
      return { bytes, sha256 };
    });
    const imageRasterUseCounts = countRasterReuseOccurrences(imageRasterIdentities);
    const imageRasterSha256 = imageRasterIdentities.map((identity) => identity?.sha256);

    const paper = request.paperFormat ?? PAPER_FORMATS.A4;
    const card = request.cardFormat ?? MAGIC_STANDARD_CARD;
    const sourceCardIsLandscape = card.widthMm > card.heightMm;
    const requestedCardIsLandscape = request.cardOrientation === undefined
      ? sourceCardIsLandscape
      : request.cardOrientation === "landscape";
    const rotateCardArtwork = sourceCardIsLandscape !== requestedCardIsLandscape;
    const pageIsLandscape = paper.widthMm > paper.heightMm;
    const pageShouldBeLandscape = request.pageOrientation === undefined
      ? pageIsLandscape
      : request.pageOrientation === "landscape";
    const effectivePaper = pageIsLandscape === pageShouldBeLandscape
      ? paper
      : { ...paper, widthMm: paper.heightMm, heightMm: paper.widthMm };
    const registrationGeometry = generateRegistrationGeometry(
      request.registration ?? { type: "none", orientation: "portrait" },
      { widthMm: effectivePaper.widthMm, heightMm: effectivePaper.heightMm },
    );
    const placementOptions = {
      paper,
      pageOrientation: request.pageOrientation,
      card,
      cardOrientation: request.cardOrientation,
      marginsMm: request.marginsMm,
      horizontalGapMm: request.horizontalGapMm,
      verticalGapMm: request.verticalGapMm,
      ...(request.templateGeometry ? { templateGeometry: request.templateGeometry } : {}),
      reservedZonesMm: registrationGeometry.reservedZones,
      ...(request.skippedSlotIndices ? { skippedSlotIndices: request.skippedSlotIndices } : {}),
      ...(request.layoutRows !== undefined ? { rows: request.layoutRows } : {}),
      ...(request.layoutColumns !== undefined ? { columns: request.layoutColumns } : {}),
    } as const;
    const bleedByImageMm = request.images.map((_image, index) => {
      const bleed = request.bleedResults?.[index];
      if (bleed?.status !== "derived") return 0;
      if (!Number.isFinite(bleed.bleedMm) || bleed.bleedMm < 0 || bleed.bleedMm > 3
        || (bleed.bleedMm === 0 && !bleed.roundedCorners)) {
        throw new PdfExportError("A PDF derivative must contain positive bleed or an enabled rounded-corner transform.");
      }
      return bleed.bleedMm;
    });
    const pagePlacements = request.pagePlacements ?? calculateGridPagePlacements({
      placement: { ...placementOptions, bleedMm: 0 },
      count: request.images.length,
      bleedByCardMm: bleedByImageMm,
    });
    let nextPageStart = 0;
    for (const [index, pagePlacement] of pagePlacements.entries()) {
      if (pagePlacement.pageIndex !== index || pagePlacement.startCardIndex !== nextPageStart
        || pagePlacement.endCardIndex < pagePlacement.startCardIndex || pagePlacement.endCardIndex > request.images.length
        || pagePlacement.placement.slots.length !== pagePlacement.endCardIndex - pagePlacement.startCardIndex) {
        throw new PdfExportError("Provided PDF page placements do not cover the ordered physical image list contiguously.");
      }
      nextPageStart = pagePlacement.endCardIndex;
    }
    if (nextPageStart !== request.images.length && request.images.length > 0) {
      throw new PdfExportError("Provided PDF page placements do not include every physical image slot.");
    }
    if (request.skipImageIndexes && [...request.skipImageIndexes].some((index) => !Number.isSafeInteger(index) || index < 0 || index >= request.images.length)) {
      throw new PdfExportError("Skipped PDF image indexes must refer to a physical slot in the supplied page plan.");
    }
    const bleedRasterIdentities = request.bleedResults?.map((bleed, index) => {
      if (bleed?.status !== "derived" || request.skipImageIndexes?.has(index)) return undefined;
      const bytes = bleed.preview.bytes;
      return { bytes, sha256: getRasterDigest(bytes) };
    }) ?? [];
    const bleedRasterUseCounts = countRasterReuseOccurrences(bleedRasterIdentities);

    const pdf = await PDFDocument.create();
    const rasterResourceCache: PdfRasterResourceCache = {
      entries: new Map(),
      nextPng16ResourceId: 0,
      diagnostics: {
        rasterEmbeds: 0,
        cacheLookups: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheEntries: 0,
        snapshotBytes: 0,
      },
    };
    const sourceWidthPoints = mmToPoints(card.widthMm);
    const sourceHeightPoints = mmToPoints(card.heightMm);

    for (const { startCardIndex, endCardIndex, placement: pagePlacement } of pagePlacements) {
      const pageSizeMm = pagePlacement.pageSizeMm;
      const page = pdf.addPage([mmToPoints(pageSizeMm.widthMm), mmToPoints(pageSizeMm.heightMm)]);
      const guideConfig = request.cutGuides ? parseCutGuideConfig(request.cutGuides) : undefined;
      const guideCards = pagePlacement.slots.map((slot, localCardIndex) => ({
        trim: slot.trim,
        bleedMm: bleedByImageMm[startCardIndex + localCardIndex],
      }));
      const guideGeometry = guideConfig ? new CutGuideEngine().generate({
        cards: guideCards,
        pageSizeMm,
        config: guideConfig,
      }) : undefined;
      const pageRegistrationGeometry = request.duplexBackPageTransform
        ? transformRegistrationGeometry(registrationGeometry, pageSizeMm, request.duplexBackPageTransform.registrationReflectionAxis)
        : registrationGeometry;
      let pageCalibrationApplied = false;
      if (request.printCalibration !== undefined) {
        const transform = createPrintCalibrationTransform(pageSizeMm, parseSideCalibration(request.printCalibration), request.calibrationSide ?? "front");
        if (!transform.isIdentity) {
          const overflowEpsilonMm = 0.001;
          for (let imageIndex = startCardIndex; imageIndex < endCardIndex; imageIndex += 1) {
            if (request.skipImageIndexes?.has(imageIndex)) continue;
            const slot = pagePlacement.slots.find((item) => item.cardIndex === imageIndex - startCardIndex);
            if (!slot) continue;
            const bleedMm = bleedByImageMm[imageIndex] ?? 0;
            const overflow = getCalibrationPageOverflowMm(pageSizeMm, {
              xMm: slot.trim.xMm - bleedMm,
              yMm: slot.trim.yMm - bleedMm,
              widthMm: pagePlacement.cardSizeMm.widthMm + 2 * bleedMm,
              heightMm: pagePlacement.cardSizeMm.heightMm + 2 * bleedMm,
            }, transform.matrix);
            if (overflow.maximumMm > overflowEpsilonMm) {
              throw new CalibrationError("CALIBRATED_CONTENT_OUT_OF_BOUNDS", `Calibrated card ${imageIndex + 1} extends ${overflow.maximumMm.toFixed(3)} mm beyond the printable page bounds; change layout margins or calibration explicitly.`);
            }
          }
          for (const mark of pageRegistrationGeometry.marks) {
            const overflow = getCalibrationPageOverflowMm(pageSizeMm, mark.bounds, transform.matrix);
            if (overflow.maximumMm > overflowEpsilonMm) {
              throw new CalibrationError("CALIBRATED_CONTENT_OUT_OF_BOUNDS", `Calibrated registration mark ${mark.id} extends ${overflow.maximumMm.toFixed(3)} mm beyond the printable page bounds.`);
            }
          }
          if (guideConfig && guideGeometry) {
            for (const guide of getCutGuideStrokeBoundsMm(guideGeometry, guideConfig)) {
              const overflow = getCalibrationPageOverflowMm(pageSizeMm, guide.bounds, transform.matrix);
              if (overflow.maximumMm > overflowEpsilonMm) {
                throw new CalibrationError(
                  "CALIBRATED_CONTENT_OUT_OF_BOUNDS",
                  `Calibrated ${guide.kind} cut guide ${guide.index + 1} extends ${overflow.maximumMm.toFixed(3)} mm beyond the printable page bounds.`,
                );
              }
            }
          }
          const { a, b, c, d, e, f } = transform.matrix;
          page.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(a, b, c, d, mmToPoints(e), mmToPoints(f)),
          );
          pageCalibrationApplied = true;
        }
      }

      for (let imageIndex = startCardIndex; imageIndex < endCardIndex; imageIndex += 1) {
        if (request.skipImageIndexes?.has(imageIndex)) continue;
        const imageBytes = request.images[imageIndex];
        if (!(imageBytes instanceof Uint8Array) || imageBytes.byteLength === 0) {
          throw new PdfExportError(`Image ${imageIndex + 1} is empty or is not a byte array.`);
        }

        const format = detectFormat(imageBytes);
        const localCardIndex = imageIndex - startCardIndex;
        const slot = pagePlacement.slots.find((item) => item.cardIndex === localCardIndex);
        if (!slot) throw new PdfExportError(`PDF page placement has no physical slot for image ${imageIndex + 1}.`);
        const trim = slot.trim;
        const xMm = trim.xMm;
        const topMm = trim.yMm;
        const xPoints = mmToPoints(xMm);
        const yPoints = mmToPoints(pagePlacement.pageSizeMm.heightMm - topMm - pagePlacement.cardSizeMm.heightMm);
        const artworkRotationDegrees = request.duplexBackPageTransform?.artworkOrientation.rotationDegrees ?? 0;
        const artworkTransform = rotateCardArtwork
          ? sourceCardIsLandscape
            ? [0, 1, -1, 0, xPoints + sourceHeightPoints, yPoints] as const
            : [0, -1, 1, 0, xPoints, yPoints + sourceWidthPoints] as const
          : artworkRotationDegrees === 180
            ? [1, 0, 0, 1, xPoints, yPoints] as const
            : undefined;
        let finalArtworkTransform: PdfAffineMatrix | undefined = artworkTransform;
        if (artworkRotationDegrees === 180) {
          const base = artworkTransform ?? [1, 0, 0, 1, xPoints, yPoints] as const;
          const targetWidthPoints = mmToPoints(pagePlacement.cardSizeMm.widthMm);
          const targetHeightPoints = mmToPoints(pagePlacement.cardSizeMm.heightMm);
          finalArtworkTransform = [
            -base[0],
            -base[1],
            -base[2],
            -base[3],
            2 * xPoints + targetWidthPoints - base[4],
            2 * yPoints + targetHeightPoints - base[5],
          ];
        }
        const artworkXPoints = finalArtworkTransform ? 0 : xPoints;
        const artworkYPoints = finalArtworkTransform ? 0 : yPoints;
        const exactBytes = copyBytes(imageBytes);

        if (finalArtworkTransform) {
          const [a, b, c, d, e, f] = finalArtworkTransform;
          page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f));
        }

        try {
        const bleed = request.bleedResults?.[imageIndex];
        if (bleed?.status === "derived") {
          if (!Number.isFinite(bleed.bleedMm) || bleed.bleedMm < 0 || bleed.bleedMm > 3
            || (bleed.bleedMm === 0 && !bleed.roundedCorners)) {
            throw new PdfExportError("A PDF derivative must contain positive bleed or an enabled rounded-corner transform.");
          }

          const originalSha256 = createHash("sha256").update(exactBytes).digest("hex");
          if (originalSha256 !== bleed.originalSha256) {
            throw new PdfExportError("The bleed derivative original image hash does not match the PDF input image.");
          }
          if (bleed.trimSizeMm.widthMm !== card.widthMm
            || bleed.trimSizeMm.heightMm !== card.heightMm) {
            throw new PdfExportError("The bleed derivative trim size does not match the PDF card format.");
          }
          if (bleed.preview.mimeType !== "image/png" || !bleed.preview.trimRectPx) {
            throw new PdfExportError("PDF bleed derivatives must expose a lossless PNG preview and trim rectangle.");
          }
          const previewWidthPx = bleed.preview.widthPx;
          const previewHeightPx = bleed.preview.heightPx;
          const trimRectPx = bleed.preview.trimRectPx;
          if (
            typeof previewWidthPx !== "number"
            || !Number.isSafeInteger(previewWidthPx)
            || previewWidthPx <= 0
            || typeof previewHeightPx !== "number"
            || !Number.isSafeInteger(previewHeightPx)
            || previewHeightPx <= 0
            || !Number.isSafeInteger(trimRectPx.x)
            || !Number.isSafeInteger(trimRectPx.y)
            || !Number.isSafeInteger(trimRectPx.width)
            || !Number.isSafeInteger(trimRectPx.height)
            || trimRectPx.x < 0
            || trimRectPx.y < 0
            || trimRectPx.width <= 0
            || trimRectPx.height <= 0
            || trimRectPx.x + trimRectPx.width > previewWidthPx
            || trimRectPx.y + trimRectPx.height > previewHeightPx
          ) {
            throw new PdfExportError("PDF bleed derivative has invalid pixel dimensions or trim bounds.");
          }
          const rightPaddingPx = previewWidthPx - trimRectPx.x - trimRectPx.width;
          const bottomPaddingPx = previewHeightPx - trimRectPx.y - trimRectPx.height;
          const epsilonMm = 1e-9;
          if (bleed.bleedMm > 0 && (
            xMm - bleed.bleedMm < -epsilonMm
            || topMm - bleed.bleedMm < -epsilonMm
            || xMm + pagePlacement.cardSizeMm.widthMm + bleed.bleedMm > pageSizeMm.widthMm + epsilonMm
            || topMm + pagePlacement.cardSizeMm.heightMm + bleed.bleedMm > pageSizeMm.heightMm + epsilonMm
          )) {
            throw new PdfExportError("The requested bleed would extend beyond the PDF page bounds.");
          }

          const bleedPoints = mmToPoints(bleed.bleedMm);
          const pointsPerSourcePixelX = sourceWidthPoints / trimRectPx.width;
          const pointsPerSourcePixelY = sourceHeightPoints / trimRectPx.height;
          if (bleed.bleedMm > 0 && (
            Math.min(trimRectPx.x, rightPaddingPx) * pointsPerSourcePixelX < bleedPoints - mmToPoints(epsilonMm)
            || Math.min(trimRectPx.y, bottomPaddingPx) * pointsPerSourcePixelY < bleedPoints - mmToPoints(epsilonMm)
          )) {
            throw new PdfExportError("Bleed derivative pixel padding is smaller than the requested physical bleed.");
          }
          const expandedWidthPoints = previewWidthPx * pointsPerSourcePixelX;
          const expandedHeightPoints = previewHeightPx * pointsPerSourcePixelY;
          const imageXPoints = artworkXPoints - trimRectPx.x * pointsPerSourcePixelX;
          const imageYPoints = artworkYPoints - bottomPaddingPx * pointsPerSourcePixelY;
          const clipRegions = [
            ...(bleed.bleedMm > 0 ? makeBleedClipRegions(
              artworkXPoints,
              artworkYPoints,
              sourceWidthPoints,
              sourceHeightPoints,
              bleedPoints,
            ) : []),
            ...(bleed.roundedCorners ? [{ x: artworkXPoints, y: artworkYPoints, width: sourceWidthPoints, height: sourceHeightPoints }] : []),
          ];
          if (clipRegions.length > 0) {
            await drawClippedBleedRaster(
              pdf,
              page,
              bleed.preview.bytes,
              previewWidthPx,
              previewHeightPx,
              rasterResourceCache,
              bleedRasterIdentities[imageIndex]!.sha256,
              bleedRasterUseCounts[imageIndex]! > 1,
              imageXPoints,
              imageYPoints,
              expandedWidthPoints,
              expandedHeightPoints,
              clipRegions,
            );
          }
          if (bleed.roundedCorners) continue;
        }

        if (format === "jpeg") {
          const imageSha256 = imageRasterSha256[imageIndex];
          const allowReuse = imageSha256 !== undefined && imageRasterUseCounts[imageIndex]! > 1;
          const image = await embedPdfRaster(pdf, imageBytes, exactBytes, format, rasterResourceCache, imageSha256, allowReuse);
          drawPdfRaster(page, image, artworkXPoints, artworkYPoints, sourceWidthPoints, sourceHeightPoints);
          continue;
        }

        if (format === "png") {
          const imageSha256 = imageRasterSha256[imageIndex];
          const allowReuse = imageSha256 !== undefined && imageRasterUseCounts[imageIndex]! > 1;
          const image = await embedPdfRaster(pdf, imageBytes, exactBytes, format, rasterResourceCache, imageSha256, allowReuse);
          drawPdfRaster(page, image, artworkXPoints, artworkYPoints, sourceWidthPoints, sourceHeightPoints);
          continue;
        }

        const svg = new TextDecoder("utf-8", { fatal: true }).decode(exactBytes);
        assertSupportedSvgContent(svg);
        const warnings: string[] = [];
        drawSvg(
          page,
          normalizeSvgForPhysicalSize(svg, sourceWidthPoints, sourceHeightPoints),
          artworkXPoints,
          artworkYPoints,
          {
            width: sourceWidthPoints,
            height: sourceHeightPoints,
            warningCallback: (message) => warnings.push(message),
          },
        );

        if (warnings.length > 0) {
          throw new PdfExportError(`SVG contains unsupported content: ${warnings.join("; ")}`);
        }
        } finally {
          if (finalArtworkTransform) page.pushOperators(popGraphicsState());
        }
      }

      if (guideConfig && guideGeometry) {
        drawCutGuides(
          page,
          { ...effectivePaper, widthMm: pageSizeMm.widthMm, heightMm: pageSizeMm.heightMm },
          guideConfig,
          guideGeometry,
        );
      }
      drawRegistrationMarks(page, pageSizeMm, pageRegistrationGeometry);
      if (pageCalibrationApplied) page.pushOperators(popGraphicsState());
    }

    const pdfBytes = await pdf.save();
    associatePdfRasterCacheDiagnostics(pdfBytes, rasterResourceCache.diagnostics satisfies PdfRasterCacheDiagnostics);
    return pdfBytes;
  }

  async generateFromFiles(request: LosslessPdfFileRequest): Promise<Uint8Array> {
    const images = await Promise.all(request.imagePaths.map(async (path) => new Uint8Array(await readFile(path))));
    return this.generate({ ...request, images });
  }
}

export async function validateSvgForPdfExport(bytes: Uint8Array): Promise<void> {
  if (detectFormat(copyBytes(bytes)) !== "svg") {
    throw new PdfExportError("PDF SVG validation requires SVG input.");
  }
  await new LosslessPdfEngine().generate({ images: [bytes] });
}
