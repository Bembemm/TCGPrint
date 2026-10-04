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

    expect(pages.map(({ startCardIndex, endCardIndex }) => [startCardIndex, endCardIndex])).toEqual([[0, 9], [9, 10]]);
    expect([last.columns, last.rows, last.capacity]).toEqual([first.columns, first.rows, first.capacity]);
    expect(coordinates(last)).toEqual(coordinates(first));
    expect(last.slots[0]!.trim).toEqual(first.slots[0]!.trim);
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
    expect(one[0]!.placement.gridSlots.map(({ trim }) => [trim.xMm, trim.yMm])).toEqual([
      [8.625, 13.625], [73.375, 13.625],
      [8.625, 103.775], [73.375, 103.775],
      [8.625, 193.925], [73.375, 193.925],
    ]);
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
        reservedZonesMm: [{ xMm: 1, yMm: 1, widthMm: 1, heightMm: 1 }],
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
});
