import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS } from "../../core/geometry";
import { calculateGridPagePlacements } from "../../core/geometry/page-placement";
import { calculateSharedPagePlacements, createDuplexPagePairing, getDuplexPageReflectionMatrix, getDuplexPreviewOverlayMatrix, transformPointByDuplexMatrix } from "../../core/duplex";
import { generateRegistrationGeometry, transformRegistrationGeometry } from "../../core/registration";
import type { DuplexFlipMode } from "../../core/duplex";

const numberedFixture = JSON.parse(readFileSync(new URL("../fixtures/duplex/numbered-slot-fixture.json", import.meta.url), "utf8")) as Record<string, unknown>;
const smallCard = { id: "fixture-card", name: "Fixture card", widthMm: 20, heightMm: 30 };

function pair(rows: number, columns: number, count: number, orientation: "portrait" | "landscape", flipMode: DuplexFlipMode) {
  const pages = calculateGridPagePlacements({
    placement: {
      paper: PAPER_FORMATS.A4,
      pageOrientation: orientation,
      card: smallCard,
      bleedMm: 0,
      rows,
      columns,
    },
    count,
  });
  return createDuplexPagePairing(pages, { pageOrientation: orientation, flipMode });
}

function backRows(page: ReturnType<typeof pair>["pagePairs"][number], columns: number, rows: number): string[][] {
  const labels = Array.from({ length: columns * rows }, () => "blank");
  for (const slot of page.slots) {
    if (slot.cardIndex !== undefined) labels[slot.backSlotIndex] = `TOP ↑ ${slot.cardIndex + 1}B`;
  }
  return Array.from({ length: rows }, (_unused, row) => labels.slice(row * columns, (row + 1) * columns));
}

