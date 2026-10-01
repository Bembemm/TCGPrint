import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_DXF_CUT_LIMITS, parseDxfCutGeometry } from "../../services/cut-geometry/dxf-parser";
import { exportCutGeometryToDxf } from "../../services/cut-geometry/dxf-export";
import { DEFAULT_SVG_CUT_LIMITS, parseSvgCutGeometry } from "../../services/cut-geometry/svg-parser";
import { exportCutGeometryToSvg } from "../../services/cut-geometry/svg-export";
import { compareCutGeometryMm, type CutSourceIdentity } from "../../core/cut";

const identity: CutSourceIdentity = {
  kind: "template-file",
  templateId: "fixture-template",
  version: "1",
  packageHash: "a".repeat(64),
  fileId: "fixture-file",
  fileHash: "b".repeat(64),
};
const pageSizeMm = { widthMm: 210, heightMm: 297 };

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(process.cwd(), "tests/fixtures/cut", name)));
}

describe("safe SVG cut source parser", () => {
  it("parses physical millimeter dimensions, groups, and composed transforms", async () => {
    const geometry = parseSvgCutGeometry(await fixture("svg-mm-transform.svg"), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(geometry.pageSizeMm).toEqual(pageSizeMm);
    expect(geometry.paths).toHaveLength(1);
    expect(geometry.paths[0]).toMatchObject({ id: "card-0", closed: true, boundsMm: { xMm: 10, yMm: 12, widthMm: 63.5, heightMm: 88.9 } });
  });

  it("uses viewBox with SVG/CSS 96-dpi px conversion", async () => {
    const geometry = parseSvgCutGeometry(await fixture("svg-px-viewbox.svg"), { source: identity, expectedPageSizeMm: { widthMm: 25.4, heightMm: 50.8 } });
    expect(geometry.pageSizeMm.widthMm).toBeCloseTo(25.4, 7);
    expect(geometry.paths[0]!.boundsMm.xMm).toBeCloseTo(2.54, 7);
  });

  it("applies the outer SVG transform outside the viewBox in CSS pixel units", async () => {
    const geometry = parseSvgCutGeometry(await fixture("svg-root-transform.svg"), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(geometry.paths[0]!.boundsMm.xMm).toBeCloseTo(10 * 25.4 / 96, 9);
    expect(geometry.paths[0]!.boundsMm.yMm).toBeCloseTo(20 * 25.4 / 96, 9);
    expect(geometry.paths[0]!.boundsMm.widthMm).toBeCloseTo(10, 9);
    expect(geometry.paths[0]!.boundsMm.heightMm).toBeCloseTo(10, 9);
  });

  it.each([
    ["25.4mm", "50.8mm"],
    ["2.54cm", "5.08cm"],
    ["1in", "2in"],
    ["72pt", "144pt"],
    ["6pc", "12pc"],
    ["96px", "192px"],
  ])("converts SVG physical viewport lengths %s × %s to millimeters", (width, height) => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1 2"><rect x="0" y="0" width="1" height="2" /></svg>`;
    const geometry = parseSvgCutGeometry(new TextEncoder().encode(source), { source: identity, expectedPageSizeMm: { widthMm: 25.4, heightMm: 50.8 } });
    expect(geometry.pageSizeMm).toEqual({ widthMm: 25.4, heightMm: 50.8 });
    expect(geometry.paths[0]!.boundsMm).toEqual({ xMm: 0, yMm: 0, widthMm: 25.4, heightMm: 50.8 });
  });

  it("preserves SVG path cubic, quadratic, and arc curves", async () => {
    const geometry = parseSvgCutGeometry(await fixture("svg-path-curves.svg"), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(geometry.paths).toHaveLength(1);
    expect(geometry.paths[0]!.segments.map(({ type }) => type)).toEqual(["cubic", "quadratic", "arc"]);
  });

  it("parses transformed rect, line, polyline, and polygon shapes into stable paths", async () => {
    const geometry = parseSvgCutGeometry(await fixture("svg-shapes-transforms.svg"), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(geometry.paths.map(({ id }) => id)).toEqual(["rect", "line", "polyline", "polygon", "matrix-rotate"]);
    expect(geometry.paths[0]!.boundsMm).toEqual({ xMm: 10, yMm: 12, widthMm: 63.5, heightMm: 88.9 });
    expect(geometry.paths[0]!.segments).toHaveLength(4);
    expect(geometry.paths[0]!.segments.every(({ from, to }) => Math.hypot(from.xMm - to.xMm, from.yMm - to.yMm) > 0)).toBe(true);
    expect(geometry.paths[2]!.segments).toHaveLength(2);
    expect(geometry.paths[3]!.closed).toBe(true);
  });

  it("preserves smooth SVG curve commands and rejects bounded complexity overflow", async () => {
    const bytes = await fixture("svg-complex.svg");
    const geometry = parseSvgCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(geometry.paths[0]!.segments.map(({ type }) => type)).toEqual(["cubic", "quadratic", "arc"]);
    expect(() => parseSvgCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm }, { ...DEFAULT_SVG_CUT_LIMITS, maxSegments: 2 })).toThrow(/safety limit|segments/i);
    const rootAndChildTransforms = `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" transform="${"translate(0 0) ".repeat(256)}"><rect transform="translate(0 0)" x="1" y="1" width="2" height="2" /></svg>`;
    expect(() => parseSvgCutGeometry(new TextEncoder().encode(rootAndChildTransforms), { source: identity, expectedPageSizeMm: pageSizeMm })).toThrow(/transforms/i);
  });

  it("rejects SVG input above the configured byte and XML depth limits", async () => {
    const bytes = await fixture("svg-mm-transform.svg");
    expect(() => parseSvgCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm }, { ...DEFAULT_SVG_CUT_LIMITS, maxBytes: bytes.byteLength - 1 })).toThrow(/limit/i);
    const nested = `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm"><g><g><g><rect x="1" y="1" width="2" height="2" /></g></g></g></svg>`;
    expect(() => parseSvgCutGeometry(new TextEncoder().encode(nested), { source: identity, expectedPageSizeMm: pageSizeMm }, { ...DEFAULT_SVG_CUT_LIMITS, maxDepth: 2 })).toThrow(/depth|deep|limit/i);
  });

  it.each([
    ["svg-malformed.svg", /well formed/i],
    ["svg-external.svg", /unsupported|external|resource/i],
    ["svg-script.svg", /unsupported/i],
    ["svg-style.svg", /unsupported/i],
    ["svg-unsupported.svg", /unsupported/i],
    ["svg-ambiguous.svg", /physical|dimension|unit/i],
  ])("rejects unsafe or ambiguous input %s", async (name, error) => {
    await expect(fixture(name).then((bytes) => parseSvgCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm }))).rejects.toThrow(error);
  });
});

