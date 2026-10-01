import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument } from "@pdfme/pdf-lib";
import { describe, expect, it } from "vitest";
import { createIdentitySideCalibration, createPrintCalibrationTransform, parseSideCalibration, serializePrinterProfileExport } from "../../core/calibration";
import { computePrinterProfileHash } from "../../persistence/printer-profiles/hash";
import { generateCalibrationSheet, generateVerificationSheet } from "../../services/calibration-sheet";
import { mmToPoints } from "../../core/units";

const ARTIFACT_DIRECTORY = join(process.cwd(), "artifacts", "phase-13-calibration");
const ARTIFACT_SESSION = "phase13-a4-manual-long-edge-fixture";
const PROFILE_ID = "example-a4-manual-long-edge";
const PAPER = { name: "A4", widthMm: 210, heightMm: 297 };
const BACK_CALIBRATION = parseSideCalibration({
  offsetXUm: -683,
  offsetYUm: 247,
  rotationDeg: 0.031,
  scaleX: 1.00012,
  scaleY: 0.99987,
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Phase 13 software-only calibration artifacts", () => {
  it("writes front/back calibration sheets, a transformed verification sheet, and an auditable manifest", async () => {
    const profileValues = {
      id: PROFILE_ID,
      name: "Example A4 manual long-edge",
      front: createIdentitySideCalibration(),
      back: BACK_CALIBRATION,
      paperSize: "A4",
      paperWidthMm: 210,
      paperHeightMm: 297,
      pageOrientation: "portrait" as const,
      duplexMode: "manual-long-edge" as const,
      mediaType: "Example matte card stock",
      printQualityProfile: "Actual Size / 100%",
      feedSource: "Manual feed",
      notes: "Software fixture only; no physical printer readings are included.",
      physicalValidationStatus: "software-only" as const,
      physicalVerification: null,
    };
    const profile = {
      ...profileValues,
      version: 1,
      profileHash: computePrinterProfileHash(profileValues, 1),
    };
    const sheetRequest = {
      sessionId: ARTIFACT_SESSION,
      draftProfileId: PROFILE_ID,
      paperFormat: PAPER,
      pageOrientation: "portrait" as const,
      duplexMode: "manual-long-edge" as const,
    };
    const front = await generateCalibrationSheet({ ...sheetRequest, side: "front" });
    const back = await generateCalibrationSheet({ ...sheetRequest, side: "back" });
    const verification = await generateVerificationSheet({ ...sheetRequest, side: "back", calibration: BACK_CALIBRATION });
    const expectedTransform = createPrintCalibrationTransform({ widthMm: 210, heightMm: 297 }, BACK_CALIBRATION, "back");

    for (const pdfBytes of [front.pdfBytes, back.pdfBytes, verification.pdfBytes]) {
      expect(pdfBytes.byteLength).toBeLessThan(100_000);
      const document = await PDFDocument.load(pdfBytes);
      expect(document.getPages()).toHaveLength(1);
      expect(document.getPages()[0]!.getMediaBox()).toEqual({ x: 0, y: 0, width: mmToPoints(210), height: mmToPoints(297) });
    }
    expect(verification.manifest.transform).toEqual(expectedTransform.matrix);
    expect(profile.physicalValidationStatus).toBe("software-only");
    expect(profile.physicalVerification).toBeNull();

    await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
    const files = {
      "calibration-front-a4-portrait.pdf": front.pdfBytes,
      "calibration-back-a4-portrait.pdf": back.pdfBytes,
      "verification-back-a4-portrait.pdf": verification.pdfBytes,
    };
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(ARTIFACT_DIRECTORY, name), bytes);
    const profileJson = serializePrinterProfileExport(profile);
    await writeFile(join(ARTIFACT_DIRECTORY, "example-profile.json"), `${profileJson}\n`, "utf8");
    const manifest = {
      schemaVersion: 1,
      phase: "13-precision-print-calibration",
      softwareValidationStatus: "software-only",
      physicalMeasurementsRecorded: false,
      fixtureSessionId: ARTIFACT_SESSION,
      profile: { id: profile.id, version: profile.version, hash: profile.profileHash, values: profile },
      paper: { name: "A4", widthMm: 210, heightMm: 297, orientation: "portrait" },
      duplexMode: "manual-long-edge",
      targetPointsMm: verification.manifest.targetPointsMm,
      expectedBackMatrixPdfYUp: expectedTransform.matrix,
      expectedBackMatrixSvgYDown: expectedTransform.svgMatrix,
      sheetManifests: { front: front.manifest, back: back.manifest, verification: verification.manifest },
      artifacts: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.byteLength }])),
      profileExport: { file: "example-profile.json", sha256: sha256(new TextEncoder().encode(profileJson)) },
    };
    await writeFile(join(ARTIFACT_DIRECTORY, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(join(ARTIFACT_DIRECTORY, "README.md"), [
      "# Phase 13 calibration artifacts",
      "",
      "These PDFs and profile JSON are software fixtures generated from the bounded calibration engine. They include no physical printer measurements and do not mark a printer physically verified.",
      "",
      "## Print instructions",
      "",
      "- Print at 100% / Actual Size.",
      "- Fit to Page OFF; Shrink OFF.",
      "- Borderless expansion OFF; driver scaling OFF.",
      "- For manual long-edge duplex, print FRONT, then turn/reinsert the sheet like a book at the long edge for BACK.",
      "- Compare front/back targets against light. Enter measured signed residuals only after measuring the printed verification sheet.",
      "",
      "`manifest.json` records expected matrices, fixture identity, profile version/hash, target coordinates, and SHA-256 for every generated file. No physical pass tolerance is defined.",
      "",
    ].join("\n"), "utf8");

    expect(manifest.artifacts).toMatchObject({
      "calibration-front-a4-portrait.pdf": { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      "calibration-back-a4-portrait.pdf": { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      "verification-back-a4-portrait.pdf": { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });
});
