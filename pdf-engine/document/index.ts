import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
} from "@pdfme/pdf-lib";
import { drawSvg } from "svg4pdf-lib";
import type { BleedResult } from "../../image-engine/bleed";
import {
  MAGIC_STANDARD_CARD,
  PAPER_FORMATS,
  type CardFormat,
  type PaperFormat,
} from "../../core/geometry";
import { mmToPoints } from "../../core/units";

export interface LosslessPdfRequest {
  /** Image bytes read from local files. Repeated entries produce repeated cards. */
  readonly images: readonly Uint8Array[];
  /** Precomputed derivatives; the PDF engine places them without generating bleed. */
  readonly bleedResults?: readonly (BleedResult | undefined)[];
  readonly paperFormat?: PaperFormat;
  readonly cardFormat?: CardFormat;
}

export interface LosslessPdfFileRequest {
  readonly imagePaths: readonly string[];
  readonly paperFormat?: PaperFormat;
  readonly cardFormat?: CardFormat;
}

type SupportedImageFormat = "jpeg" | "png" | "svg";

interface Png16Image {
  readonly width: number;
  readonly height: number;
  readonly colorType: 0 | 2 | 4 | 6;
  readonly samples: Uint8Array;
  readonly alpha?: Uint8Array;
}

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

function drawPng16(
  pdf: PDFDocument,
  page: ReturnType<PDFDocument["addPage"]>,
  image: Png16Image,
  resourceId: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
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
  const resourceName = PDFName.of(`Png16_${resourceId}`);

  page.node.setXObject(resourceName, imageRef);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(width, 0, 0, height, x, y),
    drawObject(resourceName),
    popGraphicsState(),
  );
}

function stripSvgPreamble(svg: string): string {
  return svg
    .replace(/^\uFEFF/, "")
    .replace(/^(?:\s+|<\?xml\b[\s\S]*?\?>|<!--[\s\S]*?-->)+/i, "");
}

interface PageGrid {
  readonly columns: number;
  readonly rows: number;
  readonly count: number;
  readonly horizontalOffsetMm: number;
  readonly verticalOffsetMm: number;
}

export class PdfExportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdfExportError";
  }
}

