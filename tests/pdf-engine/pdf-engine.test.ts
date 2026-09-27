import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { calculateGridPlacement, MAGIC_STANDARD_CARD, type CardFormat } from "../../core/geometry";
import { mmToPoints, pointsToMm } from "../../core/units";
import { BleedEngine } from "../../image-engine/bleed";
import type { CutGuideConfig } from "../../core/geometry/cut-guides";
import { LosslessPdfEngine } from "../../pdf-engine/document";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "pdf");
const A4_WIDTH_POINTS = 595.2755905511812;
const A4_HEIGHT_POINTS = 841.8897637795276;
const MAGIC_CARD_WIDTH_POINTS = 180;
const MAGIC_CARD_HEIGHT_POINTS = 252;

interface DecodedFixturePng {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly pixels: Buffer;
}

interface PdfImageObject {
  readonly raw: PDFRawStream;
  readonly dictionary: string;
  readonly width: number;
  readonly height: number;
}

interface ParsedPdf {
  readonly document: PDFDocument;
  readonly images: readonly PdfImageObject[];
  readonly content: string;
}

interface PdfClipRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PdfImageDraw {
  readonly resourceName: string;
  readonly clip?: PdfClipRectangle;
}

function decodeFixturePng(bytes: Buffer): DecodedFixturePng {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | undefined;
  const compressedRows: Buffer[] = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;

    if (type === "IHDR") {
      width = bytes.readUInt32BE(payloadStart);
      height = bytes.readUInt32BE(payloadStart + 4);
      expect(bytes[payloadStart + 8]).toBe(8);
      const colorType = bytes[payloadStart + 9];
      channels = colorType === 2 ? 3 : colorType === 6 ? 4 : undefined;
    } else if (type === "IDAT") {
      compressedRows.push(bytes.subarray(payloadStart, payloadEnd));
    }

    offset = payloadEnd + 4;
    if (type === "IEND") break;
  }

  if (!channels) throw new Error("Fixture PNG must be 8-bit RGB or RGBA.");

  const scanlines = inflateSync(Buffer.concat(compressedRows));
  const rowBytes = width * channels;
  const pixels = Buffer.alloc(rowBytes * height);

  for (let row = 0; row < height; row += 1) {
    const scanlineStart = row * (rowBytes + 1);
    expect(scanlines[scanlineStart]).toBe(0);
    scanlines.copy(pixels, row * rowBytes, scanlineStart + 1, scanlineStart + 1 + rowBytes);
  }

  return { width, height, channels, pixels };
}

async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
  const document = await PDFDocument.load(bytes);
  const images: PdfImageObject[] = [];
  const contentStreams: Buffer[] = [];

  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;

    const dictionary = object.dict.toString();
    if (object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image") {
      const width = dictionary.match(/\/Width\s+(\d+)/)?.[1];
      const height = dictionary.match(/\/Height\s+(\d+)/)?.[1];

      if (!width || !height) throw new Error("PDF image is missing its native dimensions.");

      images.push({ raw: object, dictionary, width: Number(width), height: Number(height) });
    } else if (object.dict.get(PDFName.of("Filter"))?.toString() === "/FlateDecode") {
      contentStreams.push(inflateSync(Buffer.from(object.contents)));
    }
  }

  return { document, images, content: Buffer.concat(contentStreams).toString("latin1") };
}

function getDrawMatrices(content: string): number[][] {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().endsWith(" cm"))
    .map((line) => line.trim().replace(/\s+cm$/, "").split(/\s+/).map(Number))
    .filter((matrix) => matrix.length === 6 && matrix.every(Number.isFinite));
}

function getVectorSegments(content: string): number[][] {
  const number = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[Ee][+-]?\\d+)?";
  const pattern = new RegExp(`(${number})\\s+(${number})\\s+m\\s+(${number})\\s+(${number})\\s+l\\s+S`, "g");
  return [...content.matchAll(pattern)].map((match) => match.slice(1).map(Number));
}

function getImageDrawsWithClips(content: string): PdfImageDraw[] {
  const tokens = content.match(/\/[\w.-]+|[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?|[A-Za-z*]+/g) ?? [];
  const graphicsStack: (PdfClipRectangle | undefined)[] = [];
  const draws: PdfImageDraw[] = [];
  let activeClip: PdfClipRectangle | undefined;
  let pendingRectangle: PdfClipRectangle | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "q") {
      graphicsStack.push(activeClip);
    } else if (token === "Q") {
      activeClip = graphicsStack.pop();
    } else if (token === "re") {
      const operands = tokens.slice(index - 4, index).map(Number);
      if (operands.length === 4 && operands.every(Number.isFinite)) {
        pendingRectangle = {
          x: operands[0],
          y: operands[1],
          width: operands[2],
          height: operands[3],
        };
      }
    } else if (token === "W" || token === "W*") {
      activeClip = pendingRectangle;
      pendingRectangle = undefined;
    } else if (token === "n") {
      pendingRectangle = undefined;
    } else if (token === "Do") {
      const resourceName = tokens[index - 1]?.replace(/^\//, "");
      if (resourceName) draws.push({ resourceName, clip: activeClip });
    }
  }

  return draws;
}

function getImageResourceReference(pdf: ParsedPdf, resourceName: string): string {
  const pageResources = pdf.document.getPages()[0].node.Resources();
  const xObjects = pageResources?.lookup(PDFName.of("XObject"), PDFDict);
  const reference = xObjects?.get(PDFName.of(resourceName));
  if (!reference) throw new Error(`PDF image resource /${resourceName} is missing.`);
  return reference.toString();
}

function assertMatrixContainsSize(content: string, widthPoints: number, heightPoints: number): void {
  const hasSize = getDrawMatrices(content).some(([a, b, c, d]) =>
    Math.abs(a - widthPoints) < 1e-8
      && Math.abs(b) < 1e-8
      && Math.abs(c) < 1e-8
      && Math.abs(d - heightPoints) < 1e-8,
  );

  expect(hasSize).toBe(true);
}

function getPdfStreamBytes(image: PdfImageObject): Buffer {
  return Buffer.from(image.raw.contents);
}

function expectExternalPdfSegmentsClear(
  segments: readonly number[][],
  cards: readonly {
    readonly trim: { readonly xMm: number; readonly yMm: number; readonly widthMm: number; readonly heightMm: number };
    readonly bleedMm: number;
  }[],
  pageHeightMm: number,
  strokeWidthPt: number,
): void {
  const radiusMm = strokeWidthPt * 25.4 / 72 / 2;
  for (const [x1Points, y1Points, x2Points, y2Points] of segments) {
    const x1Mm = pointsToMm(x1Points);
    const x2Mm = pointsToMm(x2Points);
    const y1Mm = pageHeightMm - pointsToMm(y1Points);
    const y2Mm = pageHeightMm - pointsToMm(y2Points);
    const horizontal = Math.abs(y2Mm - y1Mm) < 1e-8;

    expect(horizontal || Math.abs(x2Mm - x1Mm) < 1e-8).toBe(true);
    for (const { trim, bleedMm } of cards) {
      const left = trim.xMm - bleedMm;
      const right = trim.xMm + trim.widthMm + bleedMm;
      const top = trim.yMm - bleedMm;
      const bottom = trim.yMm + trim.heightMm + bleedMm;
      const segmentLeft = Math.min(x1Mm, x2Mm) - (horizontal ? 0 : radiusMm);
      const segmentRight = Math.max(x1Mm, x2Mm) + (horizontal ? 0 : radiusMm);
      const segmentTop = Math.min(y1Mm, y2Mm) - (horizontal ? radiusMm : 0);
      const segmentBottom = Math.max(y1Mm, y2Mm) + (horizontal ? radiusMm : 0);
      const overlapX = Math.min(segmentRight, right) - Math.max(segmentLeft, left);
      const overlapY = Math.min(segmentBottom, bottom) - Math.max(segmentTop, top);

      expect(overlapX > 1e-8 && overlapY > 1e-8).toBe(false);
    }
  }
}

