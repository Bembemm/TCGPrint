import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import { createCutGeometryMm, createRectangularCutPathMm, type CutSourceIdentity } from "../../core/cut";
import { resolveCutLayout } from "../../services/cut-geometry/layout-sync";

const source: CutSourceIdentity = {
  kind: "template-file",
  templateId: "layout-fixture",
  version: "1",
  packageHash: "a".repeat(64),
  fileId: "cut-file",
  fileHash: "b".repeat(64),
};
const geometry = {
  orientation: "portrait" as const,
  cardOrientation: "portrait" as const,
  pageSizeMm: { widthMm: 210, heightMm: 297 },
  cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
  rows: 1,
  columns: 2,
  slots: [
    { index: 0, row: 0, column: 0, xMm: 10, yMm: 12 },
    { index: 1, row: 0, column: 1, xMm: 80, yMm: 12 },
  ],
};
const settings = {
  ...DEFAULT_PROJECT_SETTINGS,
  bleedMm: 0.625,
  layout: { rows: 1, columns: 2, skippedSlotIndices: [1], templateGeometry: geometry },
};

function sourceGeometry(secondX = 80, pageSizeMm = { widthMm: 210, heightMm: 297 }, firstWidth = 63.5) {
  return createCutGeometryMm({
    source,
    pageSizeMm,
    paths: [
      createRectangularCutPathMm("cut-0", { xMm: 10, yMm: 12, widthMm: firstWidth, heightMm: 88.9 }),
      createRectangularCutPathMm("cut-1", { xMm: secondX, yMm: 12, widthMm: 63.5, heightMm: 88.9 }),
    ],
  });
}

describe("cut/layout synchronization", () => {
  it("keeps slot identity stable and omits a skipped path from active output", () => {
    const result = resolveCutLayout({ projectId: "p1", projectRevision: 4, settings, cardCount: 1, sourceGeometry: sourceGeometry(), sourceOrientation: "portrait" });

    expect(result.placement.slots.map(({ index }) => index)).toEqual([0]);
    expect(result.slotPaths).toEqual([
      { slotIndex: 0, pathId: "cut-0", state: "active" },
      { slotIndex: 1, pathId: "cut-1", state: "skipped" },
    ]);
    expect(result.activeGeometry?.paths.map(({ id }) => id)).toEqual(["cut-0"]);
    expect(result.activeGeometry?.paths[0]?.boundsMm).toEqual(result.placement.slots[0]?.trim);
  });

  it("keeps reserved registration zones separate and excludes their path from active cut export", () => {
    const registration = {
      type: "custom" as const,
      orientation: "portrait" as const,
      marks: [[{ type: "line" as const, x1Mm: 10, y1Mm: 10, x2Mm: 20, y2Mm: 10, strokeWidthMm: 1 }]],
      reservedZones: [{ xMm: 10, yMm: 12, widthMm: 63.5, heightMm: 88.9 }],
    };
    const result = resolveCutLayout({
      projectId: "p1",
      projectRevision: 4,
      settings: { ...settings, registration, layout: { ...settings.layout, skippedSlotIndices: [] } },
      cardCount: 1,
      sourceGeometry: sourceGeometry(),
      sourceOrientation: "portrait",
    });

    expect(result.placement.slots.map(({ index }) => index)).toEqual([1]);
    expect(result.slotPaths.map(({ state }) => state)).toEqual(["reserved", "active"]);
    expect(result.activeGeometry?.paths.map(({ id }) => id)).toEqual(["cut-1"]);
  });

  it("blocks a cut path that differs from the PDF trim without correcting its scale or position", () => {
    expect(() => resolveCutLayout({
      projectId: "p1",
      projectRevision: 4,
      settings,
      cardCount: 1,
      sourceGeometry: sourceGeometry(80.01),
      sourceOrientation: "portrait",
    })).toThrow(/does not coincide with a PDF trim/i);
  });

  it("applies the numeric sync tolerance across coordinate quantization buckets", () => {
    const result = resolveCutLayout({
      projectId: "p1",
      projectRevision: 4,
      settings,
      cardCount: 1,
      sourceGeometry: sourceGeometry(80, { widthMm: 210, heightMm: 297 }, 63.5000006),
      sourceOrientation: "portrait",
    });

    expect(result.activeGeometry?.paths[0]?.boundsMm.widthMm).toBeCloseTo(63.5000006, 7);
  });

  it("derives immutable template slots from a complete cut grid when metadata geometry is absent", () => {
    const result = resolveCutLayout({
      projectId: "p1",
      projectRevision: 4,
      settings: { ...DEFAULT_PROJECT_SETTINGS, bleedMm: 0, layout: { skippedSlotIndices: [1] } },
      cardCount: 1,
      sourceGeometry: sourceGeometry(),
      sourceOrientation: "portrait",
    });

    expect(result.derivedTemplateGeometry).toMatchObject({ rows: 1, columns: 2, slots: geometry.slots });
    expect(result.placement.gridSlots.map(({ trim }) => trim.xMm)).toEqual([10, 80]);
  });

  it("rotates page geometry independently from physical card orientation", () => {
    const nativeSettings = { ...DEFAULT_PROJECT_SETTINGS, pageOrientation: "landscape" as const, cardOrientation: "landscape" as const, bleedMm: 0, layout: { skippedSlotIndices: [], templateGeometry: {
      ...geometry,
      rows: 1,
      columns: 1,
      slots: [{ index: 0, row: 0, column: 0, xMm: 10, yMm: 12 }],
    } } };
    const nativePath = createCutGeometryMm({ source, pageSizeMm: geometry.pageSizeMm, paths: [createRectangularCutPathMm("one", { xMm: 10, yMm: 12, widthMm: 63.5, heightMm: 88.9 })] });
    const result = resolveCutLayout({ projectId: "p1", projectRevision: 4, settings: nativeSettings, cardCount: 1, sourceGeometry: nativePath, sourceOrientation: "portrait" });

    expect(result.placement.pageSizeMm).toEqual({ widthMm: 297, heightMm: 210 });
    expect(result.placement.cardSizeMm).toEqual({ widthMm: 88.9, heightMm: 63.5 });
    expect(result.activeGeometry?.paths[0]?.boundsMm).toEqual(result.placement.slots[0]?.trim);
    expect(result.activeGeometry?.paths[0]?.boundsMm).toEqual({ xMm: 196.1, yMm: 10, widthMm: 88.9, heightMm: 63.5 });
  });

  it("generates only explicit square-corner rectangles without a cut file", () => {
    const result = resolveCutLayout({ projectId: "manual-1", projectRevision: 2, settings, cardCount: 1 });

    expect(result.sourceGeometry.source).toEqual({ kind: "project-layout", projectId: "manual-1", projectRevision: 2 });
    expect(result.activeGeometry?.paths).toHaveLength(1);
    expect(result.activeGeometry?.paths[0]?.segments.every(({ type }) => type === "line")).toBe(true);
    expect(result.slotPaths.find(({ slotIndex }) => slotIndex === 1)?.state).toBe("skipped");
  });
});
