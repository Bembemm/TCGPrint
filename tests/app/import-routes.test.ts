import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { POST as previewPost } from "../../src/app/api/import/preview/route";
import { POST as pdfPost } from "../../src/app/api/import/pdf/route";
import { mmToPoints, pointsToMm } from "../../core/units";

const fixturePath = join(process.cwd(), "tests", "fixtures", "pdf");
const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140" viewBox="0 0 100 140"><rect width="100" height="140" fill="#123456"/></svg>');

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
  const images: Array<{ readonly raw: PDFRawStream; readonly dictionary: string }> = [];
  const content: Buffer[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dictionary = object.dict.toString();
    if (object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image") images.push({ raw: object, dictionary });
    else if (object.dict.get(PDFName.of("Filter"))?.toString() === "/FlateDecode") {
      content.push(inflateSync(Buffer.from(object.contents)));
    }
  }
  return { pdf, images, rawContent: Buffer.concat(content).toString("latin1") };
}

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

  it("exports local PNG, JPEG and SVG through existing engines at A4 and Magic Standard trim", async () => {
    for (const [filename, bytes] of [
      ["sample.png", new Uint8Array(await readFile(join(fixturePath, "synthetic-rgb.png")))],
      ["sample.jpg", new Uint8Array(await readFile(join(fixturePath, "synthetic-gradient.jpg")))],
      ["sample.svg", svgBytes],
    ] as const) {
      const response = await postFile(pdfPost, filename, bytes, { bleedMm: "0", cutGuides: "full" });
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
    const response = await postFile(pdfPost, "source.jpg", jpeg, { bleedMm: "0.625", cutGuides: "full" });
    expect(response.status).toBe(200);
    const parsed = await imageStreams(new Uint8Array(await response.arrayBuffer()));
    const dct = parsed.images.find((image) => image.dictionary.includes("/DCTDecode"));
    expect(dct).toBeDefined();
    expect(Buffer.from(dct!.raw.contents)).toEqual(Buffer.from(jpeg));
    const matrices = parsed.rawContent.split(/\r?\n/)
      .filter((line) => line.trim().endsWith(" cm"))
      .map((line) => line.trim().replace(/\s+cm$/, "").split(/\s+/).map(Number));
    expect(matrices.some(([width]) => Math.abs(width - mmToPoints(63.5 + 1.25)) < 1e-8)).toBe(true);
    expect(parsed.rawContent).toMatch(/\s+m\s+/);
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
