import { readFile } from "node:fs/promises";
import { PDFDocument } from "@pdfme/pdf-lib";
import { drawSvg } from "svg4pdf-lib";
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
  readonly paperFormat?: PaperFormat;
  readonly cardFormat?: CardFormat;
}

export interface LosslessPdfFileRequest {
  readonly imagePaths: readonly string[];
  readonly paperFormat?: PaperFormat;
  readonly cardFormat?: CardFormat;
}

type SupportedImageFormat = "jpeg" | "png" | "svg";

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