function assertPositiveDimension(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number greater than zero.`);
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
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

async function drawRasterImage(
  pdf: PDFDocument,
  page: ReturnType<PDFDocument["addPage"]>,
  bytes: Uint8Array,
  resourceId: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  const exactBytes = copyBytes(bytes);
  const format = detectFormat(exactBytes);

  if (format === "jpeg") {
    const image = await pdf.embedJpg(exactBytes);
    page.drawImage(image, { x, y, width, height });
    return;
  }

  if (format === "png") {
    const png16 = parsePng16(exactBytes);
    if (png16) {
      drawPng16(pdf, page, png16, resourceId, x, y, width, height);
      return;
    }

    const image = await pdf.embedPng(exactBytes);
    page.drawImage(image, { x, y, width, height });
    return;
  }

  throw new PdfExportError("Bleed derivatives must be lossless raster PNG images.");
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

function calculatePageGrid(paper: PaperFormat, card: CardFormat): PageGrid {
  assertPositiveDimension(paper.widthMm, "Paper width");
  assertPositiveDimension(paper.heightMm, "Paper height");
  assertPositiveDimension(card.widthMm, "Card width");
  assertPositiveDimension(card.heightMm, "Card height");

  const columns = Math.floor(paper.widthMm / card.widthMm);
  const rows = Math.floor(paper.heightMm / card.heightMm);
  if (columns < 1 || rows < 1) {
    throw new RangeError("The card format does not fit on the selected paper size.");
  }

  const usedWidthMm = columns * card.widthMm;
  const usedHeightMm = rows * card.heightMm;

  return {
    columns,
    rows,
    count: columns * rows,
    horizontalOffsetMm: (paper.widthMm - usedWidthMm) / 2,
    verticalOffsetMm: (paper.heightMm - usedHeightMm) / 2,
  };
}

export class LosslessPdfEngine {
  async generate(request: LosslessPdfRequest): Promise<Uint8Array> {
    if (request.bleedResults && request.bleedResults.length !== request.images.length) {
      throw new PdfExportError("PDF bleed results must contain one result per image.");
    }
    if (
      request.images.length > 1
      && request.bleedResults?.some((result) => result?.status === "derived")
    ) {
      throw new PdfExportError("Bleed PDF placement currently requires one card because the Phase 1 grid has no gaps between trim boxes.");
    }

    const paper = request.paperFormat ?? PAPER_FORMATS.A4;
    const card = request.cardFormat ?? MAGIC_STANDARD_CARD;
    const grid = calculatePageGrid(paper, card);
    const pdf = await PDFDocument.create();
    const pageCount = Math.max(1, Math.ceil(request.images.length / grid.count));
    const widthPoints = mmToPoints(card.widthMm);
    const heightPoints = mmToPoints(card.heightMm);

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const page = pdf.addPage([mmToPoints(paper.widthMm), mmToPoints(paper.heightMm)]);
      const startCardIndex = pageIndex * grid.count;
      const endCardIndex = Math.min(startCardIndex + grid.count, request.images.length);

      for (let imageIndex = startCardIndex; imageIndex < endCardIndex; imageIndex += 1) {
        const imageBytes = request.images[imageIndex];
        if (!(imageBytes instanceof Uint8Array) || imageBytes.byteLength === 0) {
          throw new PdfExportError(`Image ${imageIndex + 1} is empty or is not a byte array.`);
        }

        const format = detectFormat(imageBytes);
        const localCardIndex = imageIndex - startCardIndex;
        const column = localCardIndex % grid.columns;
        const row = Math.floor(localCardIndex / grid.columns);
        const xMm = grid.horizontalOffsetMm + column * card.widthMm;
        const topMm = grid.verticalOffsetMm + row * card.heightMm;
        const xPoints = mmToPoints(xMm);
        const yPoints = mmToPoints(paper.heightMm - topMm - card.heightMm);
        const exactBytes = copyBytes(imageBytes);

        const bleed = request.bleedResults?.[imageIndex];
        if (bleed?.status === "derived") {
          if (!Number.isFinite(bleed.bleedMm) || bleed.bleedMm <= 0 || bleed.bleedMm > 3) {
            throw new PdfExportError("PDF bleed amount must be greater than 0 mm and at most 3 mm.");
          }

          const originalSha256 = createHash("sha256").update(exactBytes).digest("hex");
          if (originalSha256 !== bleed.originalSha256) {
            throw new PdfExportError("The bleed derivative original image hash does not match the PDF input image.");
          }
          if (bleed.trimSizeMm.widthMm !== card.widthMm || bleed.trimSizeMm.heightMm !== card.heightMm) {
            throw new PdfExportError("The bleed derivative trim size does not match the PDF card format.");
          }
          if (bleed.preview.mimeType !== "image/png" || !bleed.preview.trimRectPx) {
            throw new PdfExportError("PDF bleed derivatives must expose a lossless PNG preview and trim rectangle.");
          }
          const epsilonMm = 1e-9;
          if (
            xMm - bleed.bleedMm < -epsilonMm
            || topMm - bleed.bleedMm < -epsilonMm
            || xMm + card.widthMm + bleed.bleedMm > paper.widthMm + epsilonMm
            || topMm + card.heightMm + bleed.bleedMm > paper.heightMm + epsilonMm
          ) {
            throw new PdfExportError("The requested bleed would extend beyond the PDF page bounds.");
          }

          const bleedPoints = mmToPoints(bleed.bleedMm);
          const expandedWidthPoints = widthPoints + 2 * bleedPoints;
          const expandedHeightPoints = heightPoints + 2 * bleedPoints;
          await drawRasterImage(
            pdf,
            page,
            bleed.preview.bytes,
            request.images.length + imageIndex,
            xPoints - bleedPoints,
            yPoints - bleedPoints,
            expandedWidthPoints,
            expandedHeightPoints,
          );
        }

        if (format === "jpeg") {
          const image = await pdf.embedJpg(exactBytes);
          page.drawImage(image, {
            x: xPoints,
            y: yPoints,
            width: widthPoints,
            height: heightPoints,
          });
          continue;
        }

        if (format === "png") {
          const png16 = parsePng16(exactBytes);
          if (png16) {
            drawPng16(pdf, page, png16, imageIndex, xPoints, yPoints, widthPoints, heightPoints);
            continue;
          }

          const image = await pdf.embedPng(exactBytes);
          page.drawImage(image, {
            x: xPoints,
            y: yPoints,
            width: widthPoints,
            height: heightPoints,
          });
          continue;
        }

        const svg = new TextDecoder("utf-8", { fatal: true }).decode(exactBytes);
        assertSupportedSvgContent(svg);
        const warnings: string[] = [];
        drawSvg(
          page,
          normalizeSvgForPhysicalSize(svg, widthPoints, heightPoints),
          xPoints,
          yPoints,
          {
            width: widthPoints,
            height: heightPoints,
            warningCallback: (message) => warnings.push(message),
          },
        );

        if (warnings.length > 0) {
          throw new PdfExportError(`SVG contains unsupported content: ${warnings.join("; ")}`);
        }
      }
    }

    return pdf.save();
  }

  async generateFromFiles(request: LosslessPdfFileRequest): Promise<Uint8Array> {
    const images = await Promise.all(request.imagePaths.map(async (path) => new Uint8Array(await readFile(path))));

    return this.generate({
      images,
      paperFormat: request.paperFormat,
      cardFormat: request.cardFormat,
    });
  }
}
