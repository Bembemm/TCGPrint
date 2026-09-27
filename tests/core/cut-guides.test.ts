import { describe, expect, it } from "vitest";
import {
  CutGuideEngine,
  parseCutGuideConfig,
  type CutGuideConfig,
  type CutGuideCardMm,
  type CutGuideSegmentMm,
} from "../../core/geometry/cut-guides";
import { calculateGridPlacement, MAGIC_STANDARD_CARD, PAPER_FORMATS } from "../../core/geometry";

const PAGE = { widthMm: 210, heightMm: 297 };
const TRIM = { xMm: 10, yMm: 20, widthMm: 63.5, heightMm: 88.9 };

function guide(config: CutGuideConfig, cards = [{ trim: TRIM, bleedMm: 0 }]) {
  return new CutGuideEngine().generate({ cards, pageSizeMm: PAGE, config });
}

function sorted(segments: readonly CutGuideSegmentMm[]) {
  return [...segments].sort((a, b) => a.y1Mm - b.y1Mm || a.x1Mm - b.x1Mm || a.y2Mm - b.y2Mm || a.x2Mm - b.x2Mm);
}

function assertNoDuplicateSegments(segments: readonly CutGuideSegmentMm[]) {
  const keys = segments.map(({ x1Mm, y1Mm, x2Mm, y2Mm }) => {
    const first = `${x1Mm.toFixed(8)},${y1Mm.toFixed(8)}`;
    const second = `${x2Mm.toFixed(8)},${y2Mm.toFixed(8)}`;
    return first < second ? `${first}|${second}` : `${second}|${first}`;
  });
  expect(new Set(keys).size).toBe(keys.length);
}

function assertExternalStrokesClear(
  segments: readonly CutGuideSegmentMm[],
  cards: readonly CutGuideCardMm[],
  strokeWidthPt: number,
) {
  const radiusMm = strokeWidthPt * 25.4 / 72 / 2;
  for (const segment of segments) {
    const horizontal = Math.abs(segment.y2Mm - segment.y1Mm) < 1e-8;
    expect(horizontal || Math.abs(segment.x2Mm - segment.x1Mm) < 1e-8).toBe(true);
    for (const { trim, bleedMm } of cards) {
      const left = trim.xMm - bleedMm;
      const right = trim.xMm + trim.widthMm + bleedMm;
      const top = trim.yMm - bleedMm;
      const bottom = trim.yMm + trim.heightMm + bleedMm;
      const segmentLeft = Math.min(segment.x1Mm, segment.x2Mm) - (horizontal ? 0 : radiusMm);
      const segmentRight = Math.max(segment.x1Mm, segment.x2Mm) + (horizontal ? 0 : radiusMm);
      const segmentTop = Math.min(segment.y1Mm, segment.y2Mm) - (horizontal ? radiusMm : 0);
      const segmentBottom = Math.max(segment.y1Mm, segment.y2Mm) + (horizontal ? radiusMm : 0);
      const overlapX = Math.min(segmentRight, right) - Math.max(segmentLeft, left);
      const overlapY = Math.min(segmentBottom, bottom) - Math.max(segmentTop, top);
      expect(overlapX > 1e-8 && overlapY > 1e-8).toBe(false);
    }
  }
}

