import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { POST as previewPost } from "../../src/app/api/import/preview/route";
import { POST as pdfPost } from "../../src/app/api/import/pdf/route";
import { mmToPoints, pointsToMm } from "../../core/units";

const fixturePath = join(process.cwd(), "tests", "fixtures", "pdf");
const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140" viewBox="0 0 100 140"><rect width="100" height="140" fill="#123456"/></svg>');
const fullTrimGuides = JSON.stringify({
  trim: { enabled: true, extentMm: "full", color: "blue" },
  external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
});

interface PdfClipRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type PdfTransform = readonly [number, number, number, number, number, number];

interface PdfClipPath {
  readonly rectangles: readonly PdfClipRectangle[];
  readonly hasAdditionalGeometry: boolean;
  readonly matrices: readonly PdfTransform[];
  readonly scopeId: number;
}

interface PdfImageDraw {
  readonly resourceName: string;
  readonly clips: readonly PdfClipPath[];
  readonly matrices: readonly PdfTransform[];
  readonly scopeIds: readonly number[];
  readonly offset: number;
}

interface PdfVectorSegment {
  readonly coordinates: readonly number[];
  readonly strokeOffset: number;
}

async function postFile(route: typeof pdfPost, filename: string, bytes: Uint8Array, extras: Record<string, string> = {}): Promise<Response> {
  const form = new FormData();
  const ownedBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ownedBytes).set(bytes);
  form.set("image", new File([ownedBytes], filename));
  for (const [key, value] of Object.entries(extras)) form.set(key, value);
  return route(new Request("http://localhost/api/import/pdf", { method: "POST", body: form }));
}

