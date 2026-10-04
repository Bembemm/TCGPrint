import { describe, expect, it } from "vitest";
import { calculateGridPagePlacements } from "../../core/geometry/page-placement";
import { calculateGridPlacement } from "../../core/geometry/placement";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS } from "../../core/geometry";

const placement = { paper: PAPER_FORMATS.A4, card: MAGIC_STANDARD_CARD, bleedMm: 0.625 };

describe("shared physical page placements", () => {
  it("keeps nine Magic Standard cards on one A4 page and splits ten into 9 + 1", () => {
    const nine = calculateGridPagePlacements({ placement, count: 9 });
    const ten = calculateGridPagePlacements({ placement, count: 10 });
    expect(nine).toHaveLength(1);
    expect(ten.map(({ startCardIndex, endCardIndex }) => [startCardIndex, endCardIndex])).toEqual([[0, 9], [9, 10]]);
    expect(ten[0]?.placement.slots.map(({ cardIndex }) => cardIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ten[1]?.placement.slots.map(({ cardIndex }) => cardIndex)).toEqual([0]);
  });

  it("paginates one hundred cards without requesting an impossible single-sheet placement", () => {
    const pages = calculateGridPagePlacements({ placement, count: 100 });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]?.startCardIndex).toBe(0);
    expect(pages.at(-1)?.endCardIndex).toBe(100);
    expect(pages.every(({ placement: page }) => page.slots.length <= page.capacity)).toBe(true);
  });

  it("keeps capacity and final partial pages on identical physical slot coordinates", () => {
    const pages = calculateGridPagePlacements({ placement, count: 10 });
    const first = pages[0]!.placement;
    const last = pages[1]!.placement;
    const coordinates = (page: typeof first) => page.gridSlots.map(({ trim }) => [trim.xMm, trim.yMm, trim.widthMm, trim.heightMm]);
    const geometry = (page: typeof first) => ({
      columns: page.columns,
      rows: page.rows,
      capacity: page.capacity,
      gridXmm: page.gridXmm,
      gridYmm: page.gridYmm,
      gridWidthMm: page.gridWidthMm,
      gridHeightMm: page.gridHeightMm,
      gridSlots: coordinates(page),
    });
    const one = calculateGridPagePlacements({ placement, count: 1 })[0]!.placement;
    const two = calculateGridPagePlacements({ placement, count: 2 })[0]!.placement;
    const capacity = calculateGridPagePlacements({ placement, count: first.capacity })[0]!.placement;
    const expected = geometry(one);

    expect(pages.map(({ startCardIndex, endCardIndex }) => [startCardIndex, endCardIndex])).toEqual([[0, 9], [9, 10]]);
    expect([last.columns, last.rows, last.capacity]).toEqual([first.columns, first.rows, first.capacity]);
    expect(coordinates(last)).toEqual(coordinates(first));
    expect(last.slots[0]!.trim).toEqual(first.slots[0]!.trim);
    expect([one.columns, one.rows, one.capacity]).toEqual([3, 3, 9]);
    for (const canonical of [two, capacity, first, last]) {
      expect(geometry(canonical)).toEqual(expected);
    }
    expect(one.gridXmm).toBeCloseTo(7.875, 10);
    expect(one.gridYmm).toBeCloseTo(13.275, 10);
    expect(one.gridWidthMm).toBeCloseTo(194.25, 10);
    expect(one.gridHeightMm).toBeCloseTo(270.45, 10);
    const expectedCoordinates = [
      [8.5, 13.9], [73.25, 13.9], [138, 13.9],
      [8.5, 104.05], [73.25, 104.05], [138, 104.05],
      [8.5, 194.2], [73.25, 194.2], [138, 194.2],
    ];
    const actualCoordinates = coordinates(one);
    expect(actualCoordinates).toHaveLength(expectedCoordinates.length);
    for (const [index, [expectedX, expectedY]] of expectedCoordinates.entries()) {
      expect(actualCoordinates[index]![0]).toBeCloseTo(expectedX, 10);
      expect(actualCoordinates[index]![1]).toBeCloseTo(expectedY, 10);
    }
  });

  it("keeps one centered fixed 3×3 lattice for 1, 2, 8, 9, and 10 cards", () => {
    const fixedPlacement = {
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      bleedMm: 0.625,
      rows: 3,
      columns: 3,
      marginsMm: { top: 5, right: 4, bottom: 12, left: 8 },
    };
    const byCount = new Map([1, 2, 8, 9, 10].map((count) => [
      count,
      calculateGridPagePlacements({ placement: fixedPlacement, count }),
    ]));
    const one = byCount.get(1)![0]!.placement;
    const geometry = (page: typeof one) => ({
      columns: page.columns,
      rows: page.rows,
      capacity: page.capacity,
      gridXmm: page.gridXmm,
      gridYmm: page.gridYmm,
      gridWidthMm: page.gridWidthMm,
      gridHeightMm: page.gridHeightMm,
      gridSlots: page.gridSlots.map(({ index, column, row, slotXmm, slotYmm, trim }) => [
        index, column, row, slotXmm, slotYmm, trim.xMm, trim.yMm, trim.widthMm, trim.heightMm,
      ]),
    });
    const expectedGeometry = geometry(one);

    expect([one.columns, one.rows, one.capacity]).toEqual([3, 3, 9]);
    expect(one.gridXmm).toBeCloseTo(9.875, 10);
    expect(one.gridYmm).toBeCloseTo(9.775, 10);
    for (const pages of byCount.values()) {
      expect(geometry(pages[0]!.placement)).toEqual(expectedGeometry);
    }
    expect(byCount.get(1)![0]!.placement.gridSlots.map(({ cardIndex }) => cardIndex))
      .toEqual([0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(byCount.get(8)![0]!.placement.gridSlots.map(({ cardIndex }) => cardIndex))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, undefined]);
    expect(byCount.get(9)![0]!.placement.gridSlots.map(({ cardIndex }) => cardIndex))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(byCount.get(10)!.map(({ startCardIndex, endCardIndex }) => [startCardIndex, endCardIndex]))
      .toEqual([[0, 9], [9, 10]]);
    expect(geometry(byCount.get(10)![1]!.placement)).toEqual(expectedGeometry);
    expect(byCount.get(10)![1]!.placement.gridSlots.map(({ cardIndex }) => cardIndex))
      .toEqual([0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(one.gridSlots[0]!.trim.xMm).toBeCloseTo(10.5, 10);
    expect(one.gridSlots[0]!.trim.yMm).toBeCloseTo(10.4, 10);
    expect(one.gridSlots[0]!.trim).toMatchObject({ widthMm: 63.5, heightMm: 88.9 });

    const leftFreeSpace = one.gridXmm - fixedPlacement.marginsMm.left;
    const rightFreeSpace = PAPER_FORMATS.A4.widthMm - fixedPlacement.marginsMm.right - (one.gridXmm + one.gridWidthMm);
    const topFreeSpace = one.gridYmm - fixedPlacement.marginsMm.top;
    const bottomFreeSpace = PAPER_FORMATS.A4.heightMm - fixedPlacement.marginsMm.bottom - (one.gridYmm + one.gridHeightMm);
    expect(leftFreeSpace).toBeCloseTo(rightFreeSpace, 10);
    expect(topFreeSpace).toBeCloseTo(bottomFreeSpace, 10);
  });

  it("discovers the count-independent capacity grid with configured bleed", () => {
    const constrained = {
      paper: PAPER_FORMATS.A4,
      card: MAGIC_STANDARD_CARD,
      bleedMm: 0.625,
      marginsMm: { top: 13, right: 8, bottom: 13, left: 8 },
    };

    expect(() => calculateGridPlacement({ ...constrained, count: 1, bleedMm: 0, rows: 1, columns: 3 })).not.toThrow();
    expect(() => calculateGridPlacement({ ...constrained, count: 1, rows: 1, columns: 3 })).toThrow(/No physical card slot fits/);
    expect(() => calculateGridPlacement({ ...constrained, count: 1, rows: 1, columns: 2 })).not.toThrow();

    const one = calculateGridPagePlacements({ placement: constrained, count: 1 });
    const two = calculateGridPagePlacements({ placement: constrained, count: 2 });
    const capacity = one[0]!.placement.capacity;
    const full = calculateGridPagePlacements({ placement: constrained, count: capacity });
    const partial = calculateGridPagePlacements({ placement: constrained, count: capacity + 1 });
    const geometry = (page: (typeof one)[number]["placement"]) => ({
      rows: page.rows,
      columns: page.columns,
      gridXmm: page.gridXmm,
      gridYmm: page.gridYmm,
      gridSlots: page.gridSlots.map(({ index, column, row, slotXmm, slotYmm, trim }) => [
        index, column, row, slotXmm, slotYmm, trim.xMm, trim.yMm, trim.widthMm, trim.heightMm,
      ]),
    });
    const expected = geometry(one[0]!.placement);

    expect(capacity).toBe(6);
    expect([one[0]!.placement.columns, one[0]!.placement.rows]).toEqual([2, 3]);
    const oneCoordinates = one[0]!.placement.gridSlots.map(({ trim }) => [trim.xMm, trim.yMm]);
    const expectedCoordinates = [
      [40.875, 13.9], [105.625, 13.9],
      [40.875, 104.05], [105.625, 104.05],
      [40.875, 194.2], [105.625, 194.2],
    ];
    expect(oneCoordinates).toHaveLength(expectedCoordinates.length);
    for (const [index, [expectedX, expectedY]] of expectedCoordinates.entries()) {
      expect(oneCoordinates[index]![0]).toBeCloseTo(expectedX, 10);
      expect(oneCoordinates[index]![1]).toBeCloseTo(expectedY, 10);
    }
    expect(geometry(two[0]!.placement)).toEqual(expected);
    expect(geometry(full[0]!.placement)).toEqual(expected);
    expect(partial).toHaveLength(2);
    expect([partial[0]!.placement.columns, partial[0]!.placement.rows]).toEqual([2, 3]);
    expect([partial[1]!.placement.columns, partial[1]!.placement.rows]).toEqual([2, 3]);
    expect(geometry(partial[0]!.placement)).toEqual(expected);
    expect(geometry(partial[1]!.placement)).toEqual(expected);
    expect(partial[0]!.placement.gridSlots.map(({ cardIndex }) => cardIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(partial[1]!.placement.gridSlots.map(({ cardIndex }) => cardIndex)).toEqual([0, undefined, undefined, undefined, undefined, undefined]);
  });

  it.each([
    ["large bleed on the first page", [2, 0.625, 0.625, 1.25, 0.625, 0.625, 0.625, 0.625, 0.625, 0.625]],
    ["large bleed only on the last page", [0.625, 0.625, 0.625, 1.25, 0.625, 0.625, 0.625, 0.625, 0.625, 2]],
    ["large bleeds in different columns and rows", [0.625, 2, 0.625, 0.625, 0.625, 1.25, 0.625, 0.625, 0.625, 0.625]],
  ] as const)("keeps every page on one stable envelope with %s", (_caseName, bleeds) => {
    const pages = calculateGridPagePlacements({
      placement: { ...placement, bleedMm: 0.625, marginsMm: { top: 0, right: 0, bottom: 0, left: 0 } },
      count: bleeds.length,
      bleedByCardMm: bleeds,
    });

    expect(pages.length).toBeGreaterThan(1);
    const geometry = (page: (typeof pages)[number]["placement"]) => ({
      rows: page.rows,
      columns: page.columns,
      gridXmm: page.gridXmm,
      gridYmm: page.gridYmm,
      gridWidthMm: page.gridWidthMm,
      gridHeightMm: page.gridHeightMm,
      gridSlots: page.gridSlots.map(({ slotXmm, slotYmm, trim }) => ({
        slotXmm,
        slotYmm,
        trimXmm: trim.xMm,
        trimYmm: trim.yMm,
        trimWidthMm: trim.widthMm,
        trimHeightMm: trim.heightMm,
      })),
    });
    const expected = geometry(pages[0]!.placement);

    expect(pages.slice(1).map(({ placement: page }) => geometry(page))).toEqual(
      pages.slice(1).map(() => expected),
    );
    expect(pages.at(-1)!.placement.gridSlots.map(({ trim }) => [trim.xMm, trim.yMm])).toEqual(
      pages[0]!.placement.gridSlots.map(({ trim }) => [trim.xMm, trim.yMm]),
    );
  });

  it("keeps one document envelope when a reserved zone changes per-page slot assignments", () => {
    const bleeds = [2, 0.625, 0.625, 1.25, 0.625, 0.625, 0.625, 0.625, 0.625, 0.625];
    const pages = calculateGridPagePlacements({
      placement: {
        ...placement,
        bleedMm: 0.625,
        marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
        reservedZonesMm: [{ xMm: 10, yMm: 15, widthMm: 1, heightMm: 1 }],
      },
      count: bleeds.length,
      bleedByCardMm: bleeds,
    });
    const coordinates = (page: (typeof pages)[number]["placement"]) => page.gridSlots.map(({ slotXmm, slotYmm, trim }) => [
      slotXmm, slotYmm, trim.xMm, trim.yMm, trim.widthMm, trim.heightMm,
    ]);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map(({ placement: page }) => coordinates(page))).toEqual(pages.map(() => coordinates(pages[0]!.placement)));
    expect(pages.every(({ placement: page }) => page.gridSlots.find(({ index }) => index === 0)?.reserved)).toBe(true);
  });

  it("keeps template reserved indexes and capacity stable when a document bleed reserves a slot", () => {
    const templateGeometry = {
      orientation: "landscape" as const,
      cardOrientation: "portrait" as const,
      pageSizeMm: { widthMm: 240, heightMm: 200 },
      cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      rows: 1,
      columns: 3,
      slots: [
        { index: 0, row: 0, column: 0, xMm: 10, yMm: 12 },
        { index: 1, row: 0, column: 1, xMm: 85, yMm: 12 },
        { index: 2, row: 0, column: 2, xMm: 160, yMm: 12 },
      ],
    };
    const pages = calculateGridPagePlacements({
      placement: {
        paper: { name: "240 × 200 mm", widthMm: 240, heightMm: 200 },
        pageOrientation: "landscape",
        card: MAGIC_STANDARD_CARD,
        cardOrientation: "portrait",
        bleedMm: 0.625,
        marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
        reservedZonesMm: [{ xMm: 8, yMm: 12, widthMm: 1, heightMm: 1 }],
        templateGeometry,
      },
      count: 4,
      bleedByCardMm: [3, 0.625, 0.625, 0.625],
    });
    const trimCoordinates = (page: (typeof pages)[number]["placement"]) =>
      page.gridSlots.map(({ index, trim }) => [index, trim.xMm, trim.yMm, trim.widthMm, trim.heightMm]);

    expect(pages.map(({ startCardIndex, endCardIndex }) => [startCardIndex, endCardIndex])).toEqual([[0, 2], [2, 4]]);
    expect(pages.map(({ placement: page }) => [page.rows, page.columns, page.capacity])).toEqual([[1, 3, 2], [1, 3, 2]]);
    expect(pages.map(({ placement: page }) => page.gridSlots.filter(({ reserved }) => reserved).map(({ index }) => index))).toEqual([[0], [0]]);
    expect(trimCoordinates(pages[1]!.placement)).toEqual(trimCoordinates(pages[0]!.placement));
  });

  it.each([
    ["large bleed on the first card", [3, ...Array.from({ length: 10 }, () => 0.625)], [
      [0, 1.125, 5.475], [1, 68.25, 5.475], [2, 135.375, 5.475],
      [3, 1.125, 98], [4, 68.25, 98], [5, 135.375, 98],
    ]],
    ["large bleed only on the last card", [...Array.from({ length: 10 }, () => 0.625), 3], [
      [0, 1.125, 5.475], [1, 68.25, 5.475], [2, 135.375, 5.475],
      [3, 1.125, 98], [4, 68.25, 98], [5, 135.375, 98],
    ]],
    ["large bleed immediately after the reserved slot", [0.625, 3, ...Array.from({ length: 9 }, () => 0.625)], [
      [0, 1.125, 5.475], [1, 65.875, 5.475], [2, 133, 5.475],
      [3, 1.125, 98], [4, 65.875, 98], [5, 133, 98],
    ]],
  ] as const)("chooses a larger stable reserved-zone capacity than max-everywhere for %s", (_caseName, bleeds, expectedCoordinates) => {
    const constrained = {
      paper: { name: "200 × 190 mm", widthMm: 200, heightMm: 190 },
      card: MAGIC_STANDARD_CARD,
      bleedMm: 0.625,
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      reservedZonesMm: [{ xMm: 31, yMm: 3, widthMm: 2, heightMm: 2 }],
    };
    const pages = calculateGridPagePlacements({
      placement: constrained,
      count: bleeds.length,
      bleedByCardMm: bleeds,
    });
    const maxEverywhere = calculateGridPlacement({
      ...constrained,
      count: 0,
      bleedMm: 3,
    });
    const geometry = (page: (typeof pages)[number]["placement"]) => ({
      rows: page.rows,
      columns: page.columns,
      capacity: page.capacity,
      bleedMm: page.bleedMm,
      gridXmm: page.gridXmm,
      gridYmm: page.gridYmm,
      gridWidthMm: page.gridWidthMm,
      gridHeightMm: page.gridHeightMm,
      reserved: page.gridSlots.filter(({ reserved }) => reserved).map(({ index }) => index),
      slots: page.gridSlots.map(({ index, slotXmm, slotYmm, trim }) => ({
        index,
        slotXmm,
        slotYmm,
        trimXmm: trim.xMm,
        trimYmm: trim.yMm,
        trimWidthMm: trim.widthMm,
        trimHeightMm: trim.heightMm,
      })),
    });
    const expected = geometry(pages[0]!.placement);

    expect(maxEverywhere.capacity).toBe(3);
    expect(pages[0]!.placement.capacity).toBe(5);
    expect(pages[0]!.placement.capacity).toBeGreaterThan(maxEverywhere.capacity);
    expect([pages[0]!.placement.rows, pages[0]!.placement.columns]).toEqual([2, 3]);
    expect(pages.map(({ placement: page }) => page.capacity)).toEqual([5, 5, 5]);
    expect(pages.map(({ placement: page }) => page.gridSlots.filter(({ reserved }) => reserved).map(({ index }) => index)))
      .toEqual([[0], [0], [0]]);
    expect(pages.slice(1).map(({ placement: page }) => geometry(page))).toEqual(pages.slice(1).map(() => expected));
    expect(pages.at(-1)!.placement.slots.map(({ cardIndex }) => cardIndex)).toEqual([0]);
    const firstPageSlots = pages[0]!.placement.gridSlots;
    expect(firstPageSlots.map(({ index }) => index)).toEqual(expectedCoordinates.map(([index]) => index));
    for (const [slotIndex, expectedX, expectedY] of expectedCoordinates) {
      expect(firstPageSlots[slotIndex]!.trim.xMm).toBeCloseTo(expectedX, 10);
      expect(firstPageSlots[slotIndex]!.trim.yMm).toBeCloseTo(expectedY, 10);
    }
  });
});