describe("bounded DXF cut parser and deterministic exporters", () => {
  it("parses millimeter LINE/LWPOLYLINE and converts CAD Y-up to page Y-down", async () => {
    const geometry = parseDxfCutGeometry(await fixture("dxf-mm-polyline.dxf"), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(geometry.paths).toHaveLength(2);
    expect(geometry.paths[1]).toMatchObject({ closed: true, boundsMm: { xMm: 10, yMm: 12, widthMm: 63.5, heightMm: 88.9 } });
  });

  it("preserves bulge, ARC, CIRCLE, and ELLIPSE source curves before export", async () => {
    const geometry = parseDxfCutGeometry(await fixture("dxf-polyline-curve.dxf"), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(geometry.paths.map(({ id }) => id)).toEqual(["dxf-20", "dxf-21", "dxf-22", "dxf-23"]);
    expect(geometry.paths[0]!.segments[0]!.type).toBe("arc");
    expect(geometry.paths.slice(1).map(({ segments }) => segments[0]!.type)).toEqual(["arc", "arc", "arc"]);
    expect(geometry.paths[2]!.closed).toBe(true);
  });

  it("requires explicit units when $INSUNITS is absent", async () => {
    const bytes = await fixture("dxf-unitless.dxf");
    expect(() => parseDxfCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm })).toThrow(/units.*explicit|unit override/i);
    expect(parseDxfCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm, unitsOverride: "mm" }).paths).toHaveLength(1);
  });

  it("rejects a malformed $INSUNITS declaration instead of treating it as absent", async () => {
    const bytes = await fixture("dxf-incomplete-insunits.dxf");
    expect(() => parseDxfCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm, unitsOverride: "mm" })).toThrow(/INSUNITS.*group-code 70/i);
  });

  it("rejects paper-space entities because the supported source is model-space page geometry", async () => {
    const bytes = await fixture("dxf-paperspace.dxf");
    expect(() => parseDxfCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm })).toThrow(/paper.space|layout/i);
  });

  it("rejects non-default layers when no LAYER table can verify their visibility", async () => {
    const bytes = await fixture("dxf-unknown-layer-no-table.dxf");
    expect(() => parseDxfCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm })).toThrow(/without a LAYER table.*visibility/i);
  });

  it.each([
    ["dxf-unsupported.dxf", /unsupported.*entity/i],
    ["dxf-truncated.dxf", /malformed|truncated/i],
  ])("rejects unsupported and malformed DXF input %s", async (name, error) => {
    const bytes = await fixture(name);
    expect(() => parseDxfCutGeometry(bytes, { source: identity, expectedPageSizeMm: pageSizeMm })).toThrow(error);
  });

  it("rejects width-affecting DXF entities and bounded entity overflow", async () => {
    const widthBearing = await fixture("dxf-polyline-width.dxf");
    const classicWidthBearing = await fixture("dxf-polyline-header-width.dxf");
    const tooManyEntities = await fixture("dxf-mm-polyline.dxf");
    expect(() => parseDxfCutGeometry(widthBearing, { source: identity, expectedPageSizeMm: pageSizeMm })).toThrow(/unsupported.*width/i);
    expect(() => parseDxfCutGeometry(classicWidthBearing, { source: identity, expectedPageSizeMm: pageSizeMm })).toThrow(/unsupported.*width/i);
    expect(() => parseDxfCutGeometry(tooManyEntities, { source: identity, expectedPageSizeMm: pageSizeMm }, { ...DEFAULT_DXF_CUT_LIMITS, maxEntities: 1 })).toThrow(/safety limit|entities/i);
    expect(() => parseDxfCutGeometry(widthBearing, { source: identity, expectedPageSizeMm: pageSizeMm }, { ...DEFAULT_DXF_CUT_LIMITS, maxBytes: 12 })).toThrow(/limit/i);
  });

  it("converts explicit DXF inch units to millimeters", async () => {
    const geometry = parseDxfCutGeometry(await fixture("dxf-inches-line.dxf"), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(geometry.paths[0]!.boundsMm.widthMm).toBeCloseTo(25.4, 8);
    expect(geometry.paths[0]!.boundsMm.heightMm).toBe(0);
  });

  it("round-trips geometry deterministically through SVG within serialization precision", async () => {
    const original = parseSvgCutGeometry(await fixture("svg-mm-transform.svg"), { source: identity, expectedPageSizeMm: pageSizeMm });
    const svg = exportCutGeometryToSvg(original);
    const repeated = exportCutGeometryToSvg(original);
    const roundTrip = parseSvgCutGeometry(new TextEncoder().encode(svg), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(svg).toBe(repeated);
    expect(compareCutGeometryMm(original, roundTrip, 0.000001).equal).toBe(true);
    expect(svg).not.toMatch(/<script|href=|foreignObject/i);
  });

  it("round-trips an arc after a non-orthogonal affine transform without changing its curve", async () => {
    const original = parseSvgCutGeometry(await fixture("svg-sheared-arc.svg"), { source: identity, expectedPageSizeMm: pageSizeMm });
    const output = exportCutGeometryToSvg(original);
    const roundTrip = parseSvgCutGeometry(new TextEncoder().encode(output), { source: identity, expectedPageSizeMm: pageSizeMm });
    const before = original.paths[0]!.segments[0]!;
    const after = roundTrip.paths[0]!.segments[0]!;
    if (before.type !== "arc" || after.type !== "arc") throw new Error("Expected one elliptical arc on both sides of the round trip.");
    const pointAt = (segment: typeof before, t: number) => {
      const angle = segment.startAngleRad + segment.sweepAngleRad * t;
      return {
        xMm: segment.center.xMm + segment.axisU.xMm * Math.cos(angle) + segment.axisV.xMm * Math.sin(angle),
        yMm: segment.center.yMm + segment.axisU.yMm * Math.cos(angle) + segment.axisV.yMm * Math.sin(angle),
      };
    };
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const expected = pointAt(before, t);
      const actual = pointAt(after, t);
      expect(Math.abs(actual.xMm - expected.xMm)).toBeLessThanOrEqual(0.000001);
      expect(Math.abs(actual.yMm - expected.yMm)).toBeLessThanOrEqual(0.000001);
    }
  });

  it("keeps large rotated ellipses within the declared SVG round-trip tolerance", () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg" width="2000mm" height="2000mm" viewBox="0 0 2000 2000"><ellipse cx="1000" cy="1000" rx="1000" ry="500" transform="rotate(17.1234567 1000 1000)" /></svg>`;
    const original = parseSvgCutGeometry(new TextEncoder().encode(input), { source: identity, expectedPageSizeMm: { widthMm: 2_000, heightMm: 2_000 } });
    const output = exportCutGeometryToSvg(original);
    const roundTrip = parseSvgCutGeometry(new TextEncoder().encode(output), { source: identity, expectedPageSizeMm: { widthMm: 2_000, heightMm: 2_000 } });
    const before = original.paths[0]!.segments[0]!;
    const after = roundTrip.paths[0]!.segments;
    if (before.type !== "arc" || after.some((segment) => segment.type !== "arc")) throw new Error("Expected ellipse arcs on both sides of the round trip.");
    const pointAt = (segment: typeof before, t: number) => {
      const angle = segment.startAngleRad + segment.sweepAngleRad * t;
      return {
        xMm: segment.center.xMm + segment.axisU.xMm * Math.cos(angle) + segment.axisV.xMm * Math.sin(angle),
        yMm: segment.center.yMm + segment.axisU.yMm * Math.cos(angle) + segment.axisV.yMm * Math.sin(angle),
      };
    };

    expect(output).toContain("17.1234567");
    expect(after).toHaveLength(2);
    for (const t of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]) {
      const expected = pointAt(before, t);
      const segmentIndex = Math.min(Math.floor(t * after.length), after.length - 1);
      const localT = t === 1 ? 1 : t * after.length - segmentIndex;
      const actual = pointAt(after[segmentIndex] as typeof before, localT);
      expect(Math.abs(actual.xMm - expected.xMm)).toBeLessThanOrEqual(0.000001);
      expect(Math.abs(actual.yMm - expected.yMm)).toBeLessThanOrEqual(0.000001);
    }
  });

  it("round-trips canonical paths through deterministic unit-declared DXF", async () => {
    const original = parseDxfCutGeometry(await fixture("dxf-mm-polyline.dxf"), { source: identity, expectedPageSizeMm: pageSizeMm });
    const dxf = exportCutGeometryToDxf(original);
    const roundTrip = parseDxfCutGeometry(new TextEncoder().encode(dxf), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(dxf).toBe(exportCutGeometryToDxf(original));
    expect(dxf).toContain("$INSUNITS\n70\n4");
    expect(compareCutGeometryMm(original, roundTrip, 0.000001).equal).toBe(true);
  });

  it("round-trips DXF curves with fixed bounded chord approximation", async () => {
    const original = parseDxfCutGeometry(await fixture("dxf-polyline-curve.dxf"), { source: identity, expectedPageSizeMm: pageSizeMm });
    const output = exportCutGeometryToDxf(original);
    const roundTrip = parseDxfCutGeometry(new TextEncoder().encode(output), { source: identity, expectedPageSizeMm: pageSizeMm });
    expect(output).toBe(exportCutGeometryToDxf(original));
    expect(roundTrip.paths).toHaveLength(original.paths.length);
    for (let index = 0; index < original.paths.length; index += 1) {
      const before = original.paths[index]!;
      const after = roundTrip.paths[index]!;
      expect(after.closed).toBe(before.closed);
      for (const field of ["xMm", "yMm", "widthMm", "heightMm"] as const) {
        expect(Math.abs(after.boundsMm[field] - before.boundsMm[field])).toBeLessThanOrEqual(0.005001);
      }
      expect(after.start.xMm).toBeCloseTo(before.start.xMm, 6);
      expect(after.start.yMm).toBeCloseTo(before.start.yMm, 6);
    }
  });
});