async function imageStreams(pdfBytes: Uint8Array) {
  const pdf = await PDFDocument.load(pdfBytes);
  const images: Array<{ readonly raw: PDFRawStream; readonly dictionary: string; readonly reference: string }> = [];
  const content: Buffer[] = [];
  for (const [reference, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dictionary = object.dict.toString();
    if (object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image") images.push({ raw: object, dictionary, reference: reference.toString() });
    else if (object.dict.get(PDFName.of("Filter"))?.toString() === "/FlateDecode") {
      content.push(inflateSync(Buffer.from(object.contents)));
    }
  }
  return { pdf, images, rawContent: Buffer.concat(content).toString("latin1") };
}

function getImageDrawsWithClips(content: string): PdfImageDraw[] {
  const tokenMatches = [...content.matchAll(/\/[\w.-]+|[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?|[A-Za-z*]+/g)];
  const tokens = tokenMatches.map((match) => match[0]);
  const graphicsStack: Array<{
    readonly clips: readonly PdfClipPath[];
    readonly matrices: readonly PdfTransform[];
    readonly scopeIds: readonly number[];
  }> = [];
  const draws: PdfImageDraw[] = [];
  let activeClips: readonly PdfClipPath[] = [];
  let activeMatrices: readonly PdfTransform[] = [];
  let activeScopeIds: readonly number[] = [];
  let nextScopeId = 1;
  let pendingPath: PdfClipPath | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "q") {
      graphicsStack.push({ clips: activeClips, matrices: activeMatrices, scopeIds: activeScopeIds });
      activeScopeIds = [...activeScopeIds, nextScopeId];
      nextScopeId += 1;
    } else if (token === "Q") {
      const state = graphicsStack.pop();
      activeClips = state?.clips ?? [];
      activeMatrices = state?.matrices ?? [];
      activeScopeIds = state?.scopeIds ?? [];
      pendingPath = undefined;
    } else if (token === "re") {
      const operands = tokens.slice(index - 4, index).map(Number);
      if (operands.length === 4 && operands.every(Number.isFinite)) {
        const rectangle = { x: operands[0], y: operands[1], width: operands[2], height: operands[3] };
        pendingPath = pendingPath
          ? { ...pendingPath, rectangles: [...pendingPath.rectangles, rectangle] }
          : {
              rectangles: [rectangle],
              hasAdditionalGeometry: false,
              matrices: activeMatrices,
              scopeId: activeScopeIds.at(-1) ?? 0,
            };
      }
    } else if (token === "W" || token === "W*") {
      activeClips = [
        ...activeClips,
        pendingPath ?? {
          rectangles: [],
          hasAdditionalGeometry: false,
          matrices: activeMatrices,
          scopeId: activeScopeIds.at(-1) ?? 0,
        },
      ];
      pendingPath = undefined;
    } else if (["m", "l", "c", "v", "y", "h"].includes(token)) {
      pendingPath = pendingPath
        ? { ...pendingPath, hasAdditionalGeometry: true }
        : {
            rectangles: [],
            hasAdditionalGeometry: true,
            matrices: activeMatrices,
            scopeId: activeScopeIds.at(-1) ?? 0,
          };
    } else if (["n", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*"].includes(token)) {
      pendingPath = undefined;
    } else if (token === "cm") {
      const operands = tokens.slice(index - 6, index).map(Number);
      if (operands.length === 6 && operands.every(Number.isFinite)) {
        activeMatrices = [
          ...activeMatrices,
          [operands[0], operands[1], operands[2], operands[3], operands[4], operands[5]],
        ];
      }
    } else if (token === "Do") {
      const resourceName = tokens[index - 1]?.replace(/^\//, "");
      if (resourceName) {
        draws.push({
          resourceName,
          clips: activeClips,
          matrices: activeMatrices,
          scopeIds: activeScopeIds,
          offset: tokenMatches[index].index ?? 0,
        });
      }
    }
  }

  return draws;
}

function getImageResourceReference(pdf: PDFDocument, resourceName: string): string {
  const resources = pdf.getPages()[0].node.Resources();
  const xObjects = resources?.lookup(PDFName.of("XObject"), PDFDict);
  const reference = xObjects?.get(PDFName.of(resourceName));
  if (!reference) throw new Error(`PDF image resource /${resourceName} is missing.`);
  return reference.toString();
}

function getVectorSegments(content: string): PdfVectorSegment[] {
  const number = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[Ee][+-]?\\d+)?";
  const pattern = new RegExp(`(${number})\\s+(${number})\\s+m\\s+(${number})\\s+(${number})\\s+l\\s+S`, "g");
  return [...content.matchAll(pattern)].map((match) => ({
    coordinates: match.slice(1).map(Number),
    strokeOffset: (match.index ?? 0) + match[0].lastIndexOf("S"),
  }));
}

describe("PDF content inspection", () => {
  it("retains every rectangle subpath in a clipping path", () => {
    const [draw] = getImageDrawsWithClips("q 0 0 10 10 re 20 20 5 5 re W n /Im0 Do Q");

    expect(draw.clips[0]).toMatchObject({
      rectangles: [
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: 20, width: 5, height: 5 },
      ],
      hasAdditionalGeometry: false,
    });
  });

  it("flags non-rectangular geometry in a clipping path", () => {
    const [draw] = getImageDrawsWithClips("q 0 0 m 10 10 l 20 20 5 5 re W n /Im0 Do Q");

    expect(draw.clips[0]).toMatchObject({
      rectangles: [{ x: 20, y: 20, width: 5, height: 5 }],
      hasAdditionalGeometry: true,
    });
  });
});

describe("minimal import workbench API", () => {
  it("returns a serializable preview with detections, entries and reports", async () => {
    const form = new FormData();
    form.set("text", "Commander\n1 Sol Ring\nSideboard\n2 Island");
    const response = await previewPost(new Request("http://localhost/api/import/preview", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.report.summary).toMatchObject({ totalInputs: 1, deckEntries: 2 });
    expect(json.entries.map((entry: { cardHint?: { name?: string } }) => entry.cardHint?.name)).toEqual(["Sol Ring", "Island"]);
    expect(JSON.stringify(json)).not.toContain("originalBytes");
  });

  it("imports a pasted Scryfall URL through the existing preview input and redacts its query", async () => {
    const form = new FormData();
    form.set("text", "https://scryfall.com/card/m21/265/island?token=private#fragment");
    const response = await previewPost(new Request("http://localhost/api/import/preview", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.sources[0]).toMatchObject({
      kind: "url",
      adapterId: "scryfall",
      sourceUrl: "https://scryfall.com/card/m21/265/island?token=%5Bredacted%5D",
    });
    expect(json.entries[0]).toMatchObject({ kind: "deck-card", cardHint: { setCode: "m21", collectorNumber: "265" } });
    expect(JSON.stringify(json)).not.toContain("private");
    expect(JSON.stringify(json)).not.toContain("fragment");
  });

  it("isolates an unsupported site URL beside a valid uploaded decklist", async () => {
    const form = new FormData();
    form.set("text", "https://www.moxfield.com/decks/example");
    form.append("files", new File(["1 Sol Ring\n2 Island"], "valid.txt", { type: "text/plain" }));
    const response = await previewPost(new Request("http://localhost/api/import/preview", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.report.errors).toMatchObject([{ code: "URL_UNSUPPORTED" }]);
    expect(json.entries.map((entry: { cardHint?: { name?: string } }) => entry.cardHint?.name)).toEqual(["Sol Ring", "Island"]);
    expect(json.report.summary).toMatchObject({ totalInputs: 2, deckEntries: 2, errors: 1 });
  });

  it("passes uploaded Content-Type to the generic importer and source preview", async () => {
    const form = new FormData();
    form.append("files", new File(['{"cards":[{"name":"Sol Ring","quantity":1}]}'], "cards.bin", { type: "application/json" }));
    const response = await previewPost(new Request("http://localhost/api/import/preview", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.sources[0]).toMatchObject({ kind: "file", filename: "cards.bin", mediaType: "application/json" });
    expect(json.report.selectedImporters[0]).toMatchObject({ kind: "json" });
    expect(json.entries[0]).toMatchObject({ kind: "deck-card", cardHint: { name: "Sol Ring" } });
  });

  it("returns image metadata without echoing original upload bytes", async () => {
    const form = new FormData();
    const fileBuffer = new ArrayBuffer(svgBytes.byteLength);
    new Uint8Array(fileBuffer).set(svgBytes);
    form.append("files", new File([fileBuffer], "local-art.svg"));
    form.set("filePaths", JSON.stringify([""]));
    const response = await previewPost(new Request("http://localhost/api/import/preview", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(serialized).not.toContain("originalBytes");
    expect(JSON.parse(serialized).entries[0]).toMatchObject({ kind: "custom-card", asset: { originalFormat: "svg", widthPx: 100, heightPx: 140 } });
  });

  it("rejects unsafe or non-parallel folder paths in import preview", async () => {
    const form = new FormData();
    const fileBuffer = new ArrayBuffer(svgBytes.byteLength);
    new Uint8Array(fileBuffer).set(svgBytes);
    form.append("files", new File([fileBuffer], "Card-Front.svg"));
    form.set("filePaths", JSON.stringify(["Deck/../outside.svg"]));
    const unsafe = await previewPost(new Request("http://localhost/api/import/preview", { method: "POST", body: form }));
    expect(unsafe.status).toBe(400);
    expect(await unsafe.json()).toMatchObject({ code: "INVALID_SOURCE_PATH" });

    form.set("filePaths", JSON.stringify([]));
    const mismatched = await previewPost(new Request("http://localhost/api/import/preview", { method: "POST", body: form }));
    expect(mismatched.status).toBe(400);
    expect(await mismatched.json()).toMatchObject({ code: "INVALID_SOURCE_PATH" });
  });

  it("exports local PNG, JPEG and SVG through existing engines at A4 and Magic Standard trim", async () => {
    for (const [filename, bytes] of [
      ["sample.png", new Uint8Array(await readFile(join(fixturePath, "synthetic-rgb.png")))],
      ["sample.jpg", new Uint8Array(await readFile(join(fixturePath, "synthetic-gradient.jpg")))],
      ["sample.svg", svgBytes],
    ] as const) {
      const response = await postFile(pdfPost, filename, bytes, { bleedMm: "0", cutGuides: fullTrimGuides });
      expect(response.status, filename).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/pdf");
      const pdfBytes = new Uint8Array(await response.arrayBuffer());
      const parsed = await imageStreams(pdfBytes);
      const page = parsed.pdf.getPages()[0].getMediaBox();
      expect(pointsToMm(page.width)).toBeCloseTo(210, 8);
      expect(pointsToMm(page.height)).toBeCloseTo(297, 8);
      const matrices = parsed.rawContent.split(/\r?\n/)
        .filter((line) => line.trim().endsWith(" cm"))
        .map((line) => line.trim().replace(/\s+cm$/, "").split(/\s+/).map(Number));
      if (filename.endsWith(".svg")) {
        const segments = [...parsed.rawContent.matchAll(/([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+m\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+l\s+S/g)]
          .map((match) => match.slice(1).map(Number));
        expect(segments.some(([x1, y1, x2, y2]) => Math.abs(Math.abs(x2 - x1) - 180) < 1e-8 && y1 === y2), filename).toBe(true);
        expect(segments.some(([x1, y1, x2, y2]) => Math.abs(Math.abs(y2 - y1) - 252) < 1e-8 && x1 === x2), filename).toBe(true);
      } else {
        expect(matrices.some(([width, b, c, height]) => Math.abs(width - 180) < 1e-8 && Math.abs(b) < 1e-8 && Math.abs(c) < 1e-8 && Math.abs(height - 252) < 1e-8), filename).toBe(true);
      }
    }
  });

  it("keeps JPEG bytes as a DCT stream and puts bleed outside trim with vector cut guides", async () => {
    const jpeg = new Uint8Array(await readFile(join(fixturePath, "synthetic-gradient.jpg")));
    const response = await postFile(pdfPost, "source.jpg", jpeg, { bleedMm: "0.625", cutGuides: fullTrimGuides });
    expect(response.status).toBe(200);
    const parsed = await imageStreams(new Uint8Array(await response.arrayBuffer()));
    const dct = parsed.images.find((image) => image.dictionary.includes("/DCTDecode"));
    const bleedRaster = parsed.images.find((image) => image.dictionary.includes("/FlateDecode"));
    expect(dct).toBeDefined();
    expect(bleedRaster).toBeDefined();
    expect(Buffer.from(dct!.raw.contents)).toEqual(Buffer.from(jpeg));
    const imageDraws = getImageDrawsWithClips(parsed.rawContent);
    expect(imageDraws).toHaveLength(5);
    const bleedDraws = imageDraws.slice(0, 4);
    const trimDraw = imageDraws[4]!;
    expect(trimDraw.clips).toHaveLength(0);
    const bleedClips = bleedDraws.map((draw) => {
      expect(draw.clips).toHaveLength(1);
      const clip = draw.clips[0]!;
      expect(draw.scopeIds).toContain(clip.scopeId);
      expect(clip.rectangles).toHaveLength(1);
      expect(clip.hasAdditionalGeometry).toBe(false);
      expect(clip.matrices).toEqual([]);
      return clip;
    });
    expect(new Set(bleedClips.map((clip) => clip.scopeId)).size).toBe(4);
    const bleedResource = getImageResourceReference(parsed.pdf, bleedDraws[0].resourceName);
    expect(bleedDraws.every((draw) => getImageResourceReference(parsed.pdf, draw.resourceName) === bleedResource)).toBe(true);
    expect(bleedResource).toBe(bleedRaster!.reference);
    expect(getImageResourceReference(parsed.pdf, trimDraw.resourceName)).toBe(dct!.reference);

    const trimWidth = mmToPoints(63.5);
    const trimHeight = mmToPoints(88.9);
    // Count-independent canonical placement keeps a single card in the same
    // row-major physical slot used by full and partial sheets.
    const trimX = mmToPoints(0.625);
    const trimTop = 0.625;
    const trimY = mmToPoints(297 - trimTop - 88.9);
    const expectedTrimTransforms: readonly PdfTransform[] = [
      [1, 0, 0, 1, trimX, trimY],
      [1, 0, 0, 1, 0, 0],
      [trimWidth, 0, 0, trimHeight, 0, 0],
      [1, 0, 0, 1, 0, 0],
    ];
    expect(trimDraw.matrices.map((matrix) => matrix.map((coordinate) => Number(coordinate.toFixed(8)))))
      .toEqual(expectedTrimTransforms.map((matrix) => matrix.map((coordinate) => Number(coordinate.toFixed(8)))));

    const bleedPoints = mmToPoints(0.625);
    const expectedClips: readonly PdfClipRectangle[] = [
      { x: trimX - bleedPoints, y: trimY - bleedPoints, width: bleedPoints, height: trimHeight + 2 * bleedPoints },
      { x: trimX + trimWidth, y: trimY - bleedPoints, width: bleedPoints, height: trimHeight + 2 * bleedPoints },
      { x: trimX, y: trimY + trimHeight, width: trimWidth, height: bleedPoints },
      { x: trimX, y: trimY - bleedPoints, width: trimWidth, height: bleedPoints },
    ];
    for (const [index, expected] of expectedClips.entries()) {
      const actual = bleedClips[index].rectangles[0]!;
      expect(actual.x).toBeCloseTo(expected.x, 8);
      expect(actual.y).toBeCloseTo(expected.y, 8);
      expect(actual.width).toBeCloseTo(expected.width, 8);
      expect(actual.height).toBeCloseTo(expected.height, 8);
    }

    const guides = getVectorSegments(parsed.rawContent);
    expect(guides).toHaveLength(4);
    const trimBottom = trimY + trimHeight;
    const expectedGuides = [
      [trimX, trimBottom, trimX + trimWidth, trimBottom],
      [trimX, trimY, trimX + trimWidth, trimY],
      [trimX, trimBottom, trimX, trimY],
      [trimX + trimWidth, trimBottom, trimX + trimWidth, trimY],
    ];
    expect(guides.map(({ coordinates }) => coordinates.map((coordinate) => Number(coordinate.toFixed(8)))))
      .toEqual(expectedGuides.map((segment) => segment.map((coordinate) => Number(coordinate.toFixed(8)))));
    const lastImageDrawOffset = imageDraws.at(-1)!.offset;
    expect(guides.every((guide) => guide.strokeOffset > lastImageDrawOffset)).toBe(true);
  });

  it.each(["full", "none"])("rejects legacy cut guide form value %s", async (cutGuides) => {
    const png = new Uint8Array(await readFile(join(fixturePath, "synthetic-rgb.png")));
    const response = await postFile(pdfPost, "sample.png", png, { cutGuides });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_CUT_GUIDES", message: expect.stringMatching(/legacy/i) });
  });

  it("reports explicit export limits for WebP and TIFF and preserves SVG bleed limitations", async () => {
    const png = await readFile(join(fixturePath, "synthetic-rgb.png"));
    const webp = new Uint8Array(await sharp(png).webp().toBuffer());
    const tiff = new Uint8Array(await sharp(png).tiff().toBuffer());
    for (const [filename, bytes] of [["image.webp", webp], ["image.tiff", tiff]] as const) {
      const response = await postFile(pdfPost, filename, bytes, { bleedMm: "0" });
      expect(response.status, filename).toBe(415);
      expect(await response.json()).toMatchObject({
        code: "EXPORT_UNSUPPORTED_FORMAT",
        message: expect.stringContaining("importado, export direto ainda não suportado"),
      });
    }
    const svgResponse = await postFile(pdfPost, "vector.svg", svgBytes, { bleedMm: "0.5" });
    expect(svgResponse.status).toBe(422);
    expect(await svgResponse.json()).toMatchObject({ code: "SVG_VECTOR_BLEED_UNSUPPORTED" });
  });
});
