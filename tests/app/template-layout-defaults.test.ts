import { describe, expect, it } from "vitest";
import { applyTemplateLayoutDefaults } from "../../src/app/template-layout-defaults";

const geometry = {
  orientation: "portrait" as const,
  cardOrientation: "portrait" as const,
  pageSizeMm: { widthMm: 100, heightMm: 100 },
  cardSizeMm: { widthMm: 20, heightMm: 30 },
  rows: 1,
  columns: 2,
  slots: [
    { index: 0, row: 0, column: 0, xMm: 20, yMm: 35 },
    { index: 1, row: 0, column: 1, xMm: 60, yMm: 35 },
  ],
};

describe("applyTemplateLayoutDefaults", () => {
  it("clears manual grid and skip state when exact template geometry is applied", () => {
    expect(applyTemplateLayoutDefaults({ rows: "2", columns: "3", skippedSlotIndices: [1] }, geometry)).toEqual({
      rows: "",
      columns: "",
      skippedSlotIndices: [],
      templateGeometry: geometry,
    });
  });

  it("clears template-only skips when template geometry is removed without a fixed grid", () => {
    expect(applyTemplateLayoutDefaults({ rows: "", columns: "", skippedSlotIndices: [1], templateGeometry: geometry }, undefined))
      .toEqual({ rows: "", columns: "", skippedSlotIndices: [] });
  });

  it("preserves skips on an existing fixed manual grid when template geometry is removed", () => {
    expect(applyTemplateLayoutDefaults({ rows: "2", columns: "3", skippedSlotIndices: [1], templateGeometry: geometry }, undefined))
      .toEqual({ rows: "2", columns: "3", skippedSlotIndices: [1] });
  });
});
