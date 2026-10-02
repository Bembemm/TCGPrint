import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import { describe, expect, it } from "vitest";
import { generateCalibrationSheet, generateVerificationSheet } from "../../services/calibration-sheet";
import { createPrintCalibrationTransform, parseSideCalibration } from "../../core/calibration";
import { mmToPoints } from "../../core/units";
import type { CalibrationPointId, CalibrationPointMm, SideCalibration } from "../../core/calibration";

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

function pageContentText(pdf: PDFDocument, pageIndex: number): string {
  const contents = pdf.getPages()[pageIndex]!.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (const reference of contents.asArray()) {
      const object = pdf.context.lookup(reference);
      if (object instanceof PDFRawStream) streams.push(object);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  return streams.map((stream) => inflateSync(Buffer.from(stream.contents)).toString("latin1")).join("\n");
}

function containsPdfText(content: string, text: string): boolean {
  const encoded = Buffer.from(text, "ascii").toString("hex").toUpperCase();
  return content.toUpperCase().includes(encoded);
}

function normalizedGeometry(content: string): string {
  return content.replace(/\/Helvetica-\d+/g, "/Helvetica-FONT");
}

interface SheetPageDetails {
  readonly side: "front" | "back";
  readonly nominalTargetPointsMm: Readonly<Record<CalibrationPointId, CalibrationPointMm>>;
  readonly duplexTargetPointsMm: Readonly<Record<CalibrationPointId, CalibrationPointMm>>;
  readonly pdfTargetPointsMm: Readonly<Record<CalibrationPointId, CalibrationPointMm>>;
  readonly calibration?: SideCalibration;
  readonly transform?: ReturnType<typeof createPrintCalibrationTransform>["matrix"];
  readonly duplexPhysicalMapping?: {
    readonly pageOrientation: "portrait" | "landscape";
    readonly edgeMode: "long-edge" | "short-edge";
    readonly reflectionAxis: "x" | "y";
    readonly matrix: { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number };
    readonly artworkOrientation: { readonly rotationDegrees: 0 | 180 };
  };
  readonly orientationMark: {
    readonly nominalPointMm: CalibrationPointMm;
    readonly duplexPointMm: CalibrationPointMm;
    readonly pdfPointMm: CalibrationPointMm;
    readonly nominalDirection: CalibrationPointMm;
    readonly duplexDirection: CalibrationPointMm;
    readonly pdfDirection: CalibrationPointMm;
  };
}

interface SheetManifestDetails {
  readonly side: "front" | "back" | "duplex";
  readonly pages: readonly SheetPageDetails[];
  readonly targetPointsSpace: string;
}

function pageDetails(manifest: unknown): SheetManifestDetails {
  return manifest as SheetManifestDetails;
}

function simulatePhysicalFlip(point: CalibrationPointMm, axis: "x" | "y", widthMm: number, heightMm: number): CalibrationPointMm {
  return axis === "x"
    ? { xMm: widthMm - point.xMm, yMm: point.yMm }
    : { xMm: point.xMm, yMm: heightMm - point.yMm };
}

function simulatePhysicalFlipVector(point: CalibrationPointMm, axis: "x" | "y"): CalibrationPointMm {
  return axis === "x"
    ? { xMm: point.xMm === 0 ? 0 : -point.xMm, yMm: point.yMm }
    : { xMm: point.xMm, yMm: point.yMm === 0 ? 0 : -point.yMm };
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
    expect(containsPdfText(automaticPdf.content, "Do not manually reinsert the sheet.")).toBe(true);
    expect(normalizedGeometry(frontPdf.content)).not.toEqual(normalizedGeometry(backPdf.content));
    expect(normalizedGeometry(frontPdf.content)).toEqual(normalizedGeometry((await contentText(frontAgain.pdfBytes)).content));
  });

  it.each([
    ["portrait", "manual-long-edge", 210, 297, "x", 0],
    ["portrait", "manual-short-edge", 210, 297, "y", 180],
    ["landscape", "manual-long-edge", 297, 210, "y", 180],
    ["landscape", "manual-short-edge", 297, 210, "x", 0],
  ] as const)("pairs asymmetric BACK targets through the Phase 12 mapping for %s + %s", async (orientation, duplexMode, widthMm, heightMm, axis, rotationDegrees) => {
    const front = await generateCalibrationSheet({ ...request, pageOrientation: orientation, duplexMode, side: "front" });
    const back = await generateCalibrationSheet({ ...request, pageOrientation: orientation, duplexMode, side: "back" });
    const frontPage = pageDetails(front.manifest).pages[0]!;
    const backManifest = pageDetails(back.manifest);
    const backPage = backManifest.pages[0]!;

    expect(backManifest.targetPointsSpace).toBe("pdf-page-y-up-after-duplex-and-calibration");
    expect(backPage.duplexPhysicalMapping).toMatchObject({
      pageOrientation: orientation,
      edgeMode: duplexMode.endsWith("long-edge") ? "long-edge" : "short-edge",
      reflectionAxis: axis,
      artworkOrientation: { rotationDegrees },
    });
    expect(backPage.nominalTargetPointsMm).toEqual(frontPage.nominalTargetPointsMm);
    for (const [id, pointName] of [
      ["TL", "top-left"], ["TR", "top-right"], ["BL", "bottom-left"], ["BR", "bottom-right"], ["CENTER", "center"],
    ] as const) {
      const nominal = frontPage.nominalTargetPointsMm[pointName];
      const paired = backPage.duplexTargetPointsMm[pointName];
      expect(paired, `${id} is mapped into the PDF back-page frame`).toEqual(
        simulatePhysicalFlip(nominal, axis, widthMm, heightMm),
      );
      expect(simulatePhysicalFlip(backPage.pdfTargetPointsMm[pointName], axis, widthMm, heightMm), `${id} aligns after the selected physical flip`)
        .toEqual(nominal);
    }
    expect(backPage.orientationMark.duplexPointMm).toEqual(
      simulatePhysicalFlip(frontPage.orientationMark.nominalPointMm, axis, widthMm, heightMm),
    );
    expect(simulatePhysicalFlip(backPage.orientationMark.pdfPointMm, axis, widthMm, heightMm))
      .toEqual(frontPage.orientationMark.nominalPointMm);

    const expectedPdfUp = { xMm: 0, yMm: 1 };
    const backPdfUp = rotationDegrees === 180
      ? {
          xMm: expectedPdfUp.xMm === 0 ? 0 : -expectedPdfUp.xMm,
          yMm: expectedPdfUp.yMm === 0 ? 0 : -expectedPdfUp.yMm,
        }
      : expectedPdfUp;
    expect(backPage.orientationMark.nominalDirection).toEqual(expectedPdfUp);
    expect(simulatePhysicalFlipVector(backPdfUp, axis)).toEqual(expectedPdfUp);
  });

  it.each([
    ["portrait", "automatic-long-edge", 210, 297, "x"],
    ["portrait", "automatic-short-edge", 210, 297, "y"],
    ["landscape", "automatic-long-edge", 297, 210, "y"],
    ["landscape", "automatic-short-edge", 297, 210, "x"],
  ] as const)("generates a paired two-page automatic calibration and verification job for %s + %s", async (orientation, duplexMode, widthMm, heightMm, axis) => {
    const paperFormat = { name: "A4", widthMm: 210, heightMm: 297 };
    const common = { ...request, paperFormat, pageOrientation: orientation, duplexMode };
    const calibrationSheet = await generateCalibrationSheet({ ...common, side: "back" });
    const corrections = {
      front: parseSideCalibration({ offsetXUm: 125, offsetYUm: -50, rotationDeg: 0.02, scaleX: 1.0001, scaleY: 0.9999 }),
      back: parseSideCalibration({ offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1.00012, scaleY: 0.99987 }),
    };
    const verificationSheet = await generateVerificationSheet({
      ...common,
      side: "back",
      calibrations: corrections,
    } as never);
    const calibrationManifest = pageDetails(calibrationSheet.manifest);
    const verificationManifest = pageDetails(verificationSheet.manifest);
    const calibrationPdf = await PDFDocument.load(calibrationSheet.pdfBytes);
    const verificationPdf = await PDFDocument.load(verificationSheet.pdfBytes);

    expect(calibrationManifest.side).toBe("duplex");
    expect(calibrationManifest.pages.map(({ side }) => side)).toEqual(["front", "back"]);
    expect(verificationManifest.side).toBe("duplex");
    expect(verificationManifest.pages.map(({ side }) => side)).toEqual(["front", "back"]);
    expect(calibrationPdf.getPages()).toHaveLength(2);
    expect(verificationPdf.getPages()).toHaveLength(2);
    expect(containsPdfText(pageContentText(calibrationPdf, 0), "FRONT")).toBe(true);
    expect(containsPdfText(pageContentText(calibrationPdf, 1), "BACK")).toBe(true);
    expect(containsPdfText(pageContentText(verificationPdf, 0), "FRONT")).toBe(true);
    expect(containsPdfText(pageContentText(verificationPdf, 1), "BACK")).toBe(true);
    for (const page of [...calibrationPdf.getPages(), ...verificationPdf.getPages()]) {
      expect(page.getMediaBox()).toEqual({ x: 0, y: 0, width: mmToPoints(widthMm), height: mmToPoints(heightMm) });
    }
    expect(calibrationManifest.pages[1]!.duplexPhysicalMapping).toMatchObject({ reflectionAxis: axis });
    expect(verificationManifest.pages[1]!.duplexPhysicalMapping).toMatchObject({ reflectionAxis: axis });
    for (const targetId of ["top-left", "top-right", "bottom-left", "bottom-right", "center"] as const) {
      const frontTarget = calibrationManifest.pages[0]!.nominalTargetPointsMm[targetId];
      expect(calibrationManifest.pages[1]!.duplexTargetPointsMm[targetId]).toEqual(
        simulatePhysicalFlip(frontTarget, axis, widthMm, heightMm),
      );
      expect(simulatePhysicalFlip(calibrationManifest.pages[1]!.pdfTargetPointsMm[targetId], axis, widthMm, heightMm)).toEqual(frontTarget);
      expect(verificationManifest.pages[1]!.duplexTargetPointsMm[targetId]).toEqual(
        calibrationManifest.pages[1]!.duplexTargetPointsMm[targetId],
      );
    }
    expect(calibrationManifest.pages[1]!.orientationMark.nominalDirection).toEqual({ xMm: 0, yMm: 1 });
    expect(calibrationManifest.pages[1]!.orientationMark.duplexDirection).toEqual(
      axis === "y" ? { xMm: 0, yMm: -1 } : { xMm: 0, yMm: 1 },
    );
    expect(verificationManifest.pages[1]!.pdfTargetPointsMm).not.toEqual(calibrationManifest.pages[1]!.duplexTargetPointsMm);
    expect(verificationManifest.pages.map(({ calibration }) => calibration)).toEqual([corrections.front, corrections.back]);
    expect(verificationManifest.pages.map(({ transform }) => transform)).toEqual([
      createPrintCalibrationTransform({ widthMm, heightMm }, corrections.front, "front").matrix,
      createPrintCalibrationTransform({ widthMm, heightMm }, corrections.back, "back").matrix,
    ]);
    const imageStreams = verificationPdf.context.enumerateIndirectObjects().filter(([, object]) =>
      object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image",
    );
    expect(imageStreams).toHaveLength(0);
  });

  it.each([
    ["portrait", 210, 297],
    ["landscape", 297, 210],
  ] as const)("produces different automatic long-edge and short-edge target geometry for %s pages", async (pageOrientation, widthMm, heightMm) => {
    const longEdge = await generateCalibrationSheet({ ...request, pageOrientation, duplexMode: "automatic-long-edge", side: "back" });
    const shortEdge = await generateCalibrationSheet({ ...request, pageOrientation, duplexMode: "automatic-short-edge", side: "back" });
    const longBack = pageDetails(longEdge.manifest).pages[1]!;
    const shortBack = pageDetails(shortEdge.manifest).pages[1]!;

    expect(longBack.duplexPhysicalMapping?.matrix).not.toEqual(shortBack.duplexPhysicalMapping?.matrix);
    expect(longBack.duplexTargetPointsMm).not.toEqual(shortBack.duplexTargetPointsMm);
    expect(longBack.duplexTargetPointsMm["top-left"]).toEqual(
      simulatePhysicalFlip(longBack.nominalTargetPointsMm["top-left"], longBack.duplexPhysicalMapping!.reflectionAxis, widthMm, heightMm),
    );
    expect(shortBack.duplexTargetPointsMm["top-left"]).toEqual(
      simulatePhysicalFlip(shortBack.nominalTargetPointsMm["top-left"], shortBack.duplexPhysicalMapping!.reflectionAxis, widthMm, heightMm),
    );
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
