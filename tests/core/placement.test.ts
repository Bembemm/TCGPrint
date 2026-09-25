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

  it("fits mixed 0 mm and 3 mm bleed on one Letter page without overlapping derivatives", () => {
    const bleedByCardMm = [3, ...Array.from({ length: 8 }, () => 0)];
    const layout = calculateGridPlacement({
      paper: { name: "Letter", widthMm: 215.9, heightMm: 279.4 },
      card: MAGIC_STANDARD_CARD,
      count: 9,
      bleedMm: 0,
      bleedByCardMm,
    });

    expect(layout).toMatchObject({ columns: 3, rows: 3 });
    expect(layout.slots).toHaveLength(9);
    for (let index = 0; index < layout.slots.length; index += 1) {
      const slot = layout.slots[index];
      const bleed = bleedByCardMm[index];
      expect(slot.trim.xMm - bleed).toBeGreaterThanOrEqual(-1e-9);
      expect(slot.trim.yMm - bleed).toBeGreaterThanOrEqual(-1e-9);
      expect(slot.trim.xMm + slot.trim.widthMm + bleed).toBeLessThanOrEqual(215.9 + 1e-9);
      expect(slot.trim.yMm + slot.trim.heightMm + bleed).toBeLessThanOrEqual(279.4 + 1e-9);
      expect(slot.trim.widthMm).toBe(63.5);
      expect(slot.trim.heightMm).toBe(88.9);

      const right = layout.slots.find((candidate) => candidate.row === slot.row && candidate.column === slot.column + 1);
      if (right) {
        const rightIndex = layout.slots.indexOf(right);
        expect(slot.trim.xMm + slot.trim.widthMm + bleed + bleedByCardMm[rightIndex])
          .toBeLessThanOrEqual(right.trim.xMm + 1e-9);
      }
      const below = layout.slots.find((candidate) => candidate.column === slot.column && candidate.row === slot.row + 1);
      if (below) {
        const belowIndex = layout.slots.indexOf(below);
        expect(slot.trim.yMm + slot.trim.heightMm + bleed + bleedByCardMm[belowIndex])
          .toBeLessThanOrEqual(below.trim.yMm + 1e-9);
      }
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
