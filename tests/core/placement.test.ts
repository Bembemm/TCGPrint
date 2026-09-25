import { describe, expect, it } from "vitest";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS } from "../../core/geometry";
import { calculateGridPlacement } from "../../core/geometry/placement";

describe("bleed-aware physical grid placement", () => {
  it("places nine Magic trims on A4 with 0.625 mm bleed and leaves no derivative overlap", () => {
    const layout = calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      count: 9,
      bleedMm: 0.625,
    });

    expect(layout).toMatchObject({ columns: 3, rows: 3, capacity: 9 });
    expect(layout.slots).toHaveLength(9);
    expect(layout.slots[0].trim.xMm).toBeCloseTo(8.5, 10);
    expect(layout.slots[0].trim.yMm).toBeCloseTo(13.9, 10);
    expect(layout.slots[0].trim.widthMm).toBe(63.5);
    expect(layout.slots[0].trim.heightMm).toBe(88.9);
    expect(layout.slots[1].trim.xMm - layout.slots[0].trim.xMm - 63.5).toBeCloseTo(1.25, 10);
    expect(layout.slots[3].trim.yMm - layout.slots[0].trim.yMm - 88.9).toBeCloseTo(1.25, 10);

    for (const slot of layout.slots) {
      expect(slot.trim.xMm - 0.625).toBeGreaterThanOrEqual(0);
      expect(slot.trim.yMm - 0.625).toBeGreaterThanOrEqual(0);
      expect(slot.trim.xMm + slot.trim.widthMm + 0.625).toBeLessThanOrEqual(210);
      expect(slot.trim.yMm + slot.trim.heightMm + 0.625).toBeLessThanOrEqual(297);
      expect(slot.trim.widthMm).toBe(63.5);
      expect(slot.trim.heightMm).toBe(88.9);
    }
  });

  it("centers the complete grid and does not move a single trim when symmetric bleed changes", () => {
    const placements = [0, 0.625, 1, 2, 3].map((bleedMm) => calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      count: 1,
      bleedMm,
    }).slots[0].trim);

    expect(placements.every((trim) =>
      Math.abs(trim.xMm - placements[0].xMm) < 1e-10 && Math.abs(trim.yMm - placements[0].yMm) < 1e-10,
    )).toBe(true);
    expect(placements[0]).toMatchObject({ xMm: 73.25, yMm: 104.05, widthMm: 63.5, heightMm: 88.9 });
  });

  it("rejects non-finite, negative, and non-integer placement inputs", () => {
    for (const bleedMm of [Number.NaN, Number.POSITIVE_INFINITY, -0.1]) {
      expect(() => calculateGridPlacement({ paper: PAPER_FORMATS.A4, card: MAGIC_STANDARD_CARD, count: 1, bleedMm }))
        .toThrow(RangeError);
    }
    expect(() => calculateGridPlacement({ paper: PAPER_FORMATS.A4, card: MAGIC_STANDARD_CARD, count: 1.5, bleedMm: 0 }))
      .toThrow(RangeError);
  });

  it("fails clearly instead of shrinking when the physical grid cannot fit", () => {
    expect(() => calculateGridPlacement({
      paper: { name: "Small sheet", widthMm: 63.5, heightMm: 88.9 },
      card: MAGIC_STANDARD_CARD,
      count: 1,
      bleedMm: 0.625,
    })).toThrow(/no physical card slot fits/i);
  });
});