describe("physical duplex page pairing", () => {
  it.each([
    ["x", { a: -1, b: 0, c: 0, d: 1, e: 100, f: 0 }, { xMm: 13, yMm: 27 }, { xMm: 87, yMm: 27 }],
    ["y", { a: 1, b: 0, c: 0, d: -1, e: 0, f: 140 }, { xMm: 13, yMm: 27 }, { xMm: 13, yMm: 113 }],
  ] as const)("reflects asymmetric page-coordinate overlays across the %s axis", (axis, matrix, point, expected) => {
    const actualMatrix = getDuplexPageReflectionMatrix(axis, { widthMm: 100, heightMm: 140 });
    expect(actualMatrix).toEqual(matrix);
    expect(transformPointByDuplexMatrix(point, actualMatrix)).toEqual(expected);
    expect(transformPointByDuplexMatrix(expected, actualMatrix)).toEqual(point);
  });

  it("uses identity overlays on front preview and the paired reflection matrix on back preview", () => {
    expect(getDuplexPreviewOverlayMatrix("front", "y", { widthMm: 100, heightMm: 140 }))
      .toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(getDuplexPreviewOverlayMatrix("back", "y", { widthMm: 100, heightMm: 140 }))
      .toEqual({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 140 });
  });

  it.each([
    ["portrait", "long-edge", "portrait-long-edge", "x"],
    ["portrait", "short-edge", "portrait-short-edge", "y"],
    ["landscape", "long-edge", "landscape-long-edge", "y"],
    ["landscape", "short-edge", "landscape-short-edge", "x"],
  ] as const)("maps numbered 3x3 slots for %s + %s and keeps artwork upright", (orientation, flipMode, fixtureKey, axis) => {
    const page = pair(3, 3, 9, orientation, flipMode).pagePairs[0]!;
    expect(page.reflectionAxis).toBe(axis);
    expect(backRows(page, 3, 3)).toEqual(numberedFixture[fixtureKey]);
    expect(page.backArtworkOrientation).toEqual((numberedFixture.backArtworkOrientation as Record<string, unknown>)[fixtureKey]);
    const artworkUpVector = page.backArtworkOrientation.rotationDegrees === 180 ? { x: 0, y: -1 } : { x: 0, y: 1 };
    const physicalFlipUpVector = axis === "y" ? { x: artworkUpVector.x, y: -artworkUpVector.y } : artworkUpVector;
    expect(physicalFlipUpVector).toEqual({ x: 0, y: 1 });
    expect(page.frontPageNumber).toBe(1);
    expect(page.backPageNumber).toBe(1);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [2, 4],
  ])("pairs every numbered slot in a %ix%i physical grid", (rows, columns) => {
    const result = pair(rows, columns, rows * columns, "portrait", "long-edge");
    const page = result.pagePairs[0]!;
    expect(page.slots).toHaveLength(rows * columns);
    expect(page.slots.map(({ frontSlotIndex }) => frontSlotIndex).sort((a, b) => a - b)).toEqual(
      Array.from({ length: rows * columns }, (_unused, index) => index),
    );
    expect(page.slots.map(({ backSlotIndex }) => backSlotIndex).sort((a, b) => a - b)).toEqual(
      Array.from({ length: rows * columns }, (_unused, index) => index),
    );
  });

  it("transforms custom physical slot coordinates around the page, not the grid envelope", () => {
    const custom = {
      orientation: "portrait" as const,
      cardOrientation: "portrait" as const,
      pageSizeMm: { widthMm: 100, heightMm: 140 },
      cardSizeMm: { widthMm: 20, heightMm: 30 },
      rows: 2,
      columns: 2,
      slots: [
        { index: 0, row: 0, column: 0, xMm: 12, yMm: 8 },
        { index: 1, row: 0, column: 1, xMm: 57, yMm: 11 },
        { index: 2, row: 1, column: 0, xMm: 15, yMm: 83 },
        { index: 3, row: 1, column: 1, xMm: 55, yMm: 86 },
      ],
    };
    const pages = calculateGridPagePlacements({
      placement: { paper: { name: "Custom", widthMm: 100, heightMm: 140 }, card: smallCard, bleedMm: 0, templateGeometry: custom },
      count: 4,
    });
    const result = createDuplexPagePairing(pages, { pageOrientation: "portrait", flipMode: "long-edge" });
    const transformed = result.pagePairs[0]!.slots.find(({ frontSlotIndex }) => frontSlotIndex === 0)!;
    expect(transformed.back.trim.xMm).toBe(68);
    expect(transformed.back.trim.yMm).toBe(8);
    expect(transformPointByDuplexMatrix({ xMm: 32, yMm: 8 }, getDuplexPageReflectionMatrix("x", custom.pageSizeMm)))
      .toEqual({ xMm: transformed.back.trim.xMm, yMm: transformed.back.trim.yMm });
  });

  it("keeps skipped and reserved physical slots blank through the coordinate transform", () => {
    const skippedPages = calculateGridPagePlacements({
      placement: { paper: PAPER_FORMATS.A4, card: smallCard, bleedMm: 0, rows: 2, columns: 3, skippedSlotIndices: [2] },
      count: 5,
    });
    const skippedPage = createDuplexPagePairing(skippedPages, { pageOrientation: "portrait", flipMode: "long-edge" }).pagePairs[0]!;
    const skipped = skippedPage.slots.find(({ frontSlotIndex }) => frontSlotIndex === 2)!;
    expect(skipped.skippedByUser).toBe(true);
    expect(skipped.cardIndex).toBeUndefined();
    expect(skipped.backSlotIndex).toBe(0);

    const reservedPages = calculateGridPagePlacements({
      placement: {
        paper: PAPER_FORMATS.A4,
        card: smallCard,
        bleedMm: 0,
        rows: 2,
        columns: 2,
        reservedZonesMm: [{ xMm: 85, yMm: 118, widthMm: 20, heightMm: 30 }],
      },
      count: 2,
    });
    const reservedPage = createDuplexPagePairing(reservedPages, { pageOrientation: "portrait", flipMode: "long-edge" }).pagePairs[0]!;
    const reserved = reservedPage.slots.find(({ frontSlotIndex }) => frontSlotIndex === 0)!;
    expect(reserved.reserved).toBe(true);
    expect(reserved.cardIndex).toBeUndefined();
  });

  it("maps asymmetric registration marks and reserved zones with the back sheet coordinate frame", () => {
    const registration = {
      type: "custom" as const,
      orientation: "portrait" as const,
      marks: [[{ type: "rect" as const, xMm: 10, yMm: 10, widthMm: 4, heightMm: 4, fill: true, strokeWidthMm: 0 }]],
      reservedZones: [{ xMm: 8, yMm: 8, widthMm: 8, heightMm: 8 }],
    };
    const result = calculateSharedPagePlacements(1, {
      bleedMm: 0,
      paperFormat: { name: "Custom 100", widthMm: 100, heightMm: 100 },
      cardFormat: { ...smallCard, name: "20x30" },
      pageOrientation: "portrait",
      cardOrientation: "portrait",
      registration,
      templateGeometry: {
        orientation: "portrait",
        cardOrientation: "portrait",
        pageSizeMm: { widthMm: 100, heightMm: 100 },
        cardSizeMm: { widthMm: 20, heightMm: 30 },
        rows: 1,
        columns: 2,
        slots: [
          { index: 0, row: 0, column: 0, xMm: 10, yMm: 10 },
          { index: 1, row: 0, column: 1, xMm: 70, yMm: 10 },
        ],
      },
    });
    const back = createDuplexPagePairing(result.pages, { pageOrientation: "portrait", flipMode: "long-edge" }).pagePairs[0]!;
    const frontCard = result.pages[0]!.placement.slots[0]!;
    const pairedBack = back.slots.find(({ physicalCardIndex }) => physicalCardIndex === 0)!.back;
    const marks = generateRegistrationGeometry(registration, { widthMm: 100, heightMm: 100 });
    const backMarks = transformRegistrationGeometry(marks, { widthMm: 100, heightMm: 100 }, back.reflectionAxis);

    expect(frontCard.trim.xMm).toBe(70);
    expect(pairedBack.trim.xMm).toBe(10);
    expect(back.reflectionAxis).toBe("x");
    expect(backMarks.marks[0]?.bounds.xMm).toBe(86);
    expect(backMarks.reservedZones).toContainEqual({ xMm: 84, yMm: 8, widthMm: 8, heightMm: 8 });
    expect(pairedBack.trim.xMm + pairedBack.trim.widthMm).toBeLessThan(backMarks.reservedZones[0]!.xMm);
  });

  it("keeps a partial last page paired to its own logical front page", () => {
    const result = pair(3, 3, 10, "portrait", "long-edge");
    expect(result.pagePairs.map(({ frontPageNumber, backPageNumber, frontPlacement, backPlacement }) => ({
      frontPageNumber,
      backPageNumber,
      start: frontPlacement.startCardIndex,
      end: frontPlacement.endCardIndex,
      backStart: backPlacement.startCardIndex,
      backEnd: backPlacement.endCardIndex,
    }))).toEqual([
      { frontPageNumber: 1, backPageNumber: 1, start: 0, end: 9, backStart: 0, backEnd: 9 },
      { frontPageNumber: 2, backPageNumber: 2, start: 9, end: 10, backStart: 9, backEnd: 10 },
    ]);
  });

  it("preserves page pairing for a 100-card multi-page batch", () => {
    const result = pair(3, 3, 100, "landscape", "short-edge");
    expect(result.pagePairs).toHaveLength(12);
    expect(result.pagePairs.map(({ frontPageNumber, backPageNumber }) => [frontPageNumber, backPageNumber])).toEqual(
      Array.from({ length: 12 }, (_unused, index) => [index + 1, index + 1]),
    );
    expect(result.pagePairs.at(-1)?.frontPlacement.endCardIndex).toBe(100);
  });

  it("does not change Magic Standard trim dimensions when reflecting a placement", () => {
    const pages = calculateGridPagePlacements({ placement: { paper: PAPER_FORMATS.A4, card: MAGIC_STANDARD_CARD, bleedMm: 0.625 }, count: 1 });
    const front = pages[0]!.placement.slots[0]!.trim;
    const back = createDuplexPagePairing(pages, { pageOrientation: "portrait", flipMode: "long-edge" }).pagePairs[0]!.slots[0]!.back.trim;
    expect(back.widthMm).toBe(63.5);
    expect(back.heightMm).toBe(88.9);
    expect(back.xMm).toBe(pages[0]!.placement.pageSizeMm.widthMm - front.xMm - front.widthMm);
    expect(back.yMm).toBe(front.yMm);
  });
});
