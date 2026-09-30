import { describe, expect, it } from "vitest";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS } from "../../core/geometry";
import { calculateGridPlacement } from "../../core/geometry/placement";
import { generateRegistrationGeometry } from "../../core/registration";

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

  it("does not reserve the maximum card bleed in every row and column for an unrelated reserved zone", () => {
    const layout = calculateGridPlacement({
      paper: { name: "Letter", widthMm: 215.9, heightMm: 279.4 },
      card: MAGIC_STANDARD_CARD,
      count: 9,
      bleedMm: 0,
      bleedByCardMm: [3, 0, 0, 0, 0, 0, 0, 0, 0],
      reservedZonesMm: [{ xMm: 1, yMm: 1, widthMm: 2, heightMm: 2 }],
    });

    expect(layout).toMatchObject({ columns: 3, rows: 3, capacity: 9 });
    expect(layout.slots).toHaveLength(9);
    expect(layout.slots[0]!.trim.widthMm).toBe(63.5);
    expect(layout.slots[0]!.trim.heightMm).toBe(88.9);
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

  it("keeps page, card, and registration orientations independent", () => {
    const landscapeCards = calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      pageOrientation: "landscape",
      card: MAGIC_STANDARD_CARD,
      cardOrientation: "portrait",
      count: 1,
      bleedMm: 0,
    });
    const portraitCards = calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      pageOrientation: "portrait",
      card: MAGIC_STANDARD_CARD,
      cardOrientation: "portrait",
      count: 1,
      bleedMm: 0,
    });

    expect(landscapeCards.pageSizeMm).toEqual({ widthMm: 297, heightMm: 210 });
    expect(landscapeCards.slots[0].trim).toMatchObject({ widthMm: 63.5, heightMm: 88.9 });
    expect(portraitCards.pageSizeMm).toEqual({ widthMm: 210, heightMm: 297 });
    expect(portraitCards.slots[0].trim).toMatchObject({ widthMm: 63.5, heightMm: 88.9 });
  });

  it("respects all physical page margins when centering fixed layout geometry", () => {
    const layout = calculateGridPlacement({
      paper: { name: "Margins", widthMm: 100, heightMm: 100 },
      card: { id: "rect", name: "Rectangle", widthMm: 20, heightMm: 30 },
      count: 1,
      bleedMm: 0,
      rows: 1,
      columns: 1,
      marginsMm: { top: 10, right: 5, bottom: 20, left: 15 },
    });

    expect(layout.slots[0]!.trim).toEqual({ xMm: 45, yMm: 30, widthMm: 20, heightMm: 30 });
  });

  it("places horizontal and vertical gaps independently without shrinking cards", () => {
    const layout = calculateGridPlacement({
      paper: { name: "Gaps", widthMm: 100, heightMm: 100 },
      card: { id: "square", name: "Square", widthMm: 20, heightMm: 20 },
      count: 4,
      bleedMm: 1,
      rows: 2,
      columns: 2,
      horizontalGapMm: 10,
      verticalGapMm: 8,
    });

    expect(layout.gridWidthMm).toBe(54);
    expect(layout.gridHeightMm).toBe(52);
    expect(layout.gridSlots.map(({ trim }) => [trim.xMm, trim.yMm, trim.widthMm, trim.heightMm])).toEqual([
      [24, 25, 20, 20],
      [56, 25, 20, 20],
      [24, 55, 20, 20],
      [56, 55, 20, 20],
    ]);
  });

  it("uses exact template slot positions, stable indexes, and validates margins, gaps, bleed, and reserved zones", () => {
    const templateGeometry = {
      orientation: "portrait" as const,
      cardOrientation: "portrait" as const,
      pageSizeMm: { widthMm: 100, heightMm: 100 },
      cardSizeMm: { widthMm: 20, heightMm: 30 },
      rows: 2,
      columns: 2,
      slots: [
        { index: 0, row: 0, column: 0, xMm: 10, yMm: 10 },
        { index: 1, row: 0, column: 1, xMm: 40, yMm: 10 },
        { index: 2, row: 1, column: 0, xMm: 10, yMm: 60 },
        { index: 3, row: 1, column: 1, xMm: 40, yMm: 60 },
      ],
    };
    const layout = calculateGridPlacement({
      paper: { name: "template", widthMm: 100, heightMm: 100 },
      card: { id: "template-card", name: "template card", widthMm: 20, heightMm: 30 },
      count: 2,
      bleedMm: 1,
      templateGeometry,
      skippedSlotIndices: [1],
      marginsMm: { top: 5, right: 5, bottom: 5, left: 5 },
      horizontalGapMm: 8,
      verticalGapMm: 8,
      reservedZonesMm: [{ xMm: 55, yMm: 70, widthMm: 10, heightMm: 10 }],
    });

    expect(layout).toMatchObject({ columns: 2, rows: 2, capacity: 2 });
    expect(layout.gridSlots.map(({ index, trim, skippedByUser, cardIndex }) => ({ index, trim, skippedByUser, cardIndex }))).toEqual([
      { index: 0, trim: { xMm: 10, yMm: 10, widthMm: 20, heightMm: 30 }, skippedByUser: false, cardIndex: 0 },
      { index: 1, trim: { xMm: 40, yMm: 10, widthMm: 20, heightMm: 30 }, skippedByUser: true, cardIndex: undefined },
      { index: 2, trim: { xMm: 10, yMm: 60, widthMm: 20, heightMm: 30 }, skippedByUser: false, cardIndex: 1 },
      { index: 3, trim: { xMm: 40, yMm: 60, widthMm: 20, heightMm: 30 }, skippedByUser: false, cardIndex: undefined },
    ]);
    expect(layout.gridSlots[3]!.reserved).toBe(true);
    expect(layout.slots).toHaveLength(2);
  });

  it("rejects template slots outside physical limits or overlapping registration zones", () => {
    const templateGeometry = {
      orientation: "portrait" as const,
      cardOrientation: "portrait" as const,
      pageSizeMm: { widthMm: 100, heightMm: 120 },
      cardSizeMm: { widthMm: 20, heightMm: 30 },
      rows: 1,
      columns: 1,
      slots: [{ index: 0, row: 0, column: 0, xMm: 10, yMm: 10 }],
    };
    const request = {
      paper: { name: "template", widthMm: 100, heightMm: 120 },
      card: { id: "template-card", name: "template card", widthMm: 20, heightMm: 30 },
      count: 1,
      bleedMm: 0,
      templateGeometry,
    };

    expect(() => calculateGridPlacement({ ...request, reservedZonesMm: [{ xMm: 9, yMm: 9, widthMm: 4, heightMm: 4 }] }))
      .toThrow(/reserved zone/i);
    const rotated = calculateGridPlacement({ ...request, pageOrientation: "landscape", cardOrientation: "landscape" });
    expect(rotated.pageSizeMm).toEqual({ widthMm: 120, heightMm: 100 });
    expect(rotated.slots[0]!.trim).toEqual({ xMm: 80, yMm: 10, widthMm: 30, heightMm: 20 });
    expect(() => calculateGridPlacement({ ...request, cardOrientation: "landscape" }))
      .toThrow(/template card dimensions/i);
  });

  it("returns a clear error when requested gaps leave no room for the fixed grid", () => {
    expect(() => calculateGridPlacement({
      paper: { name: "Gaps", widthMm: 100, heightMm: 50 },
      card: { id: "rect", name: "Rectangle", widthMm: 43, heightMm: 20 },
      count: 2,
      bleedMm: 0,
      rows: 1,
      columns: 2,
      horizontalGapMm: 15,
    })).toThrow(/configured margins, bleed, and gaps.*card size and bleed were preserved/i);
  });

  it("keeps slot IDs stable and fills only active row-major slots after skips", () => {
    const layout = calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      cardOrientation: "portrait",
      count: 8,
      bleedMm: 0,
      rows: 3,
      columns: 3,
      skippedSlotIndices: [4],
    });

    expect(layout.capacity).toBe(8);
    expect(layout.gridSlots.map(({ index, skippedByUser }) => [index, skippedByUser])).toEqual([
      [0, false], [1, false], [2, false], [3, false], [4, true], [5, false], [6, false], [7, false], [8, false],
    ]);
    expect(layout.slots.map(({ index, cardIndex }) => [index, cardIndex])).toEqual([
      [0, 0], [1, 1], [2, 2], [3, 3], [5, 4], [6, 5], [7, 6], [8, 7],
    ]);
    expect(layout.gridSlots[3]?.trim).toEqual(layout.slots[3]?.trim);
    expect(layout.gridSlots[5]?.trim).toEqual(layout.slots[4]?.trim);
  });

  it("requires a fixed grid before accepting skipped slots in automatic layout", () => {
    expect(() => calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      count: 2,
      bleedMm: 0,
      skippedSlotIndices: [0],
    })).toThrow(/skipped slots require .*fixed grid/i);
  });

  it("keeps every physical slot at the same coordinates when fixed-grid skips change card assignment", () => {
    const request = {
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      cardOrientation: "portrait" as const,
      count: 3,
      bleedMm: 0,
      rows: 2,
      columns: 2,
    };
    const before = calculateGridPlacement(request);
    const after = calculateGridPlacement({ ...request, skippedSlotIndices: [1] });

    expect(after.capacity).toBe(3);
    expect(after.gridSlots.map(({ trim }) => trim)).toEqual(before.gridSlots.map(({ trim }) => trim));
    expect(after.slots.map(({ index, cardIndex }) => [index, cardIndex])).toEqual([[0, 0], [2, 1], [3, 2]]);
  });

  it("does not shift fixed slot geometry when skips reassign cards with different bleed", () => {
    const request = {
      paper: { name: "100 × 50 mm", widthMm: 100, heightMm: 50 },
      card: { id: "small", name: "20 × 30 mm", widthMm: 20, heightMm: 30 },
      count: 1,
      bleedMm: 0,
      bleedByCardMm: [3],
      rows: 1,
      columns: 3,
    };
    const before = calculateGridPlacement(request);
    const after = calculateGridPlacement({ ...request, skippedSlotIndices: [0] });

    expect(after.gridSlots.map(({ trim }) => trim)).toEqual(before.gridSlots.map(({ trim }) => trim));
    expect(after.slots.map(({ index, cardIndex }) => [index, cardIndex])).toEqual([[1, 0]]);

    expect(() => calculateGridPlacement({ ...request, count: 2, bleedByCardMm: [3, 0], skippedSlotIndices: [0] }))
      .toThrow(/no physical card slot fits.*bleed.*preserved/i);
  });

  it("searches enough automatic positions when a large reserved zone blocks many candidate slots", () => {
    const layout = calculateGridPlacement({
      paper: { name: "100 mm square", widthMm: 100, heightMm: 100 },
      card: { id: "small", name: "10 mm square", widthMm: 10, heightMm: 10 },
      count: 40,
      bleedMm: 0,
      reservedZonesMm: [{ xMm: 0, yMm: 0, widthMm: 60, heightMm: 60 }],
    });

    expect(layout.capacity).toBeGreaterThanOrEqual(40);
    expect(layout.slots).toHaveLength(40);
  });

  it("accepts all bounded zones from custom marks plus explicit custom zones", () => {
    const geometry = generateRegistrationGeometry({
      type: "custom",
      orientation: "portrait",
      marks: Array.from({ length: 32 }, () => [{
        type: "line" as const, x1Mm: 20, y1Mm: 20, x2Mm: 30, y2Mm: 20, strokeWidthMm: 0.1,
      }]),
      reservedZones: Array.from({ length: 64 }, () => ({ xMm: 90, yMm: 90, widthMm: 1, heightMm: 1 })),
    }, { widthMm: 100, heightMm: 100 });
    const layout = calculateGridPlacement({
      paper: { name: "100 mm square", widthMm: 100, heightMm: 100 },
      card: { id: "small", name: "10 mm square", widthMm: 10, heightMm: 10 },
      count: 1,
      bleedMm: 0,
      rows: 10,
      columns: 10,
      reservedZonesMm: geometry.reservedZones,
    });

    expect(geometry.marks).toHaveLength(32);
    expect(geometry.reservedZones).toHaveLength(96);
    expect(layout.capacity).toBeGreaterThan(0);
  });

  it("blocks overlap with reserved zones but allows a touching boundary", () => {
    const touching = calculateGridPlacement({
      paper: { name: "Test", widthMm: 80, heightMm: 20 },
      card: { id: "rect", name: "Rect", widthMm: 40, heightMm: 20 },
      count: 1,
      bleedMm: 0,
      rows: 1,
      columns: 2,
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      reservedZonesMm: [{ xMm: 40, yMm: 0, widthMm: 10, heightMm: 20 }],
    });

    expect(touching.capacity).toBe(1);
    expect(touching.gridSlots[0]).toMatchObject({ index: 0, reserved: false });
    expect(touching.gridSlots[1]).toMatchObject({ index: 1, reserved: true });
    expect(() => calculateGridPlacement({
      paper: { name: "Test", widthMm: 100, heightMm: 60 },
      card: { id: "rect", name: "Rect", widthMm: 40, heightMm: 20 },
      count: 1,
      bleedMm: 0,
      rows: 1,
      columns: 2,
      reservedZonesMm: [{ xMm: 45, yMm: 20, widthMm: 10, heightMm: 20 }],
    })).toThrow(/reserved zone/i);
  });

  it("keeps a skipped slot identified separately when it also intersects a physical reserved zone", () => {
    const layout = calculateGridPlacement({
      paper: PAPER_FORMATS.A4,
      card: { id: "test-card", name: "Test card", widthMm: 20, heightMm: 30 },
      count: 1,
      bleedMm: 0,
      rows: 1,
      columns: 2,
      skippedSlotIndices: [0],
      reservedZonesMm: [{ xMm: 85, yMm: 133, widthMm: 5, heightMm: 5 }],
    });

    expect(layout.slots.map(({ index, cardIndex }) => ({ index, cardIndex }))).toEqual([{ index: 1, cardIndex: 0 }]);
    expect(layout.gridSlots[0]).toMatchObject({ index: 0, skippedByUser: true, reserved: true });
  });

  it("combines several physical zones with a separate user skip without changing slot identity", () => {
    const layout = calculateGridPlacement({
      paper: { name: "Test", widthMm: 100, heightMm: 100 },
      card: { id: "square", name: "Square", widthMm: 40, heightMm: 40 },
      count: 1,
      bleedMm: 0,
      rows: 2,
      columns: 2,
      skippedSlotIndices: [1],
      reservedZonesMm: [
        { xMm: 15, yMm: 15, widthMm: 2, heightMm: 2 },
        { xMm: 55, yMm: 55, widthMm: 2, heightMm: 2 },
      ],
    });

    expect(layout.capacity).toBe(1);
    expect(layout.gridSlots.map(({ index, skippedByUser, reserved, cardIndex }) => [index, skippedByUser, reserved, cardIndex])).toEqual([
      [0, false, true, undefined],
      [1, true, false, undefined],
      [2, false, false, 0],
      [3, false, true, undefined],
    ]);
  });

  it("rejects invalid skip indices and reserved zones outside the page", () => {
    const base = {
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      count: 1,
      bleedMm: 0,
      rows: 1,
      columns: 1,
    };
    expect(() => calculateGridPlacement({ ...base, skippedSlotIndices: [1] })).toThrow(/skip/i);
    expect(() => calculateGridPlacement({ ...base, reservedZonesMm: [{ xMm: 210, yMm: 296, widthMm: 1, heightMm: 1 }] }))
      .toThrow(/page bounds/i);
  });
});
