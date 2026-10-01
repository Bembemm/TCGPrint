import { inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import { describe, expect, it } from "vitest";
import { generateCalibrationSheet, generateVerificationSheet } from "../../services/calibration-sheet";
import { createPrintCalibrationTransform, parseSideCalibration } from "../../core/calibration";
import { mmToPoints } from "../../core/units";

const request = {
  sessionId: "session-123",
  draftProfileId: "draft-a4",
  paperFormat: { name: "A4", widthMm: 210, heightMm: 297 },
  pageOrientation: "portrait" as const,
  duplexMode: "manual-long-edge" as const,
  side: "front" as const,
  generatedAt: "2026-10-01T12:00:00.000Z",
};

async function contentText(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  const streams: Buffer[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of("Filter"))?.toString() === "/FlateDecode") {
      streams.push(inflateSync(Buffer.from(object.contents)));
    }
  }
  return { pdf, content: Buffer.concat(streams).toString("latin1") };
}

function containsPdfText(content: string, text: string): boolean {
  const encoded = Buffer.from(text, "ascii").toString("hex").toUpperCase();
  return content.toUpperCase().includes(encoded);
}

function normalizedGeometry(content: string): string {
  return content.replace(/\/Helvetica-\d+/g, "/Helvetica-FONT");
}

describe("vector calibration and verification sheets", () => {
  it("generates bounded deterministic front/back vector targets and print instructions", async () => {
    const front = await generateCalibrationSheet(request);
    const frontAgain = await generateCalibrationSheet(request);
    const back = await generateCalibrationSheet({ ...request, side: "back" });
    const automatic = await generateCalibrationSheet({ ...request, duplexMode: "automatic-short-edge" });
    const frontPdf = await contentText(front.pdfBytes);
    const backPdf = await contentText(back.pdfBytes);
    const automaticPdf = await contentText(automatic.pdfBytes);

    expect(front.manifest).toMatchObject({
      kind: "calibration",
      sessionId: request.sessionId,
      draftProfileId: request.draftProfileId,
      pageFormat: { paperSize: "A4", pageOrientation: "portrait", widthMm: 210, heightMm: 297 },
      duplexMode: "manual-long-edge",
      side: "front",
      schemaVersion: 1,
    });
    expect(front.manifest.targetPointsMm["top-left"]).toEqual({ xMm: 15, yMm: 282 });
    expect(front.manifest.targetPointsMm["top-right"]).toEqual({ xMm: 195, yMm: 282 });
    expect(frontPdf.pdf.getPages()).toHaveLength(1);
    expect(frontPdf.pdf.getPages()[0]!.getMediaBox().width).toBeCloseTo(mmToPoints(210), 10);
    expect(frontPdf.pdf.getPages()[0]!.getMediaBox().height).toBeCloseTo(mmToPoints(297), 10);
    expect(containsPdfText(frontPdf.content, "FRONT")).toBe(true);
    expect(containsPdfText(frontPdf.content, "BACK")).toBe(true);
    expect(containsPdfText(frontPdf.content, "10 mm")).toBe(true);
    expect(containsPdfText(frontPdf.content, "50 mm")).toBe(true);
    expect(containsPdfText(frontPdf.content, "100 mm")).toBe(true);
    expect(containsPdfText(frontPdf.content, "Actual Size")).toBe(true);
    expect(containsPdfText(frontPdf.content, "Fit OFF")).toBe(true);
    expect(containsPdfText(frontPdf.content, "long edge")).toBe(true);
    expect(containsPdfText(automaticPdf.content, "Automatic duplex")).toBe(true);
    expect(containsPdfText(automaticPdf.content, "do not reinsert manually")).toBe(true);
    expect(normalizedGeometry(frontPdf.content)).not.toEqual(normalizedGeometry(backPdf.content));
    expect(normalizedGeometry(frontPdf.content)).toEqual(normalizedGeometry((await contentText(frontAgain.pdfBytes)).content));
  });

  it("applies the resolved canonical transform on verification without changing page boxes", async () => {
    const calibration = parseSideCalibration({ offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1.00012, scaleY: 0.99987 });
    const artifact = await generateVerificationSheet({ ...request, side: "back", calibration });
    const parsed = await contentText(artifact.pdfBytes);
    const expected = createPrintCalibrationTransform({ widthMm: 210, heightMm: 297 }, calibration, "back");

    expect(artifact.manifest).toMatchObject({ kind: "verification", side: "back", transform: expected.matrix });
    expect(parsed.pdf.getPages()[0]!.getMediaBox()).toEqual({ x: 0, y: 0, width: mmToPoints(210), height: mmToPoints(297) });
    const expectedCtm = `${expected.matrix.a} ${expected.matrix.b} ${expected.matrix.c} ${expected.matrix.d}`;
    expect(parsed.content).toContain(expectedCtm);
  });

  it("uses nominal vector geometry when verification uses identity calibration", async () => {
    const initial = await generateCalibrationSheet(request);
    const verification = await generateVerificationSheet({
      ...request,
      calibration: parseSideCalibration({ offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 }),
    });

    expect((await contentText(verification.pdfBytes)).content).toEqual((await contentText(initial.pdfBytes)).content);
  });

  it("rejects arbitrary matrix input and unsafe sheet dimensions or identifiers", async () => {
    await expect(generateCalibrationSheet({ ...request, matrix: [1, 0, 0, 1, 999, 999] } as never)).rejects.toThrow(/unsupported|matrix/i);
    await expect(generateCalibrationSheet({ ...request, paperFormat: { name: "small", widthMm: 80, heightMm: 80 } })).rejects.toThrow(/dimension/i);
    await expect(generateCalibrationSheet({ ...request, sessionId: "../private" })).rejects.toThrow(/identifier/i);
  });
});
