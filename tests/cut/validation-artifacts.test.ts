import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PDFDocument } from "@pdfme/pdf-lib";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import { createDefaultRegistrationConfig } from "../../core/registration";
import { compareCutGeometryMm } from "../../core/cut";
import { resolveCutLayout } from "../../services/cut-geometry/layout-sync";
import { parseSvgCutGeometry } from "../../services/cut-geometry/svg-parser";
import { parseDxfCutGeometry } from "../../services/cut-geometry/dxf-parser";

const ARTIFACTS = join(process.cwd(), "artifacts/phase-11-cut-validation");

describe("Phase 11 physical review artifacts", () => {
  it("matches both cut files and the PDF sheet to the recorded software geometry", async () => {
    const manifest = JSON.parse(await readFile(join(ARTIFACTS, "manifest.json"), "utf8")) as {
      templateSelection: { templateId: string; version: string; packageHash: string };
      selectedCutFile: { fileId: string; fileHash: string };
      reviewArtifacts: Record<string, { sha256: string; byteLength: number }>;
      expectedActiveCutBoundsMm: { xMm: number; yMm: number; widthMm: number; heightMm: number };
      skippedSlotIndices: number[];
      exportedActiveSlots: number[];
    };
    const sourceIdentity = {
      kind: "template-file" as const,
      templateId: manifest.templateSelection.templateId,
      version: manifest.templateSelection.version,
      packageHash: manifest.templateSelection.packageHash,
      fileId: manifest.selectedCutFile.fileId,
      fileHash: manifest.selectedCutFile.fileHash,
    };
    for (const [fileName, expected] of Object.entries(manifest.reviewArtifacts)) {
      const bytes = await readFile(join(ARTIFACTS, fileName));
      expect(bytes.byteLength, `${fileName} byte length`).toBe(expected.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex"), `${fileName} SHA-256`).toBe(expected.sha256);
    }
    const pageSizeMm = { widthMm: 210, heightMm: 297 };
    const source = parseSvgCutGeometry(new Uint8Array(await readFile(join(ARTIFACTS, "source-layout.svg"))), { source: sourceIdentity, expectedPageSizeMm: pageSizeMm });
    const templateGeometry = {
      orientation: "portrait" as const,
      cardOrientation: "portrait" as const,
      pageSizeMm,
      cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      rows: 1,
      columns: 2,
      slots: [
        { index: 0, row: 0, column: 0, xMm: 50, yMm: 100 },
        { index: 1, row: 0, column: 1, xMm: 130, yMm: 100 },
      ],
    };
    const layout = resolveCutLayout({
      projectId: "phase11-review-project",
      projectRevision: 1,
      settings: { ...DEFAULT_PROJECT_SETTINGS, bleedMm: 0, registration: createDefaultRegistrationConfig("three-point", "portrait"), layout: { rows: 1, columns: 2, skippedSlotIndices: manifest.skippedSlotIndices, templateGeometry } },
      cardCount: 1,
      sourceGeometry: source,
      sourceOrientation: "portrait",
    });
    const active = layout.activeGeometry;
    if (!active) throw new Error("Review artifact must contain one active cut path.");
    const svgBytes = new Uint8Array(await readFile(join(ARTIFACTS, "tcgprint-cut.svg")));
    const svgText = new TextDecoder().decode(svgBytes);
    const svg = parseSvgCutGeometry(svgBytes, { source: sourceIdentity, expectedPageSizeMm: pageSizeMm });
    const dxf = parseDxfCutGeometry(new Uint8Array(await readFile(join(ARTIFACTS, "tcgprint-cut.dxf"))), { source: sourceIdentity, expectedPageSizeMm: pageSizeMm });
    const pdf = await PDFDocument.load(new Uint8Array(await readFile(join(ARTIFACTS, "layout-reference.pdf"))));
    const page = pdf.getPages()[0]!.getMediaBox();

    expect(manifest.exportedActiveSlots).toEqual([0]);
    expect(active.paths).toHaveLength(1);
    expect(active.paths[0]!.boundsMm).toEqual(manifest.expectedActiveCutBoundsMm);
    expect(compareCutGeometryMm(active, svg, 0.000001).equal).toBe(true);
    expect(compareCutGeometryMm(active, dxf, 0.000001).equal).toBe(true);
    expect(svgText).not.toMatch(/<script|href=|foreignObject|<image/i);
    expect(dxf.units).toBe("mm");
    expect(dxf.paths).toHaveLength(1);
    expect(dxf.paths[0]!.closed).toBe(true);
    expect(page.width).toBeCloseTo(595.2755905511812, 9);
    expect(page.height).toBeCloseTo(841.8897637795276, 9);
  });
});
