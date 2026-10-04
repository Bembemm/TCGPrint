import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "@pdfme/pdf-lib";
import { describe, expect, it } from "vitest";
import { calculateGridPlacement, MAGIC_STANDARD_CARD, PAPER_FORMATS } from "../../core/geometry";
import { mmToPoints } from "../../core/units";
import { createDefaultRegistrationConfig, generateRegistrationGeometry } from "../../core/registration";
import { LosslessPdfEngine } from "../../pdf-engine/document";

const OUTPUT_DIRECTORY = join(process.cwd(), "artifacts", "phase-10-registration");
const OUTPUT_PDF = join(OUTPUT_DIRECTORY, "registration-physical-reference.pdf");
const OUTPUT_METADATA = join(OUTPUT_DIRECTORY, "registration-physical-reference.json");

describe("physical registration reference fixture", () => {
  it("writes a printable, vector annotated A4 fixture and records its unbound template state", async () => {
    const paper = { ...PAPER_FORMATS.A4 };
    const card = { id: "physical-fixture-card", name: "Physical fixture card", widthMm: 50, heightMm: 65 };
    const registration = createDefaultRegistrationConfig("three-point", "portrait");
    const geometry = generateRegistrationGeometry(registration, { widthMm: paper.widthMm, heightMm: paper.heightMm });
    const skippedSlotIndices = [4];
    const placement = calculateGridPlacement({
      paper,
      card,
      count: 8,
      bleedMm: 0,
      rows: 3,
      columns: 3,
      marginsMm: { top: 35, right: 0, bottom: 0, left: 40 },
      skippedSlotIndices,
      reservedZonesMm: geometry.reservedZones,
    });
    const cardSvg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="650" viewBox="0 0 500 650"><rect x="2" y="2" width="496" height="646" fill="#ffffff" stroke="#222222" stroke-width="4"/></svg>',
    );
    const generated = await new LosslessPdfEngine().generate({
      images: Array.from({ length: 8 }, () => cardSvg),
      paperFormat: paper,
      cardFormat: card,
      pageOrientation: "portrait",
      cardOrientation: "portrait",
      marginsMm: { top: 35, right: 0, bottom: 0, left: 40 },
      registration,
      layoutRows: 3,
      layoutColumns: 3,
      skippedSlotIndices,
      cutGuides: {
        trim: { enabled: true, extentMm: "full", color: "blue" },
        external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
      },
    });

    const document = await PDFDocument.load(generated);
    const page = document.getPages()[0]!;
    const font = await document.embedFont(StandardFonts.Helvetica);
    const boldFont = await document.embedFont(StandardFonts.HelveticaBold);
    const topText = (value: string, xMm: number, topMm: number, size: number, bold = false) => {
      page.drawText(value, {
        x: mmToPoints(xMm),
        y: mmToPoints(paper.heightMm - topMm) - size,
        size,
        font: bold ? boldFont : font,
        color: rgb(0.08, 0.08, 0.08),
      });
    };

    topText("TCGPrint Phase 10 - Registration reference fixture", 27, 23, 11, true);
    topText("A4 portrait | Cards portrait 50 x 65 mm | Registration three-point / portrait", 27, 29, 7.5);
    topText("Scale 100% / Actual Size | Synthetic reference; no real Silhouette template is bound", 27, 34, 7.5);
    topText("Template ID: none | Version: fixture-1 | Package hash: n/a", 27, 39, 7.5);
    page.drawLine({
      start: { x: mmToPoints(27), y: mmToPoints(paper.heightMm - 45) },
      end: { x: mmToPoints(37), y: mmToPoints(paper.heightMm - 45) },
      thickness: 1,
      color: rgb(0.08, 0.08, 0.08),
    });
    page.drawLine({
      start: { x: mmToPoints(27), y: mmToPoints(paper.heightMm - 46) },
      end: { x: mmToPoints(27), y: mmToPoints(paper.heightMm - 44) },
      thickness: 0.75,
      color: rgb(0.08, 0.08, 0.08),
    });
    page.drawLine({
      start: { x: mmToPoints(37), y: mmToPoints(paper.heightMm - 46) },
      end: { x: mmToPoints(37), y: mmToPoints(paper.heightMm - 44) },
      thickness: 0.75,
      color: rgb(0.08, 0.08, 0.08),
    });
    topText("10 mm bar | margins top 35 / left 40 mm | gaps 0 mm", 39, 43, 6.5);

    for (const zone of geometry.reservedZones) {
      page.drawRectangle({
        x: mmToPoints(zone.xMm),
        y: mmToPoints(paper.heightMm - zone.yMm - zone.heightMm),
        width: mmToPoints(zone.widthMm),
        height: mmToPoints(zone.heightMm),
        borderColor: rgb(0.85, 0.12, 0.16),
        borderWidth: mmToPoints(0.35),
      });
    }

    for (const slot of placement.slots) {
      const trim = slot.trim;
      const bottomMm = paper.heightMm - trim.yMm - trim.heightMm;
      page.drawRectangle({
        x: mmToPoints(trim.xMm),
        y: mmToPoints(bottomMm),
        width: mmToPoints(trim.widthMm),
        height: mmToPoints(trim.heightMm),
        borderColor: rgb(0.05, 0.05, 0.05),
        borderWidth: 0.5,
      });
      page.drawText(`CARD SLOT ${slot.index + 1}`, {
        x: mmToPoints(trim.xMm + 3),
        y: mmToPoints(bottomMm + trim.heightMm / 2 + 1),
        size: 12,
        font: boldFont,
        color: rgb(0.05, 0.05, 0.05),
      });
      page.drawText("50 x 65 mm", {
        x: mmToPoints(trim.xMm + 3),
        y: mmToPoints(bottomMm + trim.heightMm / 2 - 4),
        size: 6.5,
        font,
        color: rgb(0.05, 0.05, 0.05),
      });
    }

    const skipped = placement.gridSlots[4]!;
    const skippedBottomMm = paper.heightMm - skipped.trim.yMm - skipped.trim.heightMm;
    const skippedRect = {
      x: mmToPoints(skipped.trim.xMm),
      y: mmToPoints(skippedBottomMm),
      width: mmToPoints(skipped.trim.widthMm),
      height: mmToPoints(skipped.trim.heightMm),
    };
    page.drawRectangle({ ...skippedRect, borderColor: rgb(0.55, 0.12, 0.68), borderWidth: 1.25 });
    page.drawLine({
      start: { x: skippedRect.x, y: skippedRect.y },
      end: { x: skippedRect.x + skippedRect.width, y: skippedRect.y + skippedRect.height },
      thickness: 1,
      color: rgb(0.55, 0.12, 0.68),
    });
    page.drawLine({
      start: { x: skippedRect.x, y: skippedRect.y + skippedRect.height },
      end: { x: skippedRect.x + skippedRect.width, y: skippedRect.y },
      thickness: 1,
      color: rgb(0.55, 0.12, 0.68),
    });
    page.drawText("SKIPPED SLOT 5", {
      x: skippedRect.x + mmToPoints(4),
      y: skippedRect.y + skippedRect.height / 2,
      size: 7,
      font: boldFont,
      color: rgb(0.4, 0.04, 0.55),
    });

    await mkdir(OUTPUT_DIRECTORY, { recursive: true });
    await writeFile(OUTPUT_PDF, await document.save());
    await writeFile(OUTPUT_METADATA, `${JSON.stringify({
      fixtureId: "tcgprint-registration-physical-reference",
      fixtureVersion: "fixture-1",
      templateSelection: null,
      templateNote: "Synthetic reference geometry. Import and select the exact real Silhouette template version before physical approval.",
      paper: { id: "a4", widthMm: 210, heightMm: 297, orientation: "portrait" },
      card: { orientation: "portrait", widthMm: 50, heightMm: 65 },
      marginsMm: { top: 35, right: 0, bottom: 0, left: 40 },
      gapsMm: { horizontal: 0, vertical: 0 },
      registration,
      registrationReservedZonesMm: geometry.reservedZones,
      layout: { rows: 3, columns: 3, skippedSlotIndices },
      calibrationBarMm: 10,
      requiredPrintScale: 1,
    }, null, 2)}\n`, "utf8");

    const box = page.getMediaBox();
    expect(box.width).toBeCloseTo(mmToPoints(210), 8);
    expect(box.height).toBeCloseTo(mmToPoints(297), 8);
    expect(placement.slots).toHaveLength(8);
    expect(placement.gridSlots[4]).toMatchObject({ skippedByUser: true });
    expect(placement.gridSlots[4]?.cardIndex).toBeUndefined();
    expect(geometry.marks).toHaveLength(3);
    expect((await readFile(OUTPUT_PDF)).byteLength).toBeGreaterThan(0);
  });
});
