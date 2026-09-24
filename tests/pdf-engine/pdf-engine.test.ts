import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import { describe, expect, it } from "vitest";
import { MAGIC_STANDARD_CARD, type CardFormat } from "../../core/geometry";
import { pointsToMm } from "../../core/units";
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
