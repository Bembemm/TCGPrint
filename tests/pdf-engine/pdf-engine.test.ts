import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { calculateGridPagePlacements, calculateGridPlacement, MAGIC_STANDARD_CARD, PAPER_FORMATS, type CardFormat } from "../../core/geometry";
import { createDuplexPagePairing } from "../../core/duplex";
import { buildCanonicalPrintPlan } from "../../core/duplex";
import { mmToPoints, pointsToMm } from "../../core/units";
import { BleedEngine } from "../../image-engine/bleed";
import { CutGuideEngine, type CutGuideConfig, type GuideColor } from "../../core/geometry/cut-guides";
import { LosslessPdfEngine } from "../../pdf-engine/document";
import { countRasterReuseOccurrences, readPdfRasterCacheDiagnostics } from "../../pdf-engine/document/raster-resource-policy";
import { createDefaultRegistrationConfig, generateRegistrationGeometry } from "../../core/registration";
import { resolveCutLayout, resolveCutLayoutPages } from "../../services/cut-geometry/layout-sync";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import { parseSvgCutGeometry } from "../../services/cut-geometry/svg-parser";
import { createPrintCalibrationTransform, parseSideCalibration } from "../../core/calibration";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "pdf");
const CUT_FIXTURES = join(process.cwd(), "tests", "fixtures", "cut");
const A4_WIDTH_POINTS = 595.2755905511812;
const A4_HEIGHT_POINTS = 841.8897637795276;
const MAGIC_CARD_WIDTH_POINTS = 180;
const MAGIC_CARD_HEIGHT_POINTS = 252;