describe("CutGuideEngine physical geometry", () => {
  it("defaults both systems to OFF with safe physical control values", () => {
    expect(parseCutGuideConfig(undefined)).toEqual({
      trim: { enabled: false, extentMm: 1 },
      external: { enabled: false, strokeWidthPt: 0.3 },
    });
  });

  it("emits no paths when both independent guide systems are disabled", () => {
    expect(guide({ trim: { enabled: false, extentMm: 1 }, external: { enabled: false, strokeWidthPt: 0.3 } }))
      .toEqual({ trimSegments: [], externalSegments: [] });
  });

  it.each([1, 5])("measures trim corner segments as %s mm along the physical trim edges", (extentMm) => {
    const geometry = guide({
      trim: { enabled: true, extentMm },
      external: { enabled: false, strokeWidthPt: 0.3 },
    });
    const segments = sorted(geometry.trimSegments);

    expect(segments).toHaveLength(8);
    expect(segments[0]).toEqual({ x1Mm: 10, y1Mm: 20, x2Mm: 10 + extentMm, y2Mm: 20 });
    expect(segments.some((segment) => segment.x1Mm === 10 && segment.y1Mm === 20 && segment.x2Mm === 10 && segment.y2Mm === 20 + extentMm)).toBe(true);
    for (const segment of segments) {
      expect(Math.hypot(segment.x2Mm - segment.x1Mm, segment.y2Mm - segment.y1Mm)).toBeCloseTo(extentMm, 12);
    }
  });

  it("unions opposite trim corner intervals when they meet at the half-edge point", () => {
    const { trimSegments } = guide({
      trim: { enabled: true, extentMm: 31.75 },
      external: { enabled: false, strokeWidthPt: 0.3 },
    });
    const horizontal = trimSegments.filter(({ y1Mm, y2Mm }) => y1Mm === y2Mm);

    expect(horizontal).toHaveLength(2);
    expect(horizontal).toContainEqual({ x1Mm: 10, y1Mm: 20, x2Mm: 73.5, y2Mm: 20 });
    expect(horizontal).toContainEqual({ x1Mm: 10, y1Mm: 108.9, x2Mm: 73.5, y2Mm: 108.9 });
    assertNoDuplicateSegments(trimSegments);
  });

  it("draws exactly the four physical trim edges for full extent", () => {
    const { trimSegments } = guide({
      trim: { enabled: true, extentMm: "full" },
      external: { enabled: false, strokeWidthPt: 0.3 },
    });

    expect(sorted(trimSegments)).toEqual([
      { x1Mm: 10, y1Mm: 20, x2Mm: 73.5, y2Mm: 20 },
      { x1Mm: 10, y1Mm: 20, x2Mm: 10, y2Mm: 108.9 },
      { x1Mm: 73.5, y1Mm: 20, x2Mm: 73.5, y2Mm: 108.9 },
      { x1Mm: 10, y1Mm: 108.9, x2Mm: 73.5, y2Mm: 108.9 },
    ]);
    assertNoDuplicateSegments(trimSegments);
  });

  it.each([
    [0, 0.3],
    [0.625, 0.3],
    [1, 0.3],
    [2, 0.3],
    [3, 0.3],
    [0.625, 2],
  ])("clips external centerlines outside %s mm bleed with a %s pt stroke", (bleedMm, strokeWidthPt) => {
    const card = { trim: TRIM, bleedMm };
    const { externalSegments } = guide({
      trim: { enabled: false, extentMm: 1 },
      external: { enabled: true, strokeWidthPt },
    }, [card]);
    const radiusMm = strokeWidthPt * 25.4 / 72 / 2;
    const horizontalTop = externalSegments.filter(({ y1Mm, y2Mm }) => y1Mm === TRIM.yMm && y2Mm === TRIM.yMm);

    expect(horizontalTop).toHaveLength(2);
    expect(horizontalTop).toContainEqual({ x1Mm: radiusMm, y1Mm: TRIM.yMm, x2Mm: TRIM.xMm - bleedMm - radiusMm, y2Mm: TRIM.yMm });
    expect(horizontalTop).toContainEqual({ x1Mm: TRIM.xMm + TRIM.widthMm + bleedMm + radiusMm, y1Mm: TRIM.yMm, x2Mm: PAGE.widthMm - radiusMm, y2Mm: TRIM.yMm });
    assertExternalStrokesClear(externalSegments, [card], strokeWidthPt);
  });

  it.each([
    { trim: { enabled: true, extentMm: 2 }, external: { enabled: false, strokeWidthPt: 0.3 } },
    { trim: { enabled: false, extentMm: 2 }, external: { enabled: true, strokeWidthPt: 0.3 } },
    { trim: { enabled: true, extentMm: 2 }, external: { enabled: true, strokeWidthPt: 0.3 } },
  ] satisfies CutGuideConfig[])("keeps trim and external systems independent", (config) => {
    const geometry = guide(config);
    expect(geometry.trimSegments.length > 0).toBe(config.trim.enabled);
    expect(geometry.externalSegments.length > 0).toBe(config.external.enabled);
  });

  it("keeps external lines aligned to trim while clipping around every card bleed in a 3x3 sheet", () => {
    const bleedByCardMm = [0, 0.625, 1, 2, 3, 0.625, 1, 2, 3];
    const placement = calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      count: 9,
      bleedMm: 0,
      bleedByCardMm,
    });
    const cards: CutGuideCardMm[] = placement.slots.map((slot) => ({ trim: slot.trim, bleedMm: bleedByCardMm[slot.index] }));
    const { externalSegments } = new CutGuideEngine().generate({
      cards,
      pageSizeMm: PAGE,
      config: { trim: { enabled: false, extentMm: 1 }, external: { enabled: true, strokeWidthPt: 0.3 } },
    });
    const edgeCoordinates = new Set(cards.flatMap(({ trim }) => [
      trim.xMm, trim.xMm + trim.widthMm, trim.yMm, trim.yMm + trim.heightMm,
    ]));

    expect(externalSegments.length).toBeGreaterThan(10);
    for (const segment of externalSegments) {
      expect(edgeCoordinates.has(segment.x1Mm) || edgeCoordinates.has(segment.y1Mm)).toBe(true);
    }
    for (const coordinate of edgeCoordinates) {
      expect(externalSegments.some(({ x1Mm, y1Mm }) => x1Mm === coordinate || y1Mm === coordinate)).toBe(true);
    }
    assertNoDuplicateSegments(externalSegments);
    assertExternalStrokesClear(externalSegments, cards, 0.3);
    expect(externalSegments.some(({ x1Mm, x2Mm }) => Math.min(x1Mm, x2Mm) === 0)).toBe(false);
    expect(externalSegments.some(({ y1Mm, y2Mm }) => Math.min(y1Mm, y2Mm) === 0)).toBe(false);
  });

  it("consolidates near-identical external edge coordinates into one shared line", () => {
    const cards: CutGuideCardMm[] = [
      { trim: { xMm: 10, yMm: 20, widthMm: 63.5, heightMm: 88.9 }, bleedMm: 0 },
      { trim: { xMm: 73.5, yMm: 20 + 0.5e-9, widthMm: 63.5, heightMm: 88.9 }, bleedMm: 0 },
    ];
    const { externalSegments } = new CutGuideEngine().generate({
      cards,
      pageSizeMm: PAGE,
      config: { trim: { enabled: false, extentMm: 1 }, external: { enabled: true, strokeWidthPt: 0.3 } },
    });
    const horizontalCoordinates = externalSegments
      .filter(({ y1Mm, y2Mm }) => y1Mm === y2Mm)
      .map(({ y1Mm }) => y1Mm)
      .filter((coordinate, index, values) => values.indexOf(coordinate) === index)
      .sort((a, b) => a - b);

    for (let index = 1; index < horizontalCoordinates.length; index += 1) {
      expect(horizontalCoordinates[index] - horizontalCoordinates[index - 1]).toBeGreaterThan(1e-9);
    }
  });

  it.each([
    { trim: { enabled: true, extentMm: 0 }, external: { enabled: false, strokeWidthPt: 0.3 } },
    { trim: { enabled: true, extentMm: Number.NaN }, external: { enabled: false, strokeWidthPt: 0.3 } },
    { trim: { enabled: false, extentMm: 1 }, external: { enabled: true, strokeWidthPt: 0 } },
    { trim: { enabled: false, extentMm: 1 }, external: { enabled: true, strokeWidthPt: Number.POSITIVE_INFINITY } },
  ] satisfies CutGuideConfig[])("rejects invalid physical guide dimensions", (config) => {
    expect(() => guide(config)).toThrow(RangeError);
  });

  it("rejects overlapping physical trims before generating external paths", () => {
    expect(() => guide({
      trim: { enabled: true, extentMm: "full" },
      external: { enabled: true, strokeWidthPt: 0.3 },
    }, [
      { trim: TRIM, bleedMm: 0 },
      { trim: { xMm: 70, yMm: 20, widthMm: 63.5, heightMm: 88.9 }, bleedMm: 0 },
    ])).toThrow(/trim rectangles .* overlap/i);
  });
});
