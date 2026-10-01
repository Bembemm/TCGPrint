import { describe, expect, it } from "vitest";
import { createCutGeometryMm, type CutGeometryMm, type CutPathMm, type CutSourceIdentity } from "../../core/cut";
import { comparePhysicalCutGeometryMm } from "../../services/cut-geometry/physical-comparison";

const source: CutSourceIdentity = { kind: "template-file", templateId: "comparison-fixture", version: "1", packageHash: "a".repeat(64), fileId: "cut", fileHash: "b".repeat(64) };
const pageSizeMm = { widthMm: 210, heightMm: 297 };

function closedPolygon(id: string, points: readonly { xMm: number; yMm: number }[]): CutPathMm {
  const segments = points.map((from, index) => ({ type: "line" as const, from, to: points[(index + 1) % points.length]! }));
  return { id, start: points[0]!, closed: true, segments, boundsMm: { xMm: 10, yMm: 12, widthMm: 63.5, heightMm: 88.9 } };
}

function geometry(path: CutPathMm): CutGeometryMm {
  return createCutGeometryMm({ source, pageSizeMm, paths: [{ id: path.id, start: path.start, closed: path.closed, segments: path.segments }] });
}

const rectangle = [
  { xMm: 10, yMm: 12 },
  { xMm: 73.5, yMm: 12 },
  { xMm: 73.5, yMm: 100.9 },
  { xMm: 10, yMm: 100.9 },
];

describe("alternate cut-source physical comparison", () => {
  it("treats a closed rectangle with a different start vertex as equivalent", () => {
    expect(comparePhysicalCutGeometryMm(geometry(closedPolygon("a", rectangle)), geometry(closedPolygon("b", [...rectangle.slice(2), ...rectangle.slice(0, 2)])), 0.001).status).toBe("equivalent");
  });

  it("treats a closed rectangle with reversed winding as equivalent", () => {
    expect(comparePhysicalCutGeometryMm(geometry(closedPolygon("a", rectangle)), geometry(closedPolygon("b", [...rectangle].reverse())), 0.001).status).toBe("equivalent");
  });

  it("treats redundant collinear vertices as the same physical contour", () => {
    const splitEdge = [rectangle[0]!, { xMm: 40, yMm: 12 }, ...rectangle.slice(1)];
    expect(comparePhysicalCutGeometryMm(geometry(closedPolygon("a", rectangle)), geometry(closedPolygon("b", splitEdge)), 0.001).status).toBe("equivalent");
  });

  it("reports material displacement and dimension changes as divergent", () => {
    const moved = rectangle.map((point) => ({ ...point, xMm: point.xMm + 0.01 }));
    const resized = rectangle.map((point) => ({ ...point, xMm: point.xMm === 73.5 ? 74 : point.xMm }));
    expect(comparePhysicalCutGeometryMm(geometry(closedPolygon("a", rectangle)), geometry(closedPolygon("b", moved)), 0.001).status).toBe("divergent");
    expect(comparePhysicalCutGeometryMm(geometry(closedPolygon("a", rectangle)), geometry(closedPolygon("b", resized)), 0.001).status).toBe("divergent");
  });

  it("does not claim equivalence or divergence for curves with the same bounds", () => {
    const curved = createCutGeometryMm({ source, pageSizeMm, paths: [{
      id: "curve",
      start: { xMm: 10, yMm: 12 },
      closed: true,
      segments: [
        { type: "cubic", from: { xMm: 10, yMm: 12 }, control1: { xMm: 20, yMm: 12 }, control2: { xMm: 63.5, yMm: 12 }, to: { xMm: 73.5, yMm: 12 } },
        { type: "line", from: { xMm: 73.5, yMm: 12 }, to: { xMm: 73.5, yMm: 100.9 } },
        { type: "line", from: { xMm: 73.5, yMm: 100.9 }, to: { xMm: 10, yMm: 100.9 } },
        { type: "line", from: { xMm: 10, yMm: 100.9 }, to: { xMm: 10, yMm: 12 } },
      ],
    }] });
    expect(comparePhysicalCutGeometryMm(curved, geometry(closedPolygon("rectangle", rectangle)), 0.001).status).toBe("not-compared");
  });
});