function singleCardTrim(bleedMm = 0, cardOrientation?: "portrait" | "landscape", marginsMm = { top: 0, right: 0, bottom: 0, left: 0 }) {
  const page = calculateGridPagePlacements({
    placement: {
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      pageOrientation: "portrait",
      ...(cardOrientation ? { cardOrientation } : {}),
      bleedMm: 0,
      marginsMm,
      reservedZonesMm: [],
    },
    count: 1,
    bleedByCardMm: [bleedMm],
  })[0]!;
  return page.placement.slots[0]!.trim;
}

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

  it.each([
    ["portrait", "long-edge"],
    ["portrait", "short-edge"],
    ["landscape", "long-edge"],
    ["landscape", "short-edge"],
  ] as const)("places asymmetric TOP artwork upright on a shared duplex placement for %s + %s", async (orientation, flipMode) => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="white"/><path d="M60 12 L35 55 L50 55 L50 90 L70 90 L70 55 L85 55 Z" fill="black"/><text x="8" y="150" font-size="20">TOP ↑ 1B</text></svg>');
    const jpeg = new Uint8Array(await sharp(svg).jpeg({ quality: 96 }).toBuffer());
    const paper = orientation === "portrait"
      ? { name: "Portrait fixture", widthMm: 100, heightMm: 140 }
      : { name: "Landscape fixture", widthMm: 140, heightMm: 100 };
    const card = { id: "duplex-fixture", name: "20x30", widthMm: 20, heightMm: 30 };
    const pages = calculateGridPagePlacements({
      placement: { paper, pageOrientation: orientation, card, cardOrientation: "portrait", bleedMm: 0, rows: 1, columns: 2 },
      count: 2,
    });
    const pair = createDuplexPagePairing(pages, { pageOrientation: orientation, flipMode }).pagePairs[0]!;
    const expected = pair.slots.find(({ physicalCardIndex }) => physicalCardIndex === 0)!.back.trim;

    const pdf = await engine.generate({
      images: [jpeg, jpeg],
      paperFormat: paper,
      cardFormat: card,
      pageOrientation: orientation,
      cardOrientation: "portrait",
      pagePlacements: [pair.backPlacement],
      skipImageIndexes: new Set([1]),
      duplexBackPageTransform: pair.backPageTransform,
    });
    const parsed = await parsePdf(pdf);
    const image = parsed.images.find(({ dictionary }) => dictionary.includes("/DCTDecode"));
    const matrices = getDrawMatrices(parsed.content);
    const scaleMatrix = matrices.find(([a, b, c, d]) =>
      Math.abs(a - (20 * 72) / 25.4) < 1e-7 && Math.abs(d - (30 * 72) / 25.4) < 1e-7 && Math.abs(b) < 1e-8 && Math.abs(c) < 1e-8,
    );
    const translationMatrix = matrices.find(([a, b, c, d, e, f]) => a === 1 && b === 0 && c === 0 && d === 1 && (e !== 0 || f !== 0));

    expect(parsed.document.getPages()).toHaveLength(1);
    expect(parsed.images).toHaveLength(1);
    expect(Buffer.from(image!.raw.contents)).toEqual(Buffer.from(jpeg));
    expect(scaleMatrix).toBeDefined();
    expect(scaleMatrix![0]).toBeGreaterThan(0);
    expect(scaleMatrix![3]).toBeGreaterThan(0);
    expect(scaleMatrix![1]).toBe(0);
    expect(scaleMatrix![2]).toBe(0);
    const physicalArtworkTransform = getDrawMatrices(parsed.content).find(([a, b, c, d]) =>
      a === -1 && b === 0 && c === 0 && d === -1,
    );
    if (pair.backArtworkOrientation.rotationDegrees === 180) {
      expect(physicalArtworkTransform).toBeDefined();
      expect(physicalArtworkTransform?.slice(0, 4)).toEqual([-1, 0, 0, -1]);
      const pdfBottomMm = pair.backPlacement.placement.pageSizeMm.heightMm - expected.yMm - expected.heightMm;
      expect(physicalArtworkTransform?.[4]).toBeCloseTo(((expected.xMm + expected.widthMm) * 72) / 25.4, 7);
      expect(physicalArtworkTransform?.[5]).toBeCloseTo(((pdfBottomMm + expected.heightMm) * 72) / 25.4, 7);
      // Local TOP points downward in this back-page PDF; the physical Y flip turns it upright again.
      const artworkTopVector = { x: physicalArtworkTransform![2]!, y: physicalArtworkTransform![3]! };
      expect(artworkTopVector).toEqual({ x: 0, y: -1 });
      expect(pair.reflectionAxis === "y" ? -artworkTopVector.y : artworkTopVector.y).toBe(1);
    } else {
      expect(physicalArtworkTransform).toBeUndefined();
      expect(translationMatrix).toBeDefined();
      expect(translationMatrix![4]).toBeCloseTo((expected.xMm * 72) / 25.4, 7);
      expect(translationMatrix![5]).toBeCloseTo(((pair.backPlacement.placement.pageSizeMm.heightMm - expected.yMm - expected.heightMm) * 72) / 25.4, 7);
      expect(pair.backArtworkOrientation).toEqual({ rotationDegrees: 0, mirrorX: false, mirrorY: false });
    }
  });

  it.each([
    ["portrait", "long-edge", "x"],
    ["portrait", "short-edge", "y"],
    ["landscape", "long-edge", "y"],
    ["landscape", "short-edge", "x"],
  ] as const)("reflects registration vectors into the paired PDF page for %s + %s", async (orientation, flipMode, axis) => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const paper = orientation === "portrait"
      ? { name: "Portrait fixture", widthMm: 100, heightMm: 140 }
      : { name: "Landscape fixture", widthMm: 140, heightMm: 100 };
    const card = { id: "duplex-registration-fixture", name: "20x30", widthMm: 20, heightMm: 30 };
    const registration = {
      type: "custom" as const,
      orientation,
      marks: [[{ type: "rect" as const, xMm: 10, yMm: 12, widthMm: 4, heightMm: 6, fill: true, strokeWidthMm: 0 }]],
      reservedZones: [{ xMm: 8, yMm: 10, widthMm: 8, heightMm: 10 }],
    };
    const pages = calculateGridPagePlacements({
      placement: { paper, pageOrientation: orientation, card, cardOrientation: "portrait", bleedMm: 0, rows: 1, columns: 1 },
      count: 1,
    });
    const pair = createDuplexPagePairing(pages, { pageOrientation: orientation, flipMode }).pagePairs[0]!;
    const pdf = await engine.generate({
      images: [jpeg],
      paperFormat: paper,
      cardFormat: card,
      pageOrientation: orientation,
      cardOrientation: "portrait",
      registration,
      pagePlacements: [pair.backPlacement],
      duplexBackPageTransform: pair.backPageTransform,
    });
    const parsed = await parsePdf(pdf);
    const widthMm = paper.widthMm;
    const heightMm = paper.heightMm;
    const expectedX = axis === "x" ? widthMm - 10 - 4 : 10;
    const expectedTopMm = axis === "y" ? heightMm - 12 - 6 : 12;
    const expectedXPoints = (expectedX * 72) / 25.4;
    const expectedYPoints = ((heightMm - expectedTopMm - 6) * 72) / 25.4;
    const registrationTranslation = getDrawMatrices(parsed.content).find(([a, b, c, d, e, f]) =>
      a === 1 && b === 0 && c === 0 && d === 1
        && Math.abs(e - expectedXPoints) < 1e-7
        && Math.abs(f - expectedYPoints) < 1e-7,
    );

    expect(registrationTranslation).toBeDefined();
    expect(pair.backPageTransform.registrationReflectionAxis).toBe(axis);
  });

  it("composes duplex back correction with the independent card orientation rotation", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const paper = { name: "Portrait fixture", widthMm: 100, heightMm: 140 };
    const card = { id: "oriented-duplex-fixture", name: "20x30", widthMm: 20, heightMm: 30 };
    const pages = calculateGridPagePlacements({
      placement: { paper, pageOrientation: "portrait", card, cardOrientation: "landscape", bleedMm: 0, rows: 1, columns: 1 },
      count: 1,
    });
    const pair = createDuplexPagePairing(pages, { pageOrientation: "portrait", flipMode: "short-edge" }).pagePairs[0]!;
    const trim = pair.backPlacement.placement.slots[0]!.trim;
    const pdf = await engine.generate({
      images: [jpeg],
      paperFormat: paper,
      cardFormat: card,
      pageOrientation: "portrait",
      cardOrientation: "landscape",
      pagePlacements: [pair.backPlacement],
      duplexBackPageTransform: pair.backPageTransform,
    });
    const parsed = await parsePdf(pdf);
    const xPoints = (trim.xMm * 72) / 25.4;
    const yPoints = ((140 - trim.yMm - trim.heightMm) * 72) / 25.4;
    const targetWidthPoints = (trim.widthMm * 72) / 25.4;
    const composed = getDrawMatrices(parsed.content).find(([a, b, c, d, e, f]) =>
      a === 0 && b === 1 && c === -1 && d === 0
        && Math.abs(e - xPoints - targetWidthPoints) < 1e-7
        && Math.abs(f - yPoints) < 1e-7,
    );

    expect(pair.backArtworkOrientation.rotationDegrees).toBe(180);
    expect(composed).toBeDefined();
    expect(Buffer.from(parsed.images.find(({ dictionary }) => dictionary.includes("/DCTDecode"))!.raw.contents)).toEqual(Buffer.from(jpeg));
  });

  it("adds independent landscape registration vectors to a landscape sheet without changing portrait card trim", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const registration = createDefaultRegistrationConfig("three-point", "landscape");
    const pdf = await engine.generate({
      images: [jpeg],
      pageOrientation: "landscape",
      cardOrientation: "portrait",
      registration,
    });
    const parsed = await parsePdf(pdf);
    const page = parsed.document.getPages()[0];
    const mediaBox = page.getMediaBox();
    const segments = getVectorSegments(parsed.content);
    const geometry = generateRegistrationGeometry(registration, { widthMm: 297, heightMm: 210 });
    const layout = calculateGridPlacement({
      paper: { ...PAPER_FORMATS.A4 },
      pageOrientation: "landscape",
      card: MAGIC_STANDARD_CARD,
      cardOrientation: "portrait",
      count: 1,
      bleedMm: 0,
      reservedZonesMm: geometry.reservedZones,
    });

    expect(mediaBox.width).toBeCloseTo(A4_HEIGHT_POINTS, 10);
    expect(mediaBox.height).toBeCloseTo(A4_WIDTH_POINTS, 10);
    expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(1);
    expect(segments).toHaveLength(4);
    expect(geometry.marks).toHaveLength(3);
    assertMatrixContainsSize(parsed.content, MAGIC_CARD_WIDTH_POINTS, MAGIC_CARD_HEIGHT_POINTS);
    const expectedCardPositionMatrix = [
      1,
      0,
      0,
      1,
      mmToPoints(layout.slots[0]!.trim.xMm),
      mmToPoints(210 - layout.slots[0]!.trim.yMm - layout.cardSizeMm.heightMm),
    ];
    expect(getDrawMatrices(parsed.content).some((matrix) =>
      matrix.every((value, index) => Math.abs(value - expectedCardPositionMatrix[index]!) < 1e-8),
    )).toBe(true);
    assertMatrixContainsSize(parsed.content, MAGIC_CARD_WIDTH_POINTS, MAGIC_CARD_HEIGHT_POINTS);
    const expectedSegments = geometry.marks.flatMap(({ primitives }) => primitives)
      .filter((primitive) => primitive.type === "line")
      .map((primitive) => [
        mmToPoints(primitive.x1Mm),
        mmToPoints(210 - primitive.y1Mm),
        mmToPoints(primitive.x2Mm),
        mmToPoints(210 - primitive.y2Mm),
      ]);
    segments.forEach((segment, index) => {
      expectedSegments[index]!.forEach((value, coordinateIndex) => {
        expect(segment[coordinateIndex]).toBeCloseTo(value, 8);
      });
    });
    for (const [x1, y1, x2, y2] of segments) {
      expect(x1).toBeGreaterThanOrEqual(0);
      expect(x2).toBeLessThanOrEqual(mediaBox.width);
      expect(y1).toBeGreaterThanOrEqual(0);
      expect(y2).toBeLessThanOrEqual(mediaBox.height);
    }
  });

  it("keeps a portrait sheet and portrait card while landscape registration rotates independently", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const registration = createDefaultRegistrationConfig("three-point", "landscape");
    const parsed = await parsePdf(await engine.generate({
      images: [jpeg],
      pageOrientation: "portrait",
      cardOrientation: "portrait",
      registration,
    }));
    const mediaBox = parsed.document.getPages()[0]!.getMediaBox();
    const expectedGeometry = generateRegistrationGeometry(registration, { widthMm: 210, heightMm: 297 });
    const expectedSegments = expectedGeometry.marks.flatMap(({ primitives }) => primitives)
      .filter((primitive) => primitive.type === "line")
      .map((primitive) => [
        mmToPoints(primitive.x1Mm),
        mmToPoints(297 - primitive.y1Mm),
        mmToPoints(primitive.x2Mm),
        mmToPoints(297 - primitive.y2Mm),
      ]);

    expect(mediaBox.width).toBeCloseTo(A4_WIDTH_POINTS, 10);
    expect(mediaBox.height).toBeCloseTo(A4_HEIGHT_POINTS, 10);
    expect(getVectorSegments(parsed.content)).toHaveLength(4);
    getVectorSegments(parsed.content).forEach((segment, index) => {
      expectedSegments[index]!.forEach((value, coordinateIndex) => {
        expect(segment[coordinateIndex]).toBeCloseTo(value, 8);
      });
    });
    assertMatrixContainsSize(parsed.content, MAGIC_CARD_WIDTH_POINTS, MAGIC_CARD_HEIGHT_POINTS);
  });

  it("rotates portrait artwork clockwise into an explicitly landscape card trim", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const pdf = await engine.generate({
      images: [jpeg],
      registration: { type: "none", orientation: "portrait" },
      cardOrientation: "landscape",
    });
    const parsed = await parsePdf(pdf);
    const layout = calculateGridPlacement({
      paper: { ...PAPER_FORMATS.A4 },
      card: MAGIC_STANDARD_CARD,
      cardOrientation: "landscape",
      count: 1,
      bleedMm: 0,
    });
    const trim = layout.slots[0]!.trim;
    const sourceWidth = mmToPoints(MAGIC_STANDARD_CARD.widthMm);
    const sourceHeight = mmToPoints(MAGIC_STANDARD_CARD.heightMm);
    const expectedRotation = [
      0,
      -1,
      1,
      0,
      mmToPoints(trim.xMm),
      mmToPoints(297 - trim.yMm - layout.cardSizeMm.heightMm) + sourceWidth,
    ];

    expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(1);
    expect(getDrawMatrices(parsed.content).some((matrix) =>
      matrix.every((value, index) => Math.abs(value - expectedRotation[index]!) < 1e-8),
    )).toBe(true);
    assertMatrixContainsSize(parsed.content, sourceWidth, sourceHeight);
    expect(layout.cardSizeMm.widthMm).toBe(88.9);
    expect(layout.cardSizeMm.heightMm).toBe(63.5);
  });

  it("adds no registration vectors for registration none", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const pdf = await engine.generate({
      images: [jpeg],
      registration: { type: "none", orientation: "landscape" },
    });
    const parsed = await parsePdf(pdf);

    expect(getVectorSegments(parsed.content)).toHaveLength(0);
    expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(1);
    assertMatrixContainsSize(parsed.content, MAGIC_CARD_WIDTH_POINTS, MAGIC_CARD_HEIGHT_POINTS);
  });

  it("keeps a skipped slot in its stable position and exports cards only into active slots", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const layout = calculateGridPlacement({
      paper: { ...PAPER_FORMATS.A4 },
      card: MAGIC_STANDARD_CARD,
      count: 2,
      bleedMm: 0,
      rows: 1,
      columns: 3,
      skippedSlotIndices: [1],
    });
    const pdf = await engine.generate({
      images: [jpeg, jpeg],
      layoutRows: 1,
      layoutColumns: 3,
      skippedSlotIndices: [1],
      registration: { type: "none", orientation: "portrait" },
    });
    const parsed = await parsePdf(pdf);
    const cardMatrices = getDrawMatrices(parsed.content).filter(([a, b, c, d]) =>
      Math.abs(a - MAGIC_CARD_WIDTH_POINTS) < 1e-8 && Math.abs(b) < 1e-8 && Math.abs(c) < 1e-8 && Math.abs(d - MAGIC_CARD_HEIGHT_POINTS) < 1e-8);
    const positionMatrices = getDrawMatrices(parsed.content).filter(([a, b, c, d, x, y]) =>
      Math.abs(a - 1) < 1e-10 && Math.abs(b) < 1e-10 && Math.abs(c) < 1e-10 && Math.abs(d - 1) < 1e-10 && (Math.abs(x) > 1e-10 || Math.abs(y) > 1e-10));
    const actualX = positionMatrices.map(([, , , , x]) => pointsToMm(x)).sort((a, b) => a - b);
    const expectedX = layout.slots.map(({ trim }) => trim.xMm).sort((a, b) => a - b);

    expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(1);
    expect(cardMatrices).toHaveLength(2);
    expect(positionMatrices).toHaveLength(2);
    expect(actualX).toEqual(expectedX);
    expect(actualX).not.toContain(layout.gridSlots[1]!.trim.xMm);
  });

  it("keeps PDF trim coordinates numerically identical to canonical cut paths with registration and a skipped slot", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const fixture = JSON.parse(await readFile(join(CUT_FIXTURES, "layout-sync.json"), "utf8")) as {
      expectedActiveTrimMm: { xMm: number; yMm: number; widthMm: number; heightMm: number };
      expectedPdfImageMatrixPoints: { a: number; d: number; e: number; f: number };
    };
    const templateGeometry = {
      orientation: "portrait" as const,
      cardOrientation: "portrait" as const,
      pageSizeMm: { widthMm: 210, heightMm: 297 },
      cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      rows: 1,
      columns: 2,
      slots: [
        { index: 0, row: 0, column: 0, xMm: 50, yMm: 100 },
        { index: 1, row: 0, column: 1, xMm: 130, yMm: 100 },
      ],
    };
    const registration = createDefaultRegistrationConfig("three-point", "portrait");
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      bleedMm: 0,
      registration,
      layout: { rows: 1, columns: 2, skippedSlotIndices: [1], templateGeometry },
    };
    const sourceGeometry = parseSvgCutGeometry(new Uint8Array(await readFile(join(CUT_FIXTURES, "layout-sync.svg"))), {
      source: { kind: "template-file", templateId: "cut-sync-fixture", version: "1", packageHash: "a".repeat(64), fileId: "layout-sync-svg", fileHash: "b".repeat(64) },
      expectedPageSizeMm: { widthMm: 210, heightMm: 297 },
    });
    const layout = resolveCutLayout({ projectId: "pdf-cut-sync-fixture", projectRevision: 1, settings, cardCount: 1, sourceGeometry, sourceOrientation: "portrait" });
    const pdf = await engine.generate({
      images: [jpeg],
      pageOrientation: "portrait",
      cardOrientation: "portrait",
      paperFormat: PAPER_FORMATS.A4,
      cardFormat: MAGIC_STANDARD_CARD,
      templateGeometry,
      layoutRows: 1,
      layoutColumns: 2,
      skippedSlotIndices: [1],
      registration,
    });
    const parsed = await parsePdf(pdf);
    const activeCut = layout.activeGeometry!.paths[0]!;
    const trimMatrix = getDrawMatrices(parsed.content).find(([a, b, c, d]) =>
      Math.abs(a - MAGIC_CARD_WIDTH_POINTS) < 1e-8 && Math.abs(b) < 1e-8 && Math.abs(c) < 1e-8 && Math.abs(d - MAGIC_CARD_HEIGHT_POINTS) < 1e-8);
    const positionMatrix = getDrawMatrices(parsed.content).find(([a, b, c, d]) =>
      Math.abs(a - 1) < 1e-10 && Math.abs(b) < 1e-10 && Math.abs(c) < 1e-10 && Math.abs(d - 1) < 1e-10);

    expect(layout.slotPaths.map(({ state }) => state)).toEqual(["active", "skipped"]);
    expect(activeCut.id).toBe("card-a");
    expect(activeCut.boundsMm).toEqual(layout.placement.slots[0]!.trim);
    expect(activeCut.boundsMm).toEqual(fixture.expectedActiveTrimMm);
    expect(trimMatrix).toBeDefined();
    expect(positionMatrix).toBeDefined();
    expect(pointsToMm(positionMatrix![4]!)).toBeCloseTo(activeCut.boundsMm.xMm, 9);
    expect(297 - pointsToMm(positionMatrix![5]!) - pointsToMm(trimMatrix![3]!)).toBeCloseTo(activeCut.boundsMm.yMm, 9);
    expect(pointsToMm(trimMatrix![0]!)).toBeCloseTo(activeCut.boundsMm.widthMm, 9);
    expect(pointsToMm(trimMatrix![3]!)).toBeCloseTo(activeCut.boundsMm.heightMm, 9);
    expect(trimMatrix![0]).toBeCloseTo(fixture.expectedPdfImageMatrixPoints.a, 9);
    expect(trimMatrix![3]).toBeCloseTo(fixture.expectedPdfImageMatrixPoints.d, 9);
    expect(positionMatrix![4]).toBeCloseTo(fixture.expectedPdfImageMatrixPoints.e, 9);
    expect(positionMatrix![5]).toBeCloseTo(fixture.expectedPdfImageMatrixPoints.f, 9);
    expect(getVectorSegments(parsed.content).length).toBeGreaterThan(0);
    expect(parsed.document.getPages()[0]!.getMediaBox().width).toBeCloseTo(mmToPoints(210), 10);
  });

  it("exports images at exact template slot coordinates while omitting the template's skipped slot", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const templateGeometry = {
      orientation: "landscape" as const,
      cardOrientation: "portrait" as const,
      pageSizeMm: { widthMm: 297, heightMm: 210 },
      cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      rows: 1,
      columns: 3,
      slots: [
        { index: 0, row: 0, column: 0, xMm: 10, yMm: 10 },
        { index: 1, row: 0, column: 1, xMm: 80, yMm: 10 },
        { index: 2, row: 0, column: 2, xMm: 150, yMm: 10 },
      ],
    };
    const layout = calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      count: 2,
      bleedMm: 0,
      skippedSlotIndices: [1],
      pageOrientation: "landscape",
      templateGeometry,
    });
    const parsed = await parsePdf(await engine.generate({
      images: [jpeg, jpeg],
      pageOrientation: "landscape",
      skippedSlotIndices: [1],
      templateGeometry,
      registration: { type: "none", orientation: "portrait" },
    }));
    const cardMatrices = getDrawMatrices(parsed.content).filter(([a, b, c, d]) =>
      Math.abs(a - MAGIC_CARD_WIDTH_POINTS) < 1e-8 && Math.abs(b) < 1e-8 && Math.abs(c) < 1e-8 && Math.abs(d - MAGIC_CARD_HEIGHT_POINTS) < 1e-8);
    const positionMatrices = getDrawMatrices(parsed.content).filter(([a, b, c, d, x]) =>
      Math.abs(a - 1) < 1e-10 && Math.abs(b) < 1e-10 && Math.abs(c) < 1e-10 && Math.abs(d - 1) < 1e-10 && Math.abs(x) > 1e-10);
    const actualX = positionMatrices.map(([, , , , x]) => pointsToMm(x)).sort((a, b) => a - b);

    expect(parsed.document.getPages()[0]!.getMediaBox()).toEqual({ x: 0, y: 0, width: mmToPoints(297), height: mmToPoints(210) });
    expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(1);
    expect(cardMatrices).toHaveLength(2);
    expect(positionMatrices).toHaveLength(2);
    expect(actualX).toEqual(layout.slots.map(({ trim }) => trim.xMm).sort((a, b) => a - b));
    expect(actualX).not.toContain(templateGeometry.slots[1]!.xMm);
  });

  it("applies page margins and per-axis gaps in vector positions while preserving trim size", async () => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const marginsMm = { top: 10, right: 5, bottom: 15, left: 20 };
    const layout = calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      count: 2,
      bleedMm: 0,
      rows: 1,
      columns: 2,
      marginsMm,
      horizontalGapMm: 10,
      verticalGapMm: 6,
    });
    const parsed = await parsePdf(await engine.generate({
      images: [jpeg, jpeg],
      layoutRows: 1,
      layoutColumns: 2,
      marginsMm,
      horizontalGapMm: 10,
      verticalGapMm: 6,
      registration: { type: "none", orientation: "portrait" },
    }));
    const positions = getDrawMatrices(parsed.content).filter(([a, b, c, d, e, f]) =>
      Math.abs(a - 1) < 1e-10 && Math.abs(b) < 1e-10 && Math.abs(c) < 1e-10
      && Math.abs(d - 1) < 1e-10 && (Math.abs(e) > 1e-10 || Math.abs(f) > 1e-10));
    const actualPositions = positions.map(([, , , , x, y]) => [pointsToMm(x), pointsToMm(y)])
      .sort(([leftX, leftY], [rightX, rightY]) => leftX - rightX || leftY - rightY);
    const expectedPositions = layout.slots.map(({ trim }) => [trim.xMm, 297 - trim.yMm - trim.heightMm])
      .sort(([leftX, leftY], [rightX, rightY]) => leftX - rightX || leftY - rightY);

    actualPositions.forEach((position, index) => {
      expect(position[0]).toBeCloseTo(expectedPositions[index]![0]!, 10);
      expect(position[1]).toBeCloseTo(expectedPositions[index]![1]!, 10);
    });
    expect(actualPositions[1]![0] - actualPositions[0]![0] - 63.5).toBeCloseTo(10, 10);
    expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(1);
    assertMatrixContainsSize(parsed.content, MAGIC_CARD_WIDTH_POINTS, MAGIC_CARD_HEIGHT_POINTS);
  });

  it.each([
    ["four-point", { type: "four-point", orientation: "portrait", insetXMm: 10, insetYMm: 10, armLengthMm: 5, lineThicknessMm: 1, squareSizeMm: 5, reservedZoneClearanceMm: 0 }, 8],
    ["custom", { type: "custom", orientation: "portrait", marks: [[{ type: "line", x1Mm: 20, y1Mm: 20, x2Mm: 30, y2Mm: 20, strokeWidthMm: 0.5 }]], reservedZones: [] }, 1],
  ] as const)("draws %s registration primitives as PDF vectors", async (_type, registration, expectedSegments) => {
    const jpeg = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const parsed = await parsePdf(await engine.generate({ images: [jpeg], registration }));

    expect(getVectorSegments(parsed.content)).toHaveLength(expectedSegments);
    expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(1);
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
    const canonicalTrim = singleCardTrim(0.625);
    const trimX = mmToPoints(canonicalTrim.xMm);
    const trimTop = canonicalTrim.yMm;
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

  it("rotates bleed derivatives with the landscape card while keeping the original JPEG XObject", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });
    const parsed = await parsePdf(await engine.generate({
      images: [original],
      bleedResults: [bleed],
      cardOrientation: "landscape",
    }));
    const placement = calculateGridPagePlacements({
      placement: {
        paper: PAPER_FORMATS.A4,
        card: MAGIC_STANDARD_CARD,
        pageOrientation: "portrait",
        cardOrientation: "landscape",
        bleedMm: 0,
        reservedZonesMm: [],
      },
      count: 1,
      bleedByCardMm: [0.625],
    })[0]!.placement;
    const trim = placement.slots[0]!.trim;
    const sourceWidth = mmToPoints(MAGIC_STANDARD_CARD.widthMm);
    const sourceHeight = mmToPoints(MAGIC_STANDARD_CARD.heightMm);
    const expectedRotation = [
      0,
      -1,
      1,
      0,
      mmToPoints(trim.xMm),
      mmToPoints(297 - trim.yMm - placement.cardSizeMm.heightMm) + sourceWidth,
    ];

    expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(1);
    expect(getDrawMatrices(parsed.content).some((matrix) =>
      matrix.every((value, index) => Math.abs(value - expectedRotation[index]!) < 1e-8),
    )).toBe(true);
    expect(placement.cardSizeMm).toEqual({ widthMm: 88.9, heightMm: 63.5 });
    expect(sourceWidth).toBe(MAGIC_CARD_WIDTH_POINTS);
    expect(sourceHeight).toBeCloseTo(MAGIC_CARD_HEIGHT_POINTS, 10);
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
        trim: { enabled: true, extentMm: "full", color: "blue" },
        external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
      },
    });
    const parsed = await parsePdf(pdf);
    const draws = getImageDrawsWithClips(parsed.content);
    const trimWidth = mmToPoints(63.5);
    const trimHeight = mmToPoints(88.9);
    const canonicalTrim = singleCardTrim(bleedMm);
    const trimX = mmToPoints(canonicalTrim.xMm);
    const trimTop = canonicalTrim.yMm;
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
      trim: { enabled: true, extentMm: "full", color: "blue" },
      external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
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
      expect.closeTo(0x1e / 255, 8),
      expect.closeTo(0x88 / 255, 8),
      expect.closeTo(0xe5 / 255, 8),
    ]);
    expect(guidedPdf.content.lastIndexOf("\nS")).toBeGreaterThan(guidedPdf.content.lastIndexOf(" Do"));

    const fullLines = getVectorSegments(guidedPdf.content);
    const trimWidthPoints = mmToPoints(63.5);
    const trimHeightPoints = mmToPoints(88.9);
    const canonicalTrim = singleCardTrim();
    expect(fullLines).toContainEqual([
      expect.closeTo(mmToPoints(canonicalTrim.xMm), 7),
      expect.closeTo(mmToPoints(297 - canonicalTrim.yMm - canonicalTrim.heightMm), 7),
      expect.closeTo(mmToPoints(canonicalTrim.xMm + canonicalTrim.widthMm), 7),
      expect.closeTo(mmToPoints(297 - canonicalTrim.yMm - canonicalTrim.heightMm), 7),
    ]);
    expect(trimWidthPoints).toBe(180);
    expect(trimHeightPoints).toBeCloseTo(252, 10);
  });

  it("draws each selected guide color as PDF RGB without changing image objects or segment arrays", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const cleanPdf = await parsePdf(await engine.generate({ images: [original] }));
    const imageHashes = cleanPdf.images.map((image) => createHash("sha256").update(getPdfStreamBytes(image)).digest("hex"));
    const palette = [
      ["red", [0xe5 / 255, 0x39 / 255, 0x35 / 255]],
      ["pink", [0xec / 255, 0x40 / 255, 0x7a / 255]],
      ["green", [0x43 / 255, 0xa0 / 255, 0x47 / 255]],
      ["blue", [0x1e / 255, 0x88 / 255, 0xe5 / 255]],
      ["black", [0, 0, 0]],
      ["white", [1, 1, 1]],
    ] as const satisfies readonly (readonly [GuideColor, readonly [number, number, number]])[];
    let referenceTrimSegments: number[][] | undefined;
    let referenceExternalSegments: number[][] | undefined;

    for (const [color, rgb] of palette) {
      for (const guideKind of ["trim", "external"] as const) {
        const config: CutGuideConfig = {
          trim: { enabled: guideKind === "trim", extentMm: "full", color: guideKind === "trim" ? color : "blue" },
          external: { enabled: guideKind === "external", strokeWidthPt: 0.3, color: guideKind === "external" ? color : "black" },
        };
        const pdf = await parsePdf(await engine.generate({ images: [original], cutGuides: config }));
        const rgbOperators = [...pdf.content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) RG\b/g)]
          .map((match) => match.slice(1).map(Number));
        const segments = getVectorSegments(pdf.content);

        expect(pdf.images).toHaveLength(cleanPdf.images.length);
        expect(pdf.images.map((image) => createHash("sha256").update(getPdfStreamBytes(image)).digest("hex"))).toEqual(imageHashes);
        expect(rgbOperators).toEqual([rgb.map((component) => expect.closeTo(component, 8))]);
        if (guideKind === "external" && color === "black") expect(pdf.content).toContain("0 0 0 RG");
        if (guideKind === "external" && color === "white") expect(pdf.content).toContain("1 1 1 RG");
        if (guideKind === "trim") {
          referenceTrimSegments ??= segments;
          expect(segments).toEqual(referenceTrimSegments);
        } else {
          referenceExternalSegments ??= segments;
          expect(segments).toEqual(referenceExternalSegments);
        }
      }
    }
  });

  it("serializes colorless legacy guide configs with independent default colors", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const legacyConfig = {
      trim: { enabled: true, extentMm: "full" },
      external: { enabled: true, strokeWidthPt: 0.3 },
    } as unknown as CutGuideConfig;
    const defaultedConfig: CutGuideConfig = {
      trim: { enabled: true, extentMm: "full", color: "blue" },
      external: { enabled: true, strokeWidthPt: 0.3, color: "black" },
    };
    const legacyPdf = await parsePdf(await engine.generate({ images: [original], cutGuides: legacyConfig }));
    const defaultedPdf = await parsePdf(await engine.generate({ images: [original], cutGuides: defaultedConfig }));
    const strokeColors = (content: string) => [...content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) RG\b/g)]
      .map((match) => match.slice(1).map(Number));
    const imageHashes = (pdf: ParsedPdf) => pdf.images
      .map((image) => createHash("sha256").update(getPdfStreamBytes(image)).digest("hex"));

    expect(strokeColors(legacyPdf.content)).toEqual(strokeColors(defaultedPdf.content));
    expect(legacyPdf.content).toContain("0 0 0 RG");
    expect(getVectorSegments(legacyPdf.content)).toEqual(getVectorSegments(defaultedPdf.content));
    expect(legacyPdf.images).toHaveLength(defaultedPdf.images.length);
    expect(imageHashes(legacyPdf)).toEqual(imageHashes(defaultedPdf));
  });

  it("serializes independent trim pink and external black, and trim green and external blue", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    let referenceSegments: number[][] | undefined;
    let referenceImageHashes: string[] | undefined;

    for (const { trimColor, externalColor, expected } of [
      { trimColor: "pink", externalColor: "black", expected: [[0xec / 255, 0x40 / 255, 0x7a / 255], [0, 0, 0]] },
      { trimColor: "green", externalColor: "blue", expected: [[0x43 / 255, 0xa0 / 255, 0x47 / 255], [0x1e / 255, 0x88 / 255, 0xe5 / 255]] },
    ] as const satisfies readonly { trimColor: GuideColor; externalColor: GuideColor; expected: readonly (readonly number[])[] }[]) {
      const config: CutGuideConfig = {
        trim: { enabled: true, extentMm: 1, color: trimColor },
        external: { enabled: true, strokeWidthPt: 0.3, color: externalColor },
      };
      const pdf = await parsePdf(await engine.generate({
        images: [original],
        marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
        cutGuides: config,
      }));
      const rgbOperators = [...pdf.content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) RG\b/g)]
        .map((match) => match.slice(1).map(Number));
      const segments = getVectorSegments(pdf.content);
      const imageHashes = pdf.images.map((image) => createHash("sha256").update(getPdfStreamBytes(image)).digest("hex"));

      expect(rgbOperators).toHaveLength(2);
      expect(rgbOperators[0]).toEqual(expected[0].map((component) => expect.closeTo(component, 8)));
      expect(rgbOperators[1]).toEqual(expected[1].map((component) => expect.closeTo(component, 8)));
      expect(segments).toHaveLength(16);
      expect(segments).toEqual(referenceSegments ?? segments);
      expect(imageHashes).toEqual(referenceImageHashes ?? imageHashes);
      referenceSegments ??= segments;
      referenceImageHashes ??= imageHashes;
    }
  });

  it("serializes 1 mm trim corner segments at exact physical trim coordinates", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const pdf = await engine.generate({
      images: [original],
      cutGuides: {
        trim: { enabled: true, extentMm: 1, color: "blue" },
        external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
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
    const canonicalTrim = singleCardTrim();
    const left = canonicalTrim.xMm;
    const right = canonicalTrim.xMm + canonicalTrim.widthMm;
    const top = canonicalTrim.yMm;
    const bottom = canonicalTrim.yMm + canonicalTrim.heightMm;
    const expectedSegments = [
      [left, top, left + 1, top],
      [right - 1, top, right, top],
      [left, bottom, left + 1, bottom],
      [right - 1, bottom, right, bottom],
      [left, top, left, top + 1],
      [right, top, right, top + 1],
      [left, bottom - 1, left, bottom],
      [right, bottom - 1, right, bottom],
    ].map((segment) => segment.map((coordinate) => Number(coordinate.toFixed(8))))
      .sort((a, b) => a.join(",").localeCompare(b.join(",")));

    expect(segments).toHaveLength(8);
    expect(horizontal).toHaveLength(4);
    expect(vertical).toHaveLength(4);
    expect(new Set(actualSegments.map((segment) => segment.join(","))).size).toBe(8);
    expect(actualSegments).toEqual(expectedSegments);
    for (const { x1Mm, y1Mm, x2Mm, y2Mm } of segments) {
      expect(Math.hypot(x2Mm - x1Mm, y2Mm - y1Mm)).toBeCloseTo(1, 8);
    }
    for (const { x1Mm, y1Mm, x2Mm } of horizontal) {
      expect([top, bottom].some((edge) => Math.abs(y1Mm - edge) < 1e-8)).toBe(true);
      const start = Math.min(x1Mm, x2Mm);
      const end = Math.max(x1Mm, x2Mm);
      expect(
        (Math.abs(start - left) < 1e-8 && Math.abs(end - left - 1) < 1e-8)
        || (Math.abs(start - right + 1) < 1e-8 && Math.abs(end - right) < 1e-8),
      ).toBe(true);
    }
    for (const { x1Mm, y1Mm, y2Mm } of vertical) {
      expect([left, right].some((edge) => Math.abs(x1Mm - edge) < 1e-8)).toBe(true);
      const start = Math.min(y1Mm, y2Mm);
      const end = Math.max(y1Mm, y2Mm);
      expect(
        (Math.abs(start - top) < 1e-8 && Math.abs(end - top - 1) < 1e-8)
        || (Math.abs(start - bottom + 1) < 1e-8 && Math.abs(end - bottom) < 1e-8),
      ).toBe(true);
    }
  });

  it.each([
    ["both OFF", { trim: { enabled: false, extentMm: 1, color: "blue" }, external: { enabled: false, strokeWidthPt: 0.3, color: "black" } }, 0],
    ["trim only", { trim: { enabled: true, extentMm: "full", color: "blue" }, external: { enabled: false, strokeWidthPt: 0.3, color: "black" } }, 4],
    ["external only", { trim: { enabled: false, extentMm: 1, color: "blue" }, external: { enabled: true, strokeWidthPt: 0.3, color: "black" } }, 8],
    ["both ON", { trim: { enabled: true, extentMm: 1, color: "blue" }, external: { enabled: true, strokeWidthPt: 0.3, color: "black" } }, 16],
  ] as const)("keeps %s vector-only and independent of image objects", async (_mode, config, segmentCount) => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const clean = await engine.generate({ images: [original] });
    const guided = await engine.generate({ images: [original], marginsMm: { top: 10, right: 10, bottom: 10, left: 10 }, cutGuides: config });
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
      marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
      cutGuides: {
        trim: { enabled: false, extentMm: 1, color: "blue" },
        external: { enabled: true, strokeWidthPt: 0.3, color: "black" },
      },
    });
    const parsed = await parsePdf(pdf);
    const lines = getVectorSegments(parsed.content);
    const radiusMm = 0.3 * 25.4 / 72 / 2;
    const canonicalTrim = singleCardTrim(0.625, undefined, { top: 10, right: 10, bottom: 10, left: 10 });
    const trimX = canonicalTrim.xMm;
    const trimTop = canonicalTrim.yMm;
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
      0,
      0,
      0,
    ]);
  });

  it("keeps external guide geometry unchanged when rounded-corner rendering is toggled", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const withoutRoundedCorners = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });
    const withRoundedCorners = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625, roundedCorners: true });
    const config: CutGuideConfig = {
      trim: { enabled: true, extentMm: 1, color: "blue" },
      external: { enabled: true, strokeWidthPt: 0.3, color: "black" },
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
        trim: { enabled: true, extentMm: "full", color: "blue" },
        external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
      },
    });
    const parsed = await parsePdf(pdf);
    const guides = getVectorSegments(parsed.content);

    expect(guides).toHaveLength(4);
    const canonicalTrim = singleCardTrim(bleedMm);
    const x1 = mmToPoints(canonicalTrim.xMm);
    const x2 = mmToPoints(canonicalTrim.xMm + canonicalTrim.widthMm);
    const y1 = mmToPoints(297 - canonicalTrim.yMm - canonicalTrim.heightMm);
    const y2 = mmToPoints(297 - canonicalTrim.yMm);
    expect(guides.map((segment) => segment.map((coordinate) => Number(coordinate.toFixed(8))))).toEqual([
      [x1, y2, x2, y2], [x1, y1, x2, y1], [x1, y2, x1, y1], [x2, y2, x2, y1],
    ].map((segment) => segment.map((coordinate) => Number(coordinate.toFixed(8)))));
    expect(pointsToMm(guides[0][2] - guides[0][0])).toBeCloseTo(63.5, 10);
    expect(Math.abs(pointsToMm(guides[1][1] - guides[0][1]))).toBeCloseTo(88.9, 12);
  });

  it("places nine bleed-bearing cards on A4 without overlapping derivative slots", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 0.625 });
    const pdf = await engine.generate({
      images: Array.from({ length: 9 }, () => original),
      bleedResults: Array.from({ length: 9 }, () => bleed),
      cutGuides: {
        trim: { enabled: false, extentMm: 1, color: "blue" },
        external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
      },
    });
    const parsed = await parsePdf(pdf);
    const imageDraws = getImageDrawsWithClips(parsed.content);

    expect(parsed.document.getPages()).toHaveLength(1);
    expect(parsed.images).toHaveLength(2);
    expect(getVectorSegments(parsed.content)).toHaveLength(0);
    expect(imageDraws).toHaveLength(45);
    const actualClips = new Set(imageDraws.filter((draw) => draw.clip).map((draw) => {
      const clip = draw.clip!;
      return [clip.x, clip.y, clip.width, clip.height].map((value) => pointsToMm(value).toFixed(7)).join(",");
    }));
    const requestedBleedPoints = mmToPoints(0.625);
    const trimWidthPoints = mmToPoints(63.5);
    const trimHeightPoints = mmToPoints(88.9);
    const pagePlacement = calculateGridPagePlacements({
      placement: { paper: PAPER_FORMATS.A4, pageOrientation: "portrait", card: MAGIC_STANDARD_CARD, bleedMm: 0 },
      count: 9,
      bleedByCardMm: Array.from({ length: 9 }, () => 0.625),
    })[0]!;
    const expectedClips = new Set<string>();
    for (const { trim } of pagePlacement.placement.slots) {
      const trimXPoints = mmToPoints(trim.xMm);
      const trimYPoints = mmToPoints(297 - trim.yMm - trim.heightMm);
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
    const cutGuides = {
      trim: { enabled: false, extentMm: 1 as const, color: "blue" as const },
      external: { enabled: true, strokeWidthPt, color: "black" as const },
    };
    const pdf = await engine.generate({
      images: Array.from({ length: 9 }, () => original),
      bleedResults: [bleed, ...Array.from({ length: 8 }, () => undefined)],
      paperFormat,
      cutGuides,
    });
    const parsed = await parsePdf(pdf);

    expect(parsed.document.getPages()).toHaveLength(1);
    expect(parsed.images).toHaveLength(2);
    const guides = getVectorSegments(parsed.content);
    expect(guides.length).toBeGreaterThan(10);
    const plan = buildCanonicalPrintPlan(9, {
      bleedMm: 0,
      paperFormat,
      pageOrientation: "portrait",
      cardFormat: MAGIC_STANDARD_CARD,
      bleedByCardMm,
    });
    const placement = plan.pages[0]!.placement;
    const cards = placement.slots.map((slot, index) => ({ trim: slot.trim, bleedMm: bleedByCardMm[index] }));
    const expectedGeometry = new CutGuideEngine().generate({ cards, pageSizeMm: placement.pageSizeMm, config: cutGuides });
    const normalize = (values: readonly number[]) => values.map((value) => Number(value.toFixed(8)));
    const expectedSegments = expectedGeometry.externalSegments
      .map(({ x1Mm, y1Mm, x2Mm, y2Mm }) => normalize([x1Mm, paperFormat.heightMm - y1Mm, x2Mm, paperFormat.heightMm - y2Mm]))
      .sort((left, right) => left.join(",").localeCompare(right.join(",")));
    const actualSegments = guides
      .map(([x1, y1, x2, y2]) => normalize([pointsToMm(x1), pointsToMm(y1), pointsToMm(x2), pointsToMm(y2)]))
      .sort((left, right) => left.join(",").localeCompare(right.join(",")));
    expect(actualSegments).toEqual(expectedSegments);
    expect(/([\d.]+) w\b/.exec(parsed.content)?.[1]).toBe(String(strokeWidthPt));
    expectExternalPdfSegmentsClear(guides, cards, paperFormat.heightMm, strokeWidthPt);
  });

  it("keeps mixed-bleed Letter export on one page when a registration zone misses every card", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({ imageBytes: original, bleedMm: 3 });
    const paperFormat = { name: "Letter", widthMm: 215.9, heightMm: 279.4 } as const;
    const pdf = await engine.generate({
      images: Array.from({ length: 9 }, () => original),
      bleedResults: [bleed, ...Array.from({ length: 8 }, () => undefined)],
      paperFormat,
      registration: {
        type: "custom",
        orientation: "portrait",
        marks: [[{ type: "line", x1Mm: 205, y1Mm: 275, x2Mm: 207, y2Mm: 275, strokeWidthMm: 0.2 }]],
        reservedZones: [{ xMm: 205, yMm: 275, widthMm: 2, heightMm: 2 }],
      },
    });
    const parsed = await parsePdf(pdf);

    expect(parsed.document.getPages()).toHaveLength(1);
    expect(parsed.document.getPages()[0]!.getMediaBox().width).toBeCloseTo(mmToPoints(215.9), 8);
    expect(parsed.document.getPages()[0]!.getMediaBox().height).toBeCloseTo(mmToPoints(279.4), 8);
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

  it("shares one exact JPEG image resource across 500 physical placements", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const embedJpg = vi.spyOn(PDFDocument.prototype, "embedJpg");
    try {
      const pdfBytes = await engine.generate({ images: Array.from({ length: 500 }, () => original) });
      const parsed = await parsePdf(pdfBytes);
      const jpegImages = parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"));

      expect(embedJpg).toHaveBeenCalledTimes(1);
      expect(jpegImages).toHaveLength(1);
      expect(getImageDrawsWithClips(parsed.content)).toHaveLength(500);
      expect(getPdfStreamBytes(jpegImages[0]!)).toEqual(Buffer.from(original));
      expect(readPdfRasterCacheDiagnostics(pdfBytes)).toMatchObject({
        rasterEmbeds: 1,
        cacheLookups: 500,
        cacheHits: 499,
        cacheMisses: 1,
        cacheEntries: 1,
        snapshotBytes: original.byteLength,
      });
    } finally {
      embedJpg.mockRestore();
    }
  });

  it("keeps distinct JPEG byte streams in distinct PDF image resources", async () => {
    const first = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const second = new Uint8Array(await sharp({
      create: { width: 8, height: 6, channels: 3, background: { r: 28, g: 160, b: 91 } },
    }).jpeg({ quality: 93 }).toBuffer());
    const embedJpg = vi.spyOn(PDFDocument.prototype, "embedJpg");
    try {
      const pdfBytes = await engine.generate({ images: [first, second] });
      const parsed = await parsePdf(pdfBytes);

      expect(embedJpg).toHaveBeenCalledTimes(2);
      expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(2);
      expect(getImageDrawsWithClips(parsed.content)).toHaveLength(2);
      expect(countRasterReuseOccurrences([
        { bytes: first, sha256: createHash("sha256").update(first).digest("hex") },
        { bytes: second, sha256: createHash("sha256").update(second).digest("hex") },
      ])).toEqual([1, 1]);
      expect(readPdfRasterCacheDiagnostics(pdfBytes)).toMatchObject({
        rasterEmbeds: 2,
        cacheLookups: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheEntries: 0,
        snapshotBytes: 0,
      });
    } finally {
      embedJpg.mockRestore();
    }
  });

  it("confirms byte equality when a supplied SHA-256 key collides", async () => {
    const first = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const second = first.slice();
    second[7] = second[7] === 1 ? 2 : second[7]! - 1;
    const collidingDigest = "a".repeat(64);
    const pdfBytes = await engine.generate({
      images: [first, second],
      imageSha256: [collidingDigest, collidingDigest],
    });
    const parsed = await parsePdf(pdfBytes);
    const jpegImages = parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"));

    expect(second).toHaveLength(first.length);
    expect(jpegImages).toHaveLength(2);
    expect(getPdfStreamBytes(jpegImages[0]!)).toEqual(Buffer.from(first));
    expect(getPdfStreamBytes(jpegImages[1]!)).toEqual(Buffer.from(second));
    expect(countRasterReuseOccurrences([
      { bytes: first, sha256: collidingDigest },
      { bytes: second, sha256: collidingDigest },
    ])).toEqual([1, 1]);
    expect(readPdfRasterCacheDiagnostics(pdfBytes)).toMatchObject({ cacheEntries: 0, snapshotBytes: 0 });
  });

  it("compares reused resources with the embedded byte snapshot if caller input mutates", async () => {
    const first = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const firstBytes = first.slice();
    const originalEmbedJpg = PDFDocument.prototype.embedJpg;
    let changed = false;
    const embedJpg = vi.spyOn(PDFDocument.prototype, "embedJpg").mockImplementation(async function (
      this: PDFDocument,
      bytes: string | Uint8Array | ArrayBuffer,
    ) {
      const image = await originalEmbedJpg.call(this, bytes);
      if (!changed) {
        changed = true;
        first[7] = first[7] === 1 ? 2 : first[7]! - 1;
      }
      return image;
    });
    try {
      const forcedDigest = "b".repeat(64);
      const pdfBytes = await engine.generate({
        images: [first, first],
        imageSha256: [forcedDigest, forcedDigest],
      });
      const parsed = await parsePdf(pdfBytes);
      const jpegImages = parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"));

      expect(embedJpg).toHaveBeenCalledTimes(2);
      expect(jpegImages).toHaveLength(2);
      expect(getPdfStreamBytes(jpegImages[0]!)).toEqual(Buffer.from(firstBytes));
      expect(getPdfStreamBytes(jpegImages[1]!)).toEqual(Buffer.from(first));
      expect(readPdfRasterCacheDiagnostics(pdfBytes)).toMatchObject({ cacheHits: 0, cacheMisses: 2, cacheEntries: 2 });
    } finally {
      embedJpg.mockRestore();
    }
  });

  it("shares 16-bit PNG color and alpha resources without reducing precision", async () => {
    const png16 = new Uint8Array(await readFile(join(FIXTURES, "synthetic-rgba16.png")));
    const pdfBytes = await engine.generate({ images: [png16, png16] });
    const parsed = await parsePdf(pdfBytes);
    const colorImages = parsed.images.filter((image) => image.dictionary.includes("/SMask"));
    const alphaImages = parsed.images.filter((image) => image.dictionary.includes("/BitsPerComponent 16")
      && image.dictionary.includes("/DeviceGray")
      && !image.dictionary.includes("/SMask"));

    expect(colorImages).toHaveLength(1);
    expect(alphaImages).toHaveLength(1);
    expect(getImageDrawsWithClips(parsed.content)).toHaveLength(2);
    expect(colorImages[0]!.dictionary).toContain("/BitsPerComponent 16");
    expect(inflateSync(getPdfStreamBytes(colorImages[0]!))).toEqual(Buffer.from([
      0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
      0x12, 0xff, 0x56, 0xff, 0x9a, 0xff,
    ]));
    expect(inflateSync(getPdfStreamBytes(alphaImages[0]!))).toEqual(Buffer.from([0x00, 0xaa, 0xff, 0x01]));
    expect(readPdfRasterCacheDiagnostics(pdfBytes)).toMatchObject({
      cacheLookups: 2,
      cacheHits: 1,
      cacheMisses: 1,
      cacheEntries: 1,
      snapshotBytes: png16.byteLength,
    });
  });

  it("shares repeated lossless bleed resources while retaining every clipped draw", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const bleed = await new BleedEngine().generate({
      imageBytes: original,
      bleedMm: 0.625,
      trimSizeMm: MAGIC_STANDARD_CARD,
    });
    if (bleed.status !== "derived") throw new Error("The bleed fixture must produce a derivative.");
    const equalBleedCopy = {
      ...bleed,
      preview: { ...bleed.preview, bytes: bleed.preview.bytes.slice() },
    };
    const pdfBytes = await engine.generate({
      images: [original, original],
      bleedResults: [bleed, equalBleedCopy],
    });
    const parsed = await parsePdf(pdfBytes);

    expect(parsed.images.filter((image) => image.dictionary.includes("/DCTDecode"))).toHaveLength(1);
    expect(parsed.images.filter((image) => image.dictionary.includes("/FlateDecode"))).toHaveLength(1);
    expect(getImageDrawsWithClips(parsed.content)).toHaveLength(10);
    expect(getImageDrawsWithClips(parsed.content).filter((draw) => draw.clip)).toHaveLength(8);
    expect(countRasterReuseOccurrences([bleed.preview.bytes, bleed.preview.bytes].map((bytes) => ({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })))).toEqual([2, 2]);
    expect(readPdfRasterCacheDiagnostics(pdfBytes)).toMatchObject({
      cacheHits: 2,
      cacheMisses: 2,
      cacheEntries: 2,
      snapshotBytes: original.byteLength + bleed.preview.bytes.byteLength,
    });
  });

  it("keeps unique bleed derivatives distinct and marks them non-cacheable", async () => {
    const first = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const second = new Uint8Array(await sharp({
      create: { width: 8, height: 6, channels: 3, background: { r: 165, g: 44, b: 137 } },
    }).jpeg({ quality: 91 }).toBuffer());
    const bleeds = await Promise.all([first, second].map((imageBytes) => new BleedEngine().generate({
      imageBytes,
      bleedMm: 0.625,
      trimSizeMm: MAGIC_STANDARD_CARD,
    })));
    const embedPng = vi.spyOn(PDFDocument.prototype, "embedPng");
    try {
      const pdfBytes = await engine.generate({
        images: [first, second],
        bleedResults: bleeds,
      });
      const parsed = await parsePdf(pdfBytes);
      const derivatives = parsed.images.filter((image) => image.dictionary.includes("/FlateDecode"));

      expect(embedPng).toHaveBeenCalledTimes(2);
      expect(derivatives).toHaveLength(2);
      expect(getImageDrawsWithClips(parsed.content)).toHaveLength(10);
      expect(countRasterReuseOccurrences(bleeds.map((bleed) => ({
        bytes: bleed.preview.bytes,
        sha256: createHash("sha256").update(bleed.preview.bytes).digest("hex"),
      })))).toEqual([1, 1]);
      expect(readPdfRasterCacheDiagnostics(pdfBytes)).toMatchObject({
        cacheLookups: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheEntries: 0,
        snapshotBytes: 0,
      });
    } finally {
      embedPng.mockRestore();
    }
  });

  it("applies one page-scoped calibration CTM to JPEG and registration vectors without changing paper boxes", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const calibration = parseSideCalibration({ offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1.00012, scaleY: 0.99987, skewXDeg: 0.2 });
    const expected = createPrintCalibrationTransform({ widthMm: 210, heightMm: 297 }, calibration, "back").matrix;
    const pdf = await engine.generate({
      images: [original],
      paperFormat: PAPER_FORMATS.A4,
      pageOrientation: "portrait",
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      registration: createDefaultRegistrationConfig("three-point", "portrait"),
      cutGuides: { trim: { enabled: true, extentMm: 1, color: "blue" }, external: { enabled: false, strokeWidthPt: 0.3, color: "black" } },
      printCalibration: calibration,
      calibrationSide: "back",
    });
    const parsed = await parsePdf(pdf);
    const matrix = getDrawMatrices(parsed.content).find(([a, b, c, d, e, f]) =>
      Math.abs(a - expected.a) < 1e-9 && Math.abs(b - expected.b) < 1e-9
      && Math.abs(c - expected.c) < 1e-9 && Math.abs(d - expected.d) < 1e-9
      && Math.abs(e - mmToPoints(expected.e)) < 1e-7 && Math.abs(f - mmToPoints(expected.f)) < 1e-7);
    const page = parsed.document.getPages()[0]!;
    const jpeg = parsed.images.find((image) => image.dictionary.includes("/DCTDecode"));

    expect(matrix).toBeDefined();
    expect(page.getMediaBox()).toEqual({ x: 0, y: 0, width: mmToPoints(210), height: mmToPoints(297) });
    expect(page.getCropBox()).toEqual({ x: 0, y: 0, width: mmToPoints(210), height: mmToPoints(297) });
    expect(jpeg).toBeDefined();
    expect(getPdfStreamBytes(jpeg!)).toEqual(Buffer.from(original));
    expect(getVectorSegments(parsed.content).length).toBeGreaterThan(0);
  });

  it("blocks calibrated card content from silently leaving a trim-sized printable page", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    await expect(engine.generate({
      images: [original],
      paperFormat: { name: "trim-sized", widthMm: 63.5, heightMm: 88.9 },
      cardFormat: MAGIC_STANDARD_CARD,
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      printCalibration: parseSideCalibration({ offsetXUm: 1_000, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 }),
    })).rejects.toMatchObject({ name: "CalibrationError", code: "CALIBRATED_CONTENT_OUT_OF_BOUNDS" });
  });

  it("blocks calibrated external cut guides that leave the page while cards and registration remain inside", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    await expect(engine.generate({
      images: [original],
      paperFormat: PAPER_FORMATS.A4,
      registration: { type: "none", orientation: "portrait" },
      cutGuides: {
        trim: { enabled: false, extentMm: 1, color: "blue" },
        external: { enabled: true, strokeWidthPt: 0.7, color: "black" },
      },
      printCalibration: parseSideCalibration({ offsetXUm: 1_000, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 }),
    })).rejects.toMatchObject({ name: "CalibrationError", code: "CALIBRATED_CONTENT_OUT_OF_BOUNDS" });
  });

  it("keeps cut guide vectors nominal for identity calibration", async () => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const cutGuides = {
      trim: { enabled: true, extentMm: 1, color: "blue" },
      external: { enabled: true, strokeWidthPt: 2, color: "black" },
    } as const;
    const nominal = await engine.generate({ images: [original], paperFormat: PAPER_FORMATS.A4, cutGuides });
    const calibrated = await engine.generate({
      images: [original], paperFormat: PAPER_FORMATS.A4, cutGuides,
      printCalibration: parseSideCalibration({ offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 }),
    });
    expect(getVectorSegments((await parsePdf(calibrated)).content)).toEqual(getVectorSegments((await parsePdf(nominal)).content));
  });

  it.each([10, 100])("applies the same back page matrix to every one of %i card pages without accumulation", async (count) => {
    const original = new Uint8Array(await readFile(join(FIXTURES, "synthetic-gradient.jpg")));
    const calibration = parseSideCalibration({ offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1.00012, scaleY: 0.99987 });
    const placements = calculateGridPagePlacements({
      placement: { paper: PAPER_FORMATS.A4, pageOrientation: "portrait", card: MAGIC_STANDARD_CARD, cardOrientation: "portrait", bleedMm: 0, marginsMm: { top: 10, right: 10, bottom: 10, left: 10 } },
      count,
    });
    const expected = createPrintCalibrationTransform({ widthMm: 210, heightMm: 297 }, calibration, "back").matrix;
    const pdf = await engine.generate({
      images: Array.from({ length: count }, () => original),
      pagePlacements: placements,
      printCalibration: calibration,
      calibrationSide: "back",
    });
    const parsed = await parsePdf(pdf);
    const matches = getDrawMatrices(parsed.content).filter(([a, b, c, d, e, f]) =>
      Math.abs(a - expected.a) < 1e-9 && Math.abs(b - expected.b) < 1e-9
      && Math.abs(c - expected.c) < 1e-9 && Math.abs(d - expected.d) < 1e-9
      && Math.abs(e - mmToPoints(expected.e)) < 1e-7 && Math.abs(f - mmToPoints(expected.f)) < 1e-7);

    expect(parsed.document.getPages()).toHaveLength(placements.length);
    expect(matches).toHaveLength(placements.length);
    for (const page of parsed.document.getPages()) {
      expect(page.getMediaBox()).toEqual({ x: 0, y: 0, width: mmToPoints(210), height: mmToPoints(297) });
    }
  }, 30_000);

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
    expect(parsed.images).toHaveLength(4);
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
    expect(parsed.images).toHaveLength(1);
    expect(parsed.content.match(/\s+Do\b/g)).toHaveLength(10);
  });

  it("shares each PDF page's exact trim placements with the corresponding cut page", async () => {
    const cardPath = join(FIXTURES, "synthetic-gradient.jpg");
    const image = new Uint8Array(await readFile(cardPath));
    const pdf = await engine.generate({ images: Array.from({ length: 10 }, () => image) });
    const parsed = await parsePdf(pdf);
    const settings = { ...DEFAULT_PROJECT_SETTINGS, bleedMm: 0 };
    const cutPages = resolveCutLayoutPages({ projectId: "pdf-cut-pages", projectRevision: 1, settings, cardCount: 10 });
    const sharedPlacements = buildCanonicalPrintPlan(10, {
      paperFormat: settings.paperFormat,
      cardFormat: settings.cardFormat,
      pageOrientation: settings.pageOrientation,
      cardOrientation: settings.cardOrientation,
      bleedMm: 0,
      marginsMm: settings.marginsMm,
      horizontalGapMm: settings.horizontalGapMm,
      verticalGapMm: settings.verticalGapMm,
      registration: settings.registration,
      duplexFlipMode: settings.duplexFlipMode,
    }).pages;

    expect(parsed.document.getPages()).toHaveLength(2);
    expect(cutPages).toHaveLength(2);
    expect(cutPages.map(({ startCardIndex, endCardIndex }) => [startCardIndex, endCardIndex])).toEqual(sharedPlacements.map(({ startCardIndex, endCardIndex }) => [startCardIndex, endCardIndex]));
    for (const [pageIndex, page] of cutPages.entries()) {
      const pdfPage = sharedPlacements[pageIndex]!;
      const expected = page.activeGeometry!.paths.map(({ boundsMm }) => boundsMm);
      const actual = pdfPage.placement.slots.map(({ trim }) => trim);
      expect(page.pageNumber).toBe(pageIndex + 1);
      expect(actual).toHaveLength(expected.length);
      for (const [slotIndex, trim] of expected.entries()) {
        expect(actual[slotIndex]!.xMm).toBeCloseTo(trim.xMm, 8);
        expect(actual[slotIndex]!.yMm).toBeCloseTo(trim.yMm, 8);
        expect(actual[slotIndex]!.widthMm).toBeCloseTo(trim.widthMm, 8);
        expect(actual[slotIndex]!.heightMm).toBeCloseTo(trim.heightMm, 8);
      }
    }
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
