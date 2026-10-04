import { describe, expect, it } from "vitest";
import { calculateGridPagePlacements } from "../../core/geometry/page-placement";
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
});