function getAlphaMask(pdf: ParsedPdf, image: PdfImageObject): PdfImageObject {
  const maskReference = image.raw.dict.get(PDFName.of("SMask"));
  expect(maskReference).toBeDefined();

  const mask = pdf.document.context.lookup(maskReference!);
  expect(mask).toBeInstanceOf(PDFRawStream);

  const raw = mask as PDFRawStream;
  const dictionary = raw.dict.toString();
  const width = dictionary.match(/\/Width\s+(\d+)/)?.[1];
  const height = dictionary.match(/\/Height\s+(\d+)/)?.[1];

  if (!width || !height) throw new Error("PDF soft mask is missing its dimensions.");

  return { raw, dictionary, width: Number(width), height: Number(height) };
}

describe("LosslessPdfEngine", () => {
  const engine = new LosslessPdfEngine();

  it("creates an A4 page with exact physical dimensions in points and millimeters", async () => {
    const pdf = await engine.generate({
      images: [new Uint8Array(await readFile(join(FIXTURES, "synthetic-rgb.png")))],
    });
    const parsed = await parsePdf(pdf);
    const page = parsed.document.getPages()[0];
    const mediaBox = page.getMediaBox();

    expect(mediaBox.width).toBeCloseTo(A4_WIDTH_POINTS, 10);
    expect(mediaBox.height).toBeCloseTo(A4_HEIGHT_POINTS, 10);
    expect(pointsToMm(mediaBox.width)).toBeCloseTo(210, 10);
    expect(pointsToMm(mediaBox.height)).toBeCloseTo(297, 10);
  });

  it("places a Magic Standard card at exactly 63.5 × 88.9 mm using the PDF matrix", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const pdf = await engine.generate({ images: [jpeg] });
    const parsed = await parsePdf(pdf);

    expect(parsed.images[0]).toMatchObject({ width: 8, height: 6 });
    assertMatrixContainsSize(parsed.content, MAGIC_CARD_WIDTH_POINTS, MAGIC_CARD_HEIGHT_POINTS);
    expect(pointsToMm(MAGIC_CARD_WIDTH_POINTS)).toBe(63.5);
    expect(pointsToMm(MAGIC_CARD_HEIGHT_POINTS)).toBeCloseTo(88.9, 12);
  });

  it("adds bleed outside the nominal trim and overlays the untouched JPEG trim", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });
    const pdf = await engine.generate({ images: [original], bleedResults: [bleed] });
    const parsed = await parsePdf(pdf);
    const jpeg = parsed.images.find((image) => image.dictionary.includes("/DCTDecode"));
    const derivative = parsed.images.find((image) => image.dictionary.includes("/FlateDecode"));
    const matrices = getDrawMatrices(parsed.content);
    const trim = matrices.find(([a, , , d]) => Math.abs(a - MAGIC_CARD_WIDTH_POINTS) < 1e-8 && Math.abs(d - MAGIC_CARD_HEIGHT_POINTS) < 1e-8);
    const trimRect = bleed.preview.trimRectPx!;
    const previewWidthPx = bleed.preview.widthPx!;
    const previewHeightPx = bleed.preview.heightPx!;
    const pointsPerSourcePixelX = MAGIC_CARD_WIDTH_POINTS / trimRect.width;
    const pointsPerSourcePixelY = MAGIC_CARD_HEIGHT_POINTS / trimRect.height;
    const expanded = matrices.find(([a, b, c, d]) =>
      Math.abs(a - previewWidthPx * pointsPerSourcePixelX) < 1e-8
        && Math.abs(b) < 1e-8
        && Math.abs(c) < 1e-8
        && Math.abs(d - previewHeightPx * pointsPerSourcePixelY) < 1e-8,
    );
    const imageDraws = getImageDrawsWithClips(parsed.content);
    const positionedMatrices = matrices.filter(([a, b, c, d, e, f]) =>
      Math.abs(a - 1) < 1e-10
        && Math.abs(b) < 1e-10
        && Math.abs(c) < 1e-10
        && Math.abs(d - 1) < 1e-10
        && (Math.abs(e) > 1e-10 || Math.abs(f) > 1e-10),
    );
    const trimX = mmToPoints((210 - 63.5) / 2);
    const trimTop = (297 - 88.9) / 2;
    const trimY = mmToPoints(297 - trimTop - 88.9);
    const bottomPaddingPx = previewHeightPx - trimRect.y - trimRect.height;

    expect(jpeg).toMatchObject({ width: 8, height: 6 });
    expect(createHash("sha256").update(getPdfStreamBytes(jpeg!)).digest("hex"))
      .toBe(createHash("sha256").update(original).digest("hex"));
    expect(derivative).toMatchObject({ width: 10, height: 8 });
    expect(trim).toBeDefined();
    expect(expanded).toBeDefined();
    expect(imageDraws).toHaveLength(5);
    expect(imageDraws.slice(0, 4).every((draw) => draw.clip !== undefined)).toBe(true);
    expect(imageDraws[4].clip).toBeUndefined();
    expect(positionedMatrices).toHaveLength(5);
    expect(pointsToMm(trim![0])).toBe(63.5);
    expect(pointsToMm(trim![3])).toBeCloseTo(88.9, 12);
    for (const matrix of positionedMatrices.slice(1, 4)) {
      expect(matrix[4]).toBeCloseTo(positionedMatrices[0][4], 10);
      expect(matrix[5]).toBeCloseTo(positionedMatrices[0][5], 10);
    }
    expect(positionedMatrices[0][4]).toBeCloseTo(trimX - trimRect.x * pointsPerSourcePixelX, 10);
    expect(positionedMatrices[0][5]).toBeCloseTo(trimY - bottomPaddingPx * pointsPerSourcePixelY, 10);
    expect(positionedMatrices[4][4]).toBeCloseTo(trimX, 10);
    expect(positionedMatrices[4][5]).toBeCloseTo(trimY, 10);
    const requestedBleedPoints = mmToPoints(0.625);
    expect(imageDraws[0].clip!.width).toBeCloseTo(requestedBleedPoints, 10);
    expect(imageDraws[1].clip!.width).toBeCloseTo(requestedBleedPoints, 10);
    expect(imageDraws[2].clip!.height).toBeCloseTo(requestedBleedPoints, 10);
    expect(imageDraws[3].clip!.height).toBeCloseTo(requestedBleedPoints, 10);
  });

  it("places a rounded-corner derivative inside the unchanged physical trim when bleed is zero", async () => {
    const original = new Uint8Array(await sharp({
      create: { width: 127, height: 178, channels: 4, background: { r: 25, g: 90, b: 155, alpha: 1 } },
    }).png().toBuffer());
    const rounded = await new BleedEngine().generate({
      imageBytes: original,
      bleedMm: 0,
      roundedCorners: true,
      cornerRadiusMm: 3.175,
    });
    const pdf = await engine.generate({ images: [original], bleedResults: [rounded] });
    const parsed = await parsePdf(pdf);
    const image = parsed.images.find((candidate) => candidate.dictionary.includes("/SMask"));
    const draws = getImageDrawsWithClips(parsed.content);
    const alpha = inflateSync(getPdfStreamBytes(getAlphaMask(parsed, image!)));

    expect(rounded.status).toBe("derived");
    expect(image).toMatchObject({ width: 127, height: 178 });
    expect(alpha[0]).toBe(0);
    expect(alpha[89 * 127 + 63]).toBe(255);
    expect(draws).toHaveLength(1);
    expect(draws[0].clip).toBeDefined();
    assertMatrixContainsSize(parsed.content, MAGIC_CARD_WIDTH_POINTS, MAGIC_CARD_HEIGHT_POINTS);
    expect(pointsToMm(MAGIC_CARD_WIDTH_POINTS)).toBe(63.5);
    expect(pointsToMm(MAGIC_CARD_HEIGHT_POINTS)).toBeCloseTo(88.9, 12);
  });

  it("uses one rounded derivative for both exterior bleed and the rounded trim", async () => {
    const original = new Uint8Array(await sharp({
      create: { width: 127, height: 178, channels: 4, background: { r: 25, g: 90, b: 155, alpha: 1 } },
    }).png().toBuffer());
    const rounded = await new BleedEngine().generate({
      imageBytes: original,
      bleedMm: 0.625,
      roundedCorners: true,
      cornerRadiusMm: 3.175,
    });
    const pdf = await engine.generate({ images: [original], bleedResults: [rounded] });
    const parsed = await parsePdf(pdf);
    const draws = getImageDrawsWithClips(parsed.content);

    expect(draws).toHaveLength(5);
    expect(draws.every((draw) => draw.clip !== undefined)).toBe(true);
    expect(new Set(draws.map((draw) => getImageResourceReference(parsed, draw.resourceName))).size).toBe(1);
    expect(parsed.images.filter((image) => image.dictionary.includes("/SMask"))).toHaveLength(1);
    const trimClip = draws.find((draw) =>
      Math.abs(draw.clip!.width - MAGIC_CARD_WIDTH_POINTS) < 1e-8
      && Math.abs(draw.clip!.height - MAGIC_CARD_HEIGHT_POINTS) < 1e-8,
    )?.clip;
    expect(trimClip).toBeDefined();
    expect(pointsToMm(trimClip!.width)).toBe(63.5);
    expect(pointsToMm(trimClip!.height)).toBeCloseTo(88.9, 12);

    const trimRect = rounded.preview.trimRectPx!;
    const previewWidthPx = rounded.preview.widthPx!;
    const previewHeightPx = rounded.preview.heightPx!;
    const matrices = getDrawMatrices(parsed.content);
    const imageTransform = matrices.find(([a, b, c, d]) =>
      Math.abs(b) < 1e-8 && Math.abs(c) < 1e-8 && a > MAGIC_CARD_WIDTH_POINTS && d > MAGIC_CARD_HEIGHT_POINTS,
    );
    const positionedMatrices = matrices.filter(([a, b, c, d, e, f]) =>
      Math.abs(a - 1) < 1e-10
        && Math.abs(b) < 1e-10
        && Math.abs(c) < 1e-10
        && Math.abs(d - 1) < 1e-10
        && (Math.abs(e) > 1e-10 || Math.abs(f) > 1e-10),
    );
    expect(imageTransform).toBeDefined();
    expect(positionedMatrices).toHaveLength(5);
    const [a, b, c, d, e, f] = imageTransform!;
    const pointsPerSourcePixelX = trimClip!.width / trimRect.width;
    const pointsPerSourcePixelY = trimClip!.height / trimRect.height;
    const bottomPaddingPx = previewHeightPx - trimRect.y - trimRect.height;
    expect(a).toBeCloseTo(previewWidthPx * pointsPerSourcePixelX, 10);
    expect(d).toBeCloseTo(previewHeightPx * pointsPerSourcePixelY, 10);
    expect([b, c, e, f]).toEqual([0, 0, 0, 0]);
    const expectedImageX = trimClip!.x - trimRect.x * pointsPerSourcePixelX;
    const expectedImageY = trimClip!.y - bottomPaddingPx * pointsPerSourcePixelY;
    for (const matrix of positionedMatrices) {
      expect(matrix[4]).toBeCloseTo(expectedImageX, 10);
      expect(matrix[5]).toBeCloseTo(expectedImageY, 10);
    }
  });

  it("draws bleed, one partial-alpha PNG trim, then vector guides", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-alpha.png")));
    const originalPixels = decodeFixturePng(Buffer.from(original));
    const alphaSamples = Array.from({ length: originalPixels.pixels.length / 4 }, (_, index) =>
      originalPixels.pixels[index * 4 + 3],
    );
    expect(alphaSamples.some((alpha) => alpha > 0 && alpha < 255)).toBe(true);

    const bleedMm = 0.625;
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm });
    const pdf = await engine.generate({
      images: [original],
      bleedResults: [bleed],
      cutGuides: {
        trim: { enabled: true, extentMm: "full" },
        external: { enabled: false, strokeWidthPt: 0.3 },
      },
    });
    const parsed = await parsePdf(pdf);
    const draws = getImageDrawsWithClips(parsed.content);
    const trimWidth = mmToPoints(63.5);
    const trimHeight = mmToPoints(88.9);
    const trimX = mmToPoints((210 - 63.5) / 2);
    const trimTop = (297 - 88.9) / 2;
    const trimY = mmToPoints(297 - trimTop - 88.9);
    const bleedPoints = mmToPoints(bleedMm);
    const expectedClips: readonly PdfClipRectangle[] = [
      { x: trimX - bleedPoints, y: trimY - bleedPoints, width: bleedPoints, height: trimHeight + 2 * bleedPoints },
      { x: trimX + trimWidth, y: trimY - bleedPoints, width: bleedPoints, height: trimHeight + 2 * bleedPoints },
      { x: trimX, y: trimY + trimHeight, width: trimWidth, height: bleedPoints },
      { x: trimX, y: trimY - bleedPoints, width: trimWidth, height: bleedPoints },
    ];

    expect(draws).toHaveLength(5);
    expect(draws.slice(0, 4).every((draw) => draw.clip !== undefined)).toBe(true);
    expect(draws[4].clip).toBeUndefined();
    expect(getVectorSegments(parsed.content)).toHaveLength(4);
    expect(parsed.content.lastIndexOf("\nS")).toBeGreaterThan(parsed.content.lastIndexOf(" Do"));
    for (const [index, expected] of expectedClips.entries()) {
      const actual = draws[index].clip!;
      expect(actual.x).toBeCloseTo(expected.x, 5);
      expect(actual.y).toBeCloseTo(expected.y, 5);
      expect(actual.width).toBeCloseTo(expected.width, 5);
      expect(actual.height).toBeCloseTo(expected.height, 5);
      expect(pointsToMm(actual.x)).toBeCloseTo(pointsToMm(expected.x), 5);
      expect(pointsToMm(actual.y)).toBeCloseTo(pointsToMm(expected.y), 5);
      expect(pointsToMm(actual.width)).toBeCloseTo(pointsToMm(expected.width), 5);
      expect(pointsToMm(actual.height)).toBeCloseTo(pointsToMm(expected.height), 5);

      const overlapWidth = Math.max(0, Math.min(actual.x + actual.width, trimX + trimWidth) - Math.max(actual.x, trimX));
      const overlapHeight = Math.max(0, Math.min(actual.y + actual.height, trimY + trimHeight) - Math.max(actual.y, trimY));
      expect(overlapWidth * overlapHeight).toBe(0);
    }

    const bleedReferences = draws.slice(0, 4)
      .map((draw) => getImageResourceReference(parsed, draw.resourceName));
    const originalReference = getImageResourceReference(parsed, draws[4].resourceName);
    expect(new Set(bleedReferences).size).toBe(1);
    expect(bleedReferences[0]).not.toBe(originalReference);
    expect(parsed.images.filter((image) => image.width === 7 && image.height === 6)).toHaveLength(2);
    expect(parsed.images.filter((image) => image.width === 5 && image.height === 4)).toHaveLength(2);

    const trimMatrices = getDrawMatrices(parsed.content).filter(([a, b, c, d]) =>
      Math.abs(a - trimWidth) < 1e-8
        && Math.abs(b) < 1e-8
        && Math.abs(c) < 1e-8
        && Math.abs(d - trimHeight) < 1e-8,
    );
    expect(trimMatrices).toHaveLength(1);
    expect(pointsToMm(trimMatrices[0][0])).toBe(63.5);
    expect(pointsToMm(trimMatrices[0][3])).toBeCloseTo(88.9, 12);
  });

  it("reuses clipped 16-bit PNG bleed while preserving exact source samples", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-rgb16.png")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });
    const pdf = await engine.generate({ images: [original], bleedResults: [bleed] });
    const parsed = await parsePdf(pdf);
    const draws = getImageDrawsWithClips(parsed.content);
    const bleedReferences = draws.slice(0, 4)
      .map((draw) => getImageResourceReference(parsed, draw.resourceName));
    const originalReference = getImageResourceReference(parsed, draws[4].resourceName);
    const originalImage = parsed.images.find((image) => image.width === 2 && image.height === 1)!;
    const bleedImage = parsed.images.find((image) => image.width === 4 && image.height === 3)!;
    const originalPixels = Buffer.from([
      0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
      0x12, 0xff, 0x56, 0xff, 0x9a, 0xff,
    ]);
    const bleedPixels = inflateSync(getPdfStreamBytes(bleedImage));
    const trimPixels = Buffer.concat([
      bleedPixels.subarray((1 * 4 + 1) * 6, (1 * 4 + 3) * 6),
    ]);

    expect(draws).toHaveLength(5);
    expect(draws.slice(0, 4).every((draw) => draw.clip !== undefined)).toBe(true);
    expect(draws[4].clip).toBeUndefined();
    expect(new Set(bleedReferences).size).toBe(1);
    expect(bleedReferences[0]).not.toBe(originalReference);
    expect(originalImage.dictionary).toContain("/BitsPerComponent 16");
    expect(bleedImage.dictionary).toContain("/BitsPerComponent 16");
    expect(inflateSync(getPdfStreamBytes(originalImage))).toEqual(originalPixels);
    expect(trimPixels).toEqual(originalPixels);
  });

  it("rejects a bleed derivative that belongs to another image", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const otherImage = new Uint8Array(await readFile(join(FIXTURES, "synthetic-rgb.png")));
    const bleed = await new BleedEngine().generate({ imageBytes: otherImage, bleedMm: 0.625 });

    await expect(engine.generate({ images: [original], bleedResults: [bleed] }))
      .rejects.toThrow(/original image hash/i);
  });

  it("requires one bleed result per input image when PDF bleed results are supplied", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });

    await expect(engine.generate({ images: [original], bleedResults: [bleed, bleed] }))
      .rejects.toThrow(/one result per image/i);
  });

  it("rejects a bleed derivative made for a different physical trim size", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({
      imageBytes: original,
      bleedMm: 0.625,
      trimSizeMm: { widthMm: 64, heightMm: 90 },
    });

    await expect(engine.generate({ images: [original], bleedResults: [bleed] }))
      .rejects.toThrow(/trim size does not match/i);
  });

  it("draws vector cut guides after the untouched card image with physical stroke styling", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const config: CutGuideConfig = {
      trim: { enabled: true, extentMm: "full" },
      external: { enabled: false, strokeWidthPt: 0.3 },
    };
    const withoutGuides = await engine.generate({ images: [original] });
    const withGuides = await engine.generate({ images: [original], cutGuides: config });
    const cleanPdf = await parsePdf(withoutGuides);
    const guidedPdf = await parsePdf(withGuides);
    const cleanImageHashes = cleanPdf.images.map((image) => createHash("sha256").update(getPdfStreamBytes(image)).digest("hex"));
    const guidedImageHashes = guidedPdf.images.map((image) => createHash("sha256").update(getPdfStreamBytes(image)).digest("hex"));

    expect(guidedPdf.images).toHaveLength(cleanPdf.images.length);
    expect(guidedImageHashes).toEqual(cleanImageHashes);
    expect(getVectorSegments(guidedPdf.content)).toHaveLength(4);
    const strokeWidth = /([\d.]+) w\b/.exec(guidedPdf.content)?.[1];
    const strokeColor = /([\d.]+) ([\d.]+) ([\d.]+) RG\b/.exec(guidedPdf.content)?.slice(1).map(Number);
    expect(Number(strokeWidth)).toBeCloseTo(0.2, 8);
    expect(strokeColor).toEqual([
      expect.closeTo(0x00 / 255, 8),
      expect.closeTo(0xa6 / 255, 8),
      expect.closeTo(0xd6 / 255, 8),
    ]);
    expect(guidedPdf.content.lastIndexOf("\nS")).toBeGreaterThan(guidedPdf.content.lastIndexOf(" Do"));

    const fullLines = getVectorSegments(guidedPdf.content);
    const trimWidthPoints = mmToPoints(63.5);
    const trimHeightPoints = mmToPoints(88.9);
    expect(fullLines).toContainEqual([
      expect.closeTo(mmToPoints(73.25), 7),
      expect.closeTo(mmToPoints(192.95), 7),
      expect.closeTo(mmToPoints(136.75), 7),
      expect.closeTo(mmToPoints(192.95), 7),
    ]);
    expect(trimWidthPoints).toBe(180);
    expect(trimHeightPoints).toBeCloseTo(252, 10);
  });

  it("serializes 1 mm trim corner segments at exact physical trim coordinates", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const pdf = await engine.generate({
      images: [original],
      cutGuides: {
        trim: { enabled: true, extentMm: 1 },
        external: { enabled: false, strokeWidthPt: 0.3 },
      },
    });
    const parsed = await parsePdf(pdf);
    const segments = getVectorSegments(parsed.content).map(([x1Pt, y1Pt, x2Pt, y2Pt]) => ({
      x1Mm: pointsToMm(x1Pt),
      y1Mm: 297 - pointsToMm(y1Pt),
      x2Mm: pointsToMm(x2Pt),
      y2Mm: 297 - pointsToMm(y2Pt),
    }));
    const horizontal = segments.filter(({ y1Mm, y2Mm }) => Math.abs(y1Mm - y2Mm) < 1e-8);
    const vertical = segments.filter(({ x1Mm, x2Mm }) => Math.abs(x1Mm - x2Mm) < 1e-8);
    const actualSegments = segments.map(({ x1Mm, y1Mm, x2Mm, y2Mm }) => {
      if (Math.abs(y1Mm - y2Mm) < 1e-8) {
        return [Math.min(x1Mm, x2Mm), y1Mm, Math.max(x1Mm, x2Mm), y1Mm];
      }
      return [x1Mm, Math.min(y1Mm, y2Mm), x1Mm, Math.max(y1Mm, y2Mm)];
    }).map((segment) => segment.map((coordinate) => Number(coordinate.toFixed(8))))
      .sort((a, b) => a.join(",").localeCompare(b.join(",")));
    const expectedSegments = [
      [73.25, 104.05, 74.25, 104.05],
      [135.75, 104.05, 136.75, 104.05],
      [73.25, 192.95, 74.25, 192.95],
      [135.75, 192.95, 136.75, 192.95],
      [73.25, 104.05, 73.25, 105.05],
      [136.75, 104.05, 136.75, 105.05],
      [73.25, 191.95, 73.25, 192.95],
      [136.75, 191.95, 136.75, 192.95],
    ].sort((a, b) => a.join(",").localeCompare(b.join(",")));

    expect(segments).toHaveLength(8);
    expect(horizontal).toHaveLength(4);
    expect(vertical).toHaveLength(4);
    expect(new Set(actualSegments.map((segment) => segment.join(","))).size).toBe(8);
    expect(actualSegments).toEqual(expectedSegments);
    for (const { x1Mm, y1Mm, x2Mm, y2Mm } of segments) {
      expect(Math.hypot(x2Mm - x1Mm, y2Mm - y1Mm)).toBeCloseTo(1, 8);
    }
    for (const { x1Mm, y1Mm, x2Mm } of horizontal) {
      expect([104.05, 192.95].some((edge) => Math.abs(y1Mm - edge) < 1e-8)).toBe(true);
      const start = Math.min(x1Mm, x2Mm);
      const end = Math.max(x1Mm, x2Mm);
      expect(
        (Math.abs(start - 73.25) < 1e-8 && Math.abs(end - 74.25) < 1e-8)
        || (Math.abs(start - 135.75) < 1e-8 && Math.abs(end - 136.75) < 1e-8),
      ).toBe(true);
    }
    for (const { x1Mm, y1Mm, y2Mm } of vertical) {
      expect([73.25, 136.75].some((edge) => Math.abs(x1Mm - edge) < 1e-8)).toBe(true);
      const start = Math.min(y1Mm, y2Mm);
      const end = Math.max(y1Mm, y2Mm);
      expect(
        (Math.abs(start - 104.05) < 1e-8 && Math.abs(end - 105.05) < 1e-8)
        || (Math.abs(start - 191.95) < 1e-8 && Math.abs(end - 192.95) < 1e-8),
      ).toBe(true);
    }
  });

  it.each([
    ["both OFF", { trim: { enabled: false, extentMm: 1 }, external: { enabled: false, strokeWidthPt: 0.3 } }, 0],
    ["trim only", { trim: { enabled: true, extentMm: "full" }, external: { enabled: false, strokeWidthPt: 0.3 } }, 4],
    ["external only", { trim: { enabled: false, extentMm: 1 }, external: { enabled: true, strokeWidthPt: 0.3 } }, 8],
    ["both ON", { trim: { enabled: true, extentMm: 1 }, external: { enabled: true, strokeWidthPt: 0.3 } }, 16],
  ] as const)("keeps %s vector-only and independent of image objects", async (_mode, config, segmentCount) => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const clean = await engine.generate({ images: [original] });
    const guided = await engine.generate({ images: [original], cutGuides: config });
    const cleanPdf = await parsePdf(clean);
    const guidedPdf = await parsePdf(guided);

    expect(guidedPdf.images).toHaveLength(cleanPdf.images.length);
    expect(guidedPdf.images.map((image) => createHash("sha256").update(getPdfStreamBytes(image)).digest("hex")))
      .toEqual(cleanPdf.images.map((image) => createHash("sha256").update(getPdfStreamBytes(image)).digest("hex")));
    expect(getVectorSegments(guidedPdf.content)).toHaveLength(segmentCount);
  });

  it("writes external paths at trim coordinates in real PDF points beyond the bleed", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });
    const pdf = await engine.generate({
      images: [original],
      bleedResults: [bleed],
      cutGuides: {
        trim: { enabled: false, extentMm: 1 },
        external: { enabled: true, strokeWidthPt: 0.3 },
      },
    });
    const parsed = await parsePdf(pdf);
    const lines = getVectorSegments(parsed.content);
    const radiusMm = 0.3 * 25.4 / 72 / 2;
    const trimX = 73.25;
    const trimTop = 104.05;
    const pageY = 297 - trimTop;

    expect(lines).toHaveLength(8);
    expect(lines).toContainEqual([
      expect.closeTo(mmToPoints(radiusMm), 8),
      expect.closeTo(mmToPoints(pageY), 8),
      expect.closeTo(mmToPoints(trimX - 0.625 - radiusMm), 8),
      expect.closeTo(mmToPoints(pageY), 8),
    ]);
    expect(lines).toContainEqual([
      expect.closeTo(mmToPoints(trimX + 63.5 + 0.625 + radiusMm), 8),
      expect.closeTo(mmToPoints(pageY), 8),
      expect.closeTo(mmToPoints(210 - radiusMm), 8),
      expect.closeTo(mmToPoints(pageY), 8),
    ]);
    expect(/([\d.]+) w\b/.exec(parsed.content)?.[1]).toBe("0.3");
    expect(/([\d.]+) ([\d.]+) ([\d.]+) RG\b/.exec(parsed.content)?.slice(1).map(Number)).toEqual([
      expect.closeTo(0xe8 / 255, 8),
      expect.closeTo(0x75 / 255, 8),
      expect.closeTo(0x00 / 255, 8),
    ]);
  });

  it("keeps external guide geometry unchanged when rounded-corner rendering is toggled", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const withoutRoundedCorners = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });
    const withRoundedCorners = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625, roundedCorners: true });
    const config: CutGuideConfig = {
      trim: { enabled: true, extentMm: 1 },
      external: { enabled: true, strokeWidthPt: 0.3 },
    };
    const plainPdf = await engine.generate({ images: [original], bleedResults: [withoutRoundedCorners], cutGuides: config });
    const roundedPdf = await engine.generate({ images: [original], bleedResults: [withRoundedCorners], cutGuides: config });

    expect(getVectorSegments((await parsePdf(roundedPdf)).content))
      .toEqual(getVectorSegments((await parsePdf(plainPdf)).content));
  });

  it.each([0, 0.625, 1, 2, 3])("keeps trim cut coordinates fixed with %s mm bleed", async (bleedMm) => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm });
    const pdf = await engine.generate({
      images: [original],
      bleedResults: [bleed],
      cutGuides: {
        trim: { enabled: true, extentMm: "full" },
        external: { enabled: false, strokeWidthPt: 0.3 },
      },
    });
    const parsed = await parsePdf(pdf);
    const guides = getVectorSegments(parsed.content);

    expect(guides).toHaveLength(4);
    expect(guides.map((segment) => segment.map((coordinate) => Number(coordinate.toFixed(8)))))
      .toEqual([
        [mmToPoints(73.25), mmToPoints(192.95), mmToPoints(136.75), mmToPoints(192.95)],
        [mmToPoints(73.25), mmToPoints(104.05), mmToPoints(136.75), mmToPoints(104.05)],
        [mmToPoints(73.25), mmToPoints(192.95), mmToPoints(73.25), mmToPoints(104.05)],
        [mmToPoints(136.75), mmToPoints(192.95), mmToPoints(136.75), mmToPoints(104.05)],
      ].map((segment) => segment.map((coordinate) => Number(coordinate.toFixed(8)))));
    expect(pointsToMm(guides[0][2] - guides[0][0])).toBe(63.5);
    expect(Math.abs(pointsToMm(guides[1][1] - guides[0][1]))).toBeCloseTo(88.9, 12);
  });

  it("places nine bleed-bearing cards on A4 without overlapping derivative slots", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });
    const pdf = await engine.generate({
      images: Array.from({ length: 9 }, () => original),
      bleedResults: Array.from({ length: 9 }, () => bleed),
      cutGuides: {
        trim: { enabled: false, extentMm: 1 },
        external: { enabled: false, strokeWidthPt: 0.3 },
      },
    });
    const parsed = await parsePdf(pdf);
    const imageDraws = getImageDrawsWithClips(parsed.content);

    expect(parsed.document.getPages()).toHaveLength(1);
    expect(parsed.images).toHaveLength(18);
    expect(getVectorSegments(parsed.content)).toHaveLength(0);
    expect(imageDraws).toHaveLength(45);
    const actualClips = new Set(imageDraws.filter((draw) => draw.clip).map((draw) => {
      const clip = draw.clip!;
      return [clip.x, clip.y, clip.width, clip.height].map((value) => pointsToMm(value).toFixed(7)).join(",");
    }));
    const requestedBleedPoints = mmToPoints(0.625);
    const trimWidthPoints = mmToPoints(63.5);
    const trimHeightPoints = mmToPoints(88.9);
    const expectedClips = new Set<string>();
    for (const [xMm, topMm] of [
      [8.5, 194.2], [73.25, 194.2], [138, 194.2],
      [8.5, 104.05], [73.25, 104.05], [138, 104.05],
      [8.5, 13.9], [73.25, 13.9], [138, 13.9],
    ]) {
      const trimXPoints = mmToPoints(xMm);
      const trimYPoints = mmToPoints(297 - topMm - 88.9);
      const clips = [
        { x: trimXPoints - requestedBleedPoints, y: trimYPoints - requestedBleedPoints, width: requestedBleedPoints, height: trimHeightPoints + 2 * requestedBleedPoints },
        { x: trimXPoints + trimWidthPoints, y: trimYPoints - requestedBleedPoints, width: requestedBleedPoints, height: trimHeightPoints + 2 * requestedBleedPoints },
        { x: trimXPoints, y: trimYPoints + trimHeightPoints, width: trimWidthPoints, height: requestedBleedPoints },
        { x: trimXPoints, y: trimYPoints - requestedBleedPoints, width: trimWidthPoints, height: requestedBleedPoints },
      ];
      for (const clip of clips) {
        expectedClips.add([clip.x, clip.y, clip.width, clip.height]
          .map((value) => pointsToMm(value).toFixed(7)).join(","));
      }
    }
    expect(actualClips.size).toBe(36);
    expect(actualClips).toEqual(expectedClips);
  });

  it.each([0.3, 2])("packs mixed 0 mm and 3 mm bleed on one Letter page with %s pt vector guides", async (strokeWidthPt) => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 3 });
    const paperFormat = { name: "Letter", widthMm: 215.9, heightMm: 279.4 } as const;
    const bleedByCardMm = [3, 0, 0, 0, 0, 0, 0, 0, 0];
    const pdf = await engine.generate({
      images: Array.from({ length: 9 }, () => original),
      bleedResults: [bleed, ...Array.from({ length: 8 }, () => undefined)],
      paperFormat,
      cutGuides: {
        trim: { enabled: false, extentMm: 1 },
        external: { enabled: true, strokeWidthPt },
      },
    });
    const parsed = await parsePdf(pdf);

    expect(parsed.document.getPages()).toHaveLength(1);
    expect(parsed.images).toHaveLength(10);
    const guides = getVectorSegments(parsed.content);
    expect(guides.length).toBeGreaterThan(10);
    const uniqueVerticalCoordinates = [...new Set(guides
      .filter(([x1, , x2]) => Math.abs(x1 - x2) < 1e-10)
      .map(([x1]) => Number(pointsToMm(x1).toFixed(8))))];
    const uniqueHorizontalCoordinates = [...new Set(guides
      .filter(([, y1, , y2]) => Math.abs(y1 - y2) < 1e-10)
      .map(([, y1]) => Number(pointsToMm(y1).toFixed(8))))]
      .sort((a, b) => a - b);
    expect(uniqueVerticalCoordinates).toEqual([12.7, 76.2, 79.2, 142.7, 206.2]);
    expect(uniqueHorizontalCoordinates).toEqual([3.35, 92.25, 181.15, 184.15, 273.05]);

    const placement = calculateGridPlacement({
      paper: paperFormat,
      card: MAGIC_STANDARD_CARD,
      count: 9,
      bleedMm: 0,
      bleedByCardMm,
    });
    const cards = placement.slots.map((slot, index) => ({ trim: slot.trim, bleedMm: bleedByCardMm[index] }));
    expect(/([\d.]+) w\b/.exec(parsed.content)?.[1]).toBe(String(strokeWidthPt));
    expectExternalPdfSegmentsClear(guides, cards, paperFormat.heightMm, strokeWidthPt);
  });

  it("fails clearly when the physical trim plus bleed cannot fit on the selected paper", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });

    await expect(engine.generate({
      images: [original],
      bleedResults: [bleed],
      paperFormat: { name: "Trim-sized sheet", widthMm: 63.5, heightMm: 88.9 },
    })).rejects.toThrow(/no physical card slot fits/i);
  });

  it("rejects bleed that would be clipped by page bounds", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });

    await expect(engine.generate({
      images: [original],
      bleedResults: [bleed],
      paperFormat: { name: "Trim-sized sheet", widthMm: 63.5, heightMm: 88.9 },
    })).rejects.toThrow(/no physical card slot fits/i);
  });

  it("embeds an untouched JPEG DCT stream and accepts a non-zero-offset byte view", async () => {
    const original = await readFile(join(FIXTURES, "synthetic-gradient.jpg"));
    const padded = Buffer.alloc(original.length + 19, 0xa5);
    original.copy(padded, 7);
    const imageView = padded.subarray(7, 7 + original.length);

    const pdf = await engine.generate({ images: [imageView] });
    const parsed = await parsePdf(pdf);
    const jpegImage = parsed.images.find((image) => image.dictionary.includes("/DCTDecode"));

    expect(jpegImage).toBeDefined();
    expect(jpegImage).toMatchObject({ width: 8, height: 6 });
    expect(createHash("sha256").update(getPdfStreamBytes(jpegImage!)).digest("hex"))
      .toBe(createHash("sha256").update(original).digest("hex"));
  });

  it("preserves PNG RGB dimensions and every pixel sample losslessly", async () => {
    const source = decodeFixturePng(await readFile(join(FIXTURES, "synthetic-rgb.png")));
    const pdf = await engine.generate({
      images: [new Uint8Array(await readFile(join(FIXTURES, "synthetic-rgb.png")))],
    });
    const parsed = await parsePdf(pdf);
    const image = parsed.images.find((candidate) => candidate.dictionary.includes("/DeviceRGB"));

    expect(image).toBeDefined();
    expect(image).toMatchObject({ width: source.width, height: source.height });
    expect(image!.dictionary).toContain("/FlateDecode");
    expect(image!.dictionary).not.toContain("/SMask");
    expect(image!.dictionary).not.toContain("/DCTDecode");
    expect(inflateSync(getPdfStreamBytes(image!))).toEqual(source.pixels);
    assertMatrixContainsSize(parsed.content, MAGIC_CARD_WIDTH_POINTS, MAGIC_CARD_HEIGHT_POINTS);
  });

  it("preserves low-byte precision of 16-bit PNG samples", async () => {
    const sourcePixels = Buffer.from([
      0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
      0x12, 0xff, 0x56, 0xff, 0x9a, 0xff,
    ]);
    const png16 = new Uint8Array(await readFile(join(FIXTURES, "synthetic-rgb16.png")));
    const pdf = await engine.generate({ images: [png16] });
    const parsed = await parsePdf(pdf);
    const image = parsed.images.find((candidate) => candidate.dictionary.includes("/DeviceRGB"));

    expect(image).toBeDefined();
    expect(image).toMatchObject({ width: 2, height: 1 });
    expect(image!.dictionary).toContain("/BitsPerComponent 16");
    expect(inflateSync(getPdfStreamBytes(image!))).toEqual(sourcePixels);
  });

  it("reassembles interlaced 16-bit PNG samples without losing native pixels", async () => {
    const sourcePixels = Buffer.from([
      0x10, 0x01, 0x20, 0x02, 0x30, 0x03,
      0x40, 0x04, 0x50, 0x05, 0x60, 0x06,
      0x70, 0x07, 0x80, 0x08, 0x90, 0x09,
      0xa0, 0x0a, 0xb0, 0x0b, 0xc0, 0x0c,
    ]);
    const png16 = new Uint8Array(await readFile(join(FIXTURES, "synthetic-rgb16-adam7.png")));
    const pdf = await engine.generate({ images: [png16] });
    const parsed = await parsePdf(pdf);
    const image = parsed.images.find((candidate) => candidate.dictionary.includes("/DeviceRGB"));

    expect(image).toMatchObject({ width: 2, height: 2 });
    expect(image!.dictionary).toContain("/BitsPerComponent 16");
    expect(inflateSync(getPdfStreamBytes(image!))).toEqual(sourcePixels);
  });

  it("preserves 16-bit PNG alpha in a full-precision PDF soft mask", async () => {
    const sourceColors = Buffer.from([
      0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
      0x12, 0xff, 0x56, 0xff, 0x9a, 0xff,
    ]);
    const sourceAlpha = Buffer.from([0x00, 0xaa, 0xff, 0x01]);
    const png16 = new Uint8Array(await readFile(join(FIXTURES, "synthetic-rgba16.png")));
    const pdf = await engine.generate({ images: [png16] });
    const parsed = await parsePdf(pdf);
    const image = parsed.images.find((candidate) => candidate.dictionary.includes("/SMask"));

    expect(image).toBeDefined();
    expect(image).toMatchObject({ width: 2, height: 1 });
    expect(image!.dictionary).toContain("/BitsPerComponent 16");
    expect(inflateSync(getPdfStreamBytes(image!))).toEqual(sourceColors);

    const mask = getAlphaMask(parsed, image!);
    expect(mask.dictionary).toContain("/BitsPerComponent 16");
    expect(inflateSync(getPdfStreamBytes(mask))).toEqual(sourceAlpha);
  });

  it("preserves 16-bit PNG transparent color keys as a PDF soft mask", async () => {
    const sourceColors = Buffer.from([
      0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
      0x12, 0xff, 0x56, 0xff, 0x9a, 0xff,
    ]);
    const png16 = new Uint8Array(await readFile(join(FIXTURES, "synthetic-rgb16-trns.png")));
    const pdf = await engine.generate({ images: [png16] });
    const parsed = await parsePdf(pdf);
    const image = parsed.images.find((candidate) => candidate.dictionary.includes("/SMask"));

    expect(image).toMatchObject({ width: 2, height: 1 });
    expect(inflateSync(getPdfStreamBytes(image!))).toEqual(sourceColors);
    expect(inflateSync(getPdfStreamBytes(getAlphaMask(parsed, image!))))
      .toEqual(Buffer.from([0x00, 0x00, 0xff, 0xff]));
  });

  it("preserves PNG alpha in a lossless PDF soft mask", async () => {
    const source = decodeFixturePng(await readFile(join(FIXTURES, "synthetic-alpha.png")));
    const pdf = await engine.generate({
      images: [new Uint8Array(await readFile(join(FIXTURES, "synthetic-alpha.png")))],
    });
    const parsed = await parsePdf(pdf);
    const colorImage = parsed.images.find((candidate) => candidate.dictionary.includes("/SMask"));

    expect(source.channels).toBe(4);
    expect(colorImage).toBeDefined();
    expect(colorImage).toMatchObject({ width: source.width, height: source.height });
    expect(colorImage!.dictionary).toContain("/DeviceRGB");
    expect(colorImage!.dictionary).toContain("/FlateDecode");
    expect(inflateSync(getPdfStreamBytes(colorImage!))).toEqual(
      Buffer.from(source.pixels.filter((_, index) => index % 4 !== 3)),
    );

    const sourceAlpha = Buffer.from(source.pixels.filter((_, index) => index % 4 === 3));
    const mask = getAlphaMask(parsed, colorImage!);

    expect(mask).toMatchObject({ width: source.width, height: source.height });
    expect(mask.dictionary).toContain("/DeviceGray");
    expect(mask.dictionary).toContain("/FlateDecode");
    expect(inflateSync(getPdfStreamBytes(mask))).toEqual(sourceAlpha);
  });

  it("draws compatible SVG paths as vectors without making an image XObject", async () => {
    const svg = new Uint8Array(await readFile(join(FIXTURES, "simple-vector.svg")));
    const pdf = await engine.generate({ images: [svg] });
    const parsed = await parsePdf(pdf);

    expect(parsed.images).toHaveLength(0);
    expect(parsed.content).toContain("99 139 l");
    expect(parsed.content).toMatch(/\nh\n/);
    expect(parsed.content).toMatch(/\nf\n/);
    expect(parsed.content.match(/\s+Do\b/g)).toBeNull();

    const svgCardMatrix = getDrawMatrices(parsed.content).find(([a, , , d]) =>
      Math.abs(a - 2.4) < 1e-10 && Math.abs(d - 2.4) < 1e-10,
    );
    expect(svgCardMatrix).toBeDefined();
    expect(pointsToMm(svgCardMatrix![0] * 0.75 * 100)).toBeCloseTo(63.5, 10);
    expect(pointsToMm(svgCardMatrix![3] * 0.75 * 140)).toBeCloseTo(88.9, 10);
  });

  it("draws supported SVG primitives as vector PDF operators", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 40 40"><circle cx="5" cy="5" r="4" fill="#123456" /><ellipse cx="15" cy="5" rx="4" ry="3" stroke="#123456" /><line x1="1" y1="10" x2="20" y2="10" stroke="#123456" /><polyline points="1,15 10,20 20,15" fill="none" stroke="#123456" /><polygon points="1,25 10,30 20,25" fill="#123456" /></svg>',
    );
    const pdf = await engine.generate({ images: [svg] });
    const parsed = await parsePdf(pdf);

    expect(parsed.images).toHaveLength(0);
    expect(getDrawMatrices(parsed.content).length).toBeGreaterThan(0);
    expect(parsed.content.match(/\s+Do\b/g)).toBeNull();
  });

  it("accepts an XML declaration and comments before the SVG root", async () => {
    const svgWithPreamble = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated fixture -->\n<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140" viewBox="0 0 100 140"><rect width="100" height="140" fill="#123456" /></svg>',
    );
    const pdf = await engine.generate({ images: [svgWithPreamble] });
    const parsed = await parsePdf(pdf);

    expect(parsed.images).toHaveLength(0);
    expect(parsed.content).toContain("100 140 l");
    expect(parsed.content.match(/\s+Do\b/g)).toBeNull();
  });

  it("exports multiple local images on one A4 page without merging their pixels", async () => {
    const paths = [
      "synthetic-gradient.jpg",
      "synthetic-rgb.png",
      "synthetic-alpha.png",
      "synthetic-gradient.jpg",
      "synthetic-rgb.png",
    ];
    const pdf = await engine.generateFromFiles({
      imagePaths: paths.map((path) => join(FIXTURES, path)),
    });
    const parsed = await parsePdf(pdf);

    expect(parsed.document.getPages()).toHaveLength(1);
    expect(parsed.images).toHaveLength(6);
    expect(parsed.content.match(/\s+Do\b/g)).toHaveLength(5);
    expect(getDrawMatrices(parsed.content).filter(([a, b, c, d]) =>
      Math.abs(a - MAGIC_CARD_WIDTH_POINTS) < 1e-8
        && Math.abs(b) < 1e-8
        && Math.abs(c) < 1e-8
        && Math.abs(d - MAGIC_CARD_HEIGHT_POINTS) < 1e-8,
    )).toHaveLength(5);
  });

  it("exports ten Magic Standard cards across two A4 pages", async () => {
    const cardPath = join(FIXTURES, "synthetic-gradient.jpg");
    const pdf = await engine.generateFromFiles({
      imagePaths: Array.from({ length: 10 }, () => cardPath),
    });
    const parsed = await parsePdf(pdf);

    expect(parsed.document.getPages()).toHaveLength(2);
    expect(parsed.images).toHaveLength(10);
    expect(parsed.content.match(/\s+Do\b/g)).toHaveLength(10);
  });

  it("places the physical scale pattern at exactly 100 × 100 mm", async () => {
    const scalePattern = new Uint8Array(await readFile(join(FIXTURES, "physical-scale-pattern.svg")));
    const scaleCard: CardFormat = {
      id: "scale-pattern",
      name: "100 mm scale pattern",
      widthMm: 100,
      heightMm: 100,
    };
    const pdf = await engine.generate({ images: [scalePattern], cardFormat: scaleCard });
    const parsed = await parsePdf(pdf);
    const userUnitToPoints = 3.7795275590551185 * 0.75;

    expect(parsed.images).toHaveLength(0);
    expect(getDrawMatrices(parsed.content).some(([a, , , d]) =>
      Math.abs(a - 3.7795275590551185) < 1e-10 && Math.abs(d - 3.7795275590551185) < 1e-10,
    )).toBe(true);
    expect(pointsToMm(userUnitToPoints * 100)).toBeCloseTo(100, 10);
    expect(parsed.content).toContain("100 5 l");
    expect(parsed.content).toContain("5 100 l");
  });

  it("rejects SVGs without a numeric viewBox instead of rasterizing them", async () => {
    const noViewBox = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140"><rect width="100" height="140" /></svg>',
    );

    await expect(engine.generate({ images: [noViewBox] })).rejects.toThrow(/viewBox/i);
  });

  it.each([
    ["SVG filters", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><filter id="blur"><feGaussianBlur stdDeviation="1" /></filter></defs><rect width="10" height="10" filter="url(#blur)" /></svg>'],
    ["an SVG filter property", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" filter="url(#blur)" /></svg>'],
    ["an unsupported SVG fill rule", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z" fill-rule="evenodd" /></svg>'],
    ["duplicate SVG attributes", '<svg xmlns="http://www.w3.org/2000/svg" width="10" width="20" viewBox="0 0 10 10"><rect width="10" height="10" /></svg>'],
    ["SVG foreignObject content", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject width="10" height="10"><div>visible content</div></foreignObject></svg>'],
    ["SVG text nodes", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">visible text<rect width="10" height="10" /></svg>'],
    ["nested SVG shapes", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"><path d="M0 0h10v10z" /></rect></svg>'],
  ])("rejects unsupported %s instead of silently dropping it", async (_label, source) => {
    const svg = new TextEncoder().encode(source);

    await expect(engine.generate({ images: [svg] })).rejects.toThrow(/unsupported svg/i);
  });

  it("keeps each input image's native dimensions even when its physical card is larger", async () => {
    const rgb = await readFile(join(FIXTURES, "synthetic-rgb.png"));
    const format: CardFormat = {
      ...MAGIC_STANDARD_CARD,
      widthMm: 100,
      heightMm: 140,
    };
    const pdf = await engine.generate({ images: [new Uint8Array(rgb)], cardFormat: format });
    const parsed = await parsePdf(pdf);

    expect(parsed.images[0]).toMatchObject({ width: 4, height: 3 });
    assertMatrixContainsSize(parsed.content, (100 * 72) / 25.4, (140 * 72) / 25.4);
  });
});
