import { describe, expect, it } from "vitest";
import {
  CutGuideEngine,
  type CutGuideConfig,
  type CutGuideStyle,
  type TrimRectangleMm,
} from "../../core/geometry/cut-guides";

const STYLE: CutGuideStyle = {
  color: "#123456",
  strokeWidthMm: 0.2,
  opacity: 0.75,
  lineStyle: "dashed",
};

const TRIM: TrimRectangleMm = {
  xMm: 10,
  yMm: 20,
  widthMm: 63.5,
  heightMm: 88.9,
};

const PAGE = { widthMm: 210, heightMm: 297 };

function createGuides(config: CutGuideConfig, trims: readonly TrimRectangleMm[] = [TRIM]) {
  return new CutGuideEngine().generate({ trims, pageSizeMm: PAGE, config });
}

describe("CutGuideEngine physical geometry", () => {
  it("none emits no vector segments", () => {
    expect(createGuides({ mode: "none", style: STYLE }).segments).toEqual([]);
  });

  it("corners emits two offset outside crop segments at each trim corner", () => {
    const { segments } = createGuides({
      mode: "corners",
      style: STYLE,
      externalLengthMm: 2,
      internalLengthMm: 1,
      offsetMm: 0.5,
    });

    expect(segments).toHaveLength(8);
    expect(segments).toContainEqual({ x1Mm: 8, y1Mm: 19.5, x2Mm: 11, y2Mm: 19.5 });
    expect(segments).toContainEqual({ x1Mm: 9.5, y1Mm: 18, x2Mm: 9.5, y2Mm: 21 });
    for (const segment of segments) {
      expect(
        segment.x1Mm < TRIM.xMm
        || segment.x1Mm > TRIM.xMm + TRIM.widthMm
        || segment.y1Mm < TRIM.yMm
        || segment.y1Mm > TRIM.yMm + TRIM.heightMm,
      ).toBe(true);
    }
  });

  it("sides centers four independent marks on trim sides", () => {
    const { segments } = createGuides({
      mode: "sides",
      style: STYLE,
      externalLengthMm: 2,
      internalLengthMm: 1,
      offsetMm: 0.5,
    });

    expect(segments).toHaveLength(8);
    expect(segments).toContainEqual({ x1Mm: 41.75, y1Mm: 17.5, x2Mm: 41.75, y2Mm: 19.5 });
    expect(segments).toContainEqual({ x1Mm: 41.75, y1Mm: 20, x2Mm: 41.75, y2Mm: 21 });
    expect(segments).toContainEqual({ x1Mm: 7.5, y1Mm: 64.45, x2Mm: 9.5, y2Mm: 64.45 });
  });

  it("cross centers a pair of vector arms on each trim vertex", () => {
    const { segments } = createGuides({ mode: "cross", style: STYLE, armLengthMm: 1.25 });

    expect(segments).toHaveLength(8);
    expect(segments).toContainEqual({ x1Mm: 8.75, y1Mm: 20, x2Mm: 11.25, y2Mm: 20 });
    expect(segments).toContainEqual({ x1Mm: 10, y1Mm: 18.75, x2Mm: 10, y2Mm: 21.25 });
    expect(segments).toContainEqual({ x1Mm: 72.25, y1Mm: 108.9, x2Mm: 74.75, y2Mm: 108.9 });
  });

  it("full follows the four trim boundaries exactly", () => {
    const { segments } = createGuides({ mode: "full", style: STYLE });

    expect(segments).toEqual([
      { x1Mm: 10, y1Mm: 20, x2Mm: 73.5, y2Mm: 20 },
      { x1Mm: 10, y1Mm: 108.9, x2Mm: 73.5, y2Mm: 108.9 },
      { x1Mm: 10, y1Mm: 20, x2Mm: 10, y2Mm: 108.9 },
      { x1Mm: 73.5, y1Mm: 20, x2Mm: 73.5, y2Mm: 108.9 },
    ]);
  });

  it("guillotine spans the page at unique trim boundary coordinates", () => {
    const trims: readonly TrimRectangleMm[] = [
      { xMm: 10, yMm: 20, widthMm: 10, heightMm: 20 },
      { xMm: 20, yMm: 20, widthMm: 10, heightMm: 20 },
    ];
    const { segments } = createGuides({ mode: "guillotine", style: STYLE }, trims);

    expect(segments).toEqual([
      { x1Mm: 10, y1Mm: 0, x2Mm: 10, y2Mm: 297 },
      { x1Mm: 20, y1Mm: 0, x2Mm: 20, y2Mm: 297 },
      { x1Mm: 30, y1Mm: 0, x2Mm: 30, y2Mm: 297 },
      { x1Mm: 0, y1Mm: 20, x2Mm: 210, y2Mm: 20 },
      { x1Mm: 0, y1Mm: 40, x2Mm: 210, y2Mm: 40 },
    ]);
  });

  it("keeps the trim rectangle unchanged regardless of any external bleed extent", () => {
    const { segments } = createGuides({ mode: "full", style: STYLE });
    const xs = [...new Set(segments.flatMap(({ x1Mm, x2Mm }) => [x1Mm, x2Mm]))].sort((a, b) => a - b);
    const ys = [...new Set(segments.flatMap(({ y1Mm, y2Mm }) => [y1Mm, y2Mm]))].sort((a, b) => a - b);

    expect(xs).toEqual([10, 73.5]);
    expect(ys).toEqual([20, 108.9]);
    expect(xs[1] - xs[0]).toBe(63.5);
    expect(ys[1] - ys[0]).toBeCloseTo(88.9, 12);
  });

  it.each([
    ["NaN stroke", { ...STYLE, strokeWidthMm: Number.NaN }],
    ["zero stroke", { ...STYLE, strokeWidthMm: 0 }],
    ["negative stroke", { ...STYLE, strokeWidthMm: -0.2 }],
    ["infinite opacity", { ...STYLE, opacity: Number.POSITIVE_INFINITY }],
    ["opacity above one", { ...STYLE, opacity: 1.01 }],
    ["invalid color", { ...STYLE, color: "black" }],
    ["invalid line style", { ...STYLE, lineStyle: "wavy" }],
  ])("rejects %s", (_name, style) => {
    expect(() => createGuides({ mode: "full", style: style as CutGuideStyle })).toThrow(RangeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1])("rejects impossible corner geometry (%s)", (length) => {
    expect(() => createGuides({
      mode: "corners",
      style: STYLE,
      externalLengthMm: length,
      internalLengthMm: 0,
      offsetMm: 0.5,
    })).toThrow(RangeError);
  });

  it("rejects marks that extend beyond the physical sheet", () => {
    expect(() => createGuides({
      mode: "corners",
      style: STYLE,
      externalLengthMm: 20,
      internalLengthMm: 1,
      offsetMm: 1,
    })).toThrow(/outside page bounds/i);
  });
});
