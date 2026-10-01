import { describe, expect, it } from "vitest";
import {
  CUT_GEOMETRY_TOLERANCE_MM,
  computeCutPathBoundsMm,
  createCutGeometryMm,
  createRectangularCutPathMm,
} from "../../core/cut";

const source = {
  kind: "template-file" as const,
  templateId: "fixture-template",
  version: "1",
  packageHash: "a".repeat(64),
  fileId: "fixture-file",
  fileHash: "b".repeat(64),
};

describe("canonical cut geometry in millimeters", () => {
  it("creates a stable rectangular path with explicit page coordinates", () => {
    const path = createRectangularCutPathMm("slot-0", { xMm: 10, yMm: 12, widthMm: 63.5, heightMm: 88.9 });
    const geometry = createCutGeometryMm({ source, pageSizeMm: { widthMm: 210, heightMm: 297 }, paths: [path] });

    expect(geometry.coordinateFrame).toBe("page-top-left-y-down");
    expect(geometry.units).toBe("mm");
    expect(geometry.paths[0]).toMatchObject({ id: "slot-0", closed: true, boundsMm: { xMm: 10, yMm: 12, widthMm: 63.5, heightMm: 88.9 } });
    expect(computeCutPathBoundsMm(geometry.paths[0]!)).toEqual(geometry.paths[0]!.boundsMm);
  });

  it("computes bounds through cubic, quadratic, and elliptical segments", () => {
    const path = {
      id: "curves",
      closed: false,
      start: { xMm: 0, yMm: 0 },
      segments: [
        { type: "cubic", from: { xMm: 0, yMm: 0 }, control1: { xMm: 10, yMm: 0 }, control2: { xMm: 10, yMm: 10 }, to: { xMm: 0, yMm: 10 } },
        { type: "quadratic", from: { xMm: 0, yMm: 10 }, control: { xMm: -5, yMm: 15 }, to: { xMm: 0, yMm: 20 } },
      ],
    } as const;
    const bounds = computeCutPathBoundsMm(path);

    expect(bounds.xMm).toBeCloseTo(-2.5, 8);
    expect(bounds.yMm).toBe(0);
    expect(bounds.widthMm).toBeCloseTo(10, 8);
    expect(bounds.heightMm).toBe(20);
    expect(CUT_GEOMETRY_TOLERANCE_MM).toBeGreaterThan(0);
  });

  it("rejects non-finite coordinates and out-of-page paths", () => {
    const rectangle = createRectangularCutPathMm("slot-0", { xMm: 10, yMm: 12, widthMm: 63.5, heightMm: 88.9 });
    expect(() => createCutGeometryMm({
      source,
      pageSizeMm: { widthMm: 210, heightMm: 297 },
      paths: [{ ...rectangle, start: { xMm: Number.NaN, yMm: 0 } }],
    })).toThrow(/finite/i);
    expect(() => createCutGeometryMm({
      source,
      pageSizeMm: { widthMm: 210, heightMm: 297 },
      paths: [createRectangularCutPathMm("outside", { xMm: 200, yMm: 12, widthMm: 20, heightMm: 10 })],
    })).toThrow(/page bounds/i);
  });
});
