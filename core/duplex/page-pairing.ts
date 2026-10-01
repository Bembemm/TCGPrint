import type { GridPlacementPage } from "../geometry/page-placement";
import type { CardSlotMm, GridPlacementMm } from "../geometry/placement";
import {
  DuplexPairingError,
  type DuplexArtworkOrientation,
  type DuplexPagePair,
  type DuplexPagePairingOptions,
  type DuplexPagePairingPlan,
  type DuplexReflectionAxis,
  type DuplexSlotPair,
} from "./types";

const ARTWORK_STAYS_UPRIGHT: DuplexArtworkOrientation = Object.freeze({
  rotationDegrees: 0,
  mirrorX: false,
  mirrorY: false,
});

function reflectionAxis(options: DuplexPagePairingOptions): DuplexReflectionAxis {
  if (options.pageOrientation !== "portrait" && options.pageOrientation !== "landscape") {
    throw new DuplexPairingError("DUPLEX_PAIRING_FAILED", "Duplex page orientation must be portrait or landscape.");
  }
  if (options.flipMode !== "long-edge" && options.flipMode !== "short-edge") {
    throw new DuplexPairingError("INVALID_DUPLEX_FLIP", "Duplex flip mode must be long-edge or short-edge.");
  }
  const reflectsX = (options.pageOrientation === "portrait" && options.flipMode === "long-edge")
    || (options.pageOrientation === "landscape" && options.flipMode === "short-edge");
  return reflectsX ? "x" : "y";
}

function mirroredIndex(slot: CardSlotMm, rows: number, columns: number, axis: DuplexReflectionAxis): number {
  const column = axis === "x" ? columns - slot.column - 1 : slot.column;
  const row = axis === "y" ? rows - slot.row - 1 : slot.row;
  return row * columns + column;
}

function reflectCoordinate(coordinateMm: number, sizeMm: number, extentMm: number): number {
  return sizeMm - coordinateMm - extentMm;
}

function transformSlot(
  slot: CardSlotMm,
  placement: GridPlacementMm,
  axis: DuplexReflectionAxis,
): CardSlotMm {
  const index = mirroredIndex(slot, placement.rows, placement.columns, axis);
  const column = index % placement.columns;
  const row = Math.floor(index / placement.columns);
  const slotXmm = axis === "x"
    ? reflectCoordinate(slot.slotXmm, placement.pageSizeMm.widthMm, slot.slotWidthMm)
    : slot.slotXmm;
  const slotYmm = axis === "y"
    ? reflectCoordinate(slot.slotYmm, placement.pageSizeMm.heightMm, slot.slotHeightMm)
    : slot.slotYmm;
  const trimXmm = axis === "x"
    ? reflectCoordinate(slot.trim.xMm, placement.pageSizeMm.widthMm, slot.trim.widthMm)
    : slot.trim.xMm;
  const trimYmm = axis === "y"
    ? reflectCoordinate(slot.trim.yMm, placement.pageSizeMm.heightMm, slot.trim.heightMm)
    : slot.trim.yMm;
  return Object.freeze({
    ...slot,
    index,
    column,
    row,
    slotXmm,
    slotYmm,
    trim: Object.freeze({ ...slot.trim, xMm: trimXmm, yMm: trimYmm }),
  });
}

function transformPlacement(page: GridPlacementPage, axis: DuplexReflectionAxis): GridPlacementPage {
  const placement = page.placement;
  const gridSlots = placement.gridSlots
    .map((slot) => transformSlot(slot, placement, axis))
    .sort((left, right) => left.index - right.index);
  const slots = gridSlots
    .filter((slot) => slot.cardIndex !== undefined)
    .sort((left, right) => left.cardIndex! - right.cardIndex!);
  const gridXmm = axis === "x"
    ? reflectCoordinate(placement.gridXmm, placement.pageSizeMm.widthMm, placement.gridWidthMm)
    : placement.gridXmm;
  const gridYmm = axis === "y"
    ? reflectCoordinate(placement.gridYmm, placement.pageSizeMm.heightMm, placement.gridHeightMm)
    : placement.gridYmm;
  const backPlacement: GridPlacementMm = Object.freeze({
    ...placement,
    gridXmm,
    gridYmm,
    gridSlots: Object.freeze(gridSlots),
    slots: Object.freeze(slots),
  });
  return Object.freeze({ ...page, placement: backPlacement });
}

function slotPairs(page: GridPlacementPage, backPage: GridPlacementPage, axis: DuplexReflectionAxis): readonly DuplexSlotPair[] {
  const backByIndex = new Map(backPage.placement.gridSlots.map((slot) => [slot.index, slot] as const));
  return Object.freeze(page.placement.gridSlots.map((front) => {
    const backSlotIndex = mirroredIndex(front, page.placement.rows, page.placement.columns, axis);
    const back = backByIndex.get(backSlotIndex);
    if (!back) {
      throw new DuplexPairingError(
        "DUPLEX_PAIRING_FAILED",
        `Front slot ${front.index} maps to missing back slot ${backSlotIndex} on page ${page.pageIndex + 1}.`,
      );
    }
    if (back.cardIndex !== front.cardIndex || back.skippedByUser !== front.skippedByUser || back.reserved !== front.reserved) {
      throw new DuplexPairingError("DUPLEX_PAIRING_FAILED", `Physical slot state changed while pairing page ${page.pageIndex + 1}.`);
    }
    const cardIndex = front.cardIndex;
    return Object.freeze({
      frontSlotIndex: front.index,
      backSlotIndex,
      ...(cardIndex !== undefined ? { cardIndex, physicalCardIndex: page.startCardIndex + cardIndex } : {}),
      skippedByUser: front.skippedByUser,
      reserved: front.reserved,
      front,
      back,
    });
  }));
}

/**
 * Creates the deterministic physical back-sheet plan from the shared page
 * placements. The sheet-space reflection remaps slots and coordinates only;
 * artwork content is never reflected, rotated, or resampled.
 */
export function createDuplexPagePairing(
  pages: readonly GridPlacementPage[],
  options: DuplexPagePairingOptions,
): DuplexPagePairingPlan {
  const axis = reflectionAxis(options);
  const pagePairs: DuplexPagePair[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const frontPage = pages[index]!;
    if (frontPage.pageIndex !== index) {
      throw new DuplexPairingError("DUPLEX_PAIRING_FAILED", "Shared page placements must have contiguous zero-based page indexes.");
    }
    const backPage = transformPlacement(frontPage, axis);
    pagePairs.push(Object.freeze({
      frontPageIndex: frontPage.pageIndex,
      backPageIndex: backPage.pageIndex,
      frontPageNumber: frontPage.pageIndex + 1,
      backPageNumber: backPage.pageIndex + 1,
      pageOrientation: options.pageOrientation,
      flipMode: options.flipMode,
      reflectionAxis: axis,
      slotTransform: Object.freeze({
        reflectionAxis: axis,
        pageWidthMm: frontPage.placement.pageSizeMm.widthMm,
        pageHeightMm: frontPage.placement.pageSizeMm.heightMm,
      }),
      backArtworkOrientation: ARTWORK_STAYS_UPRIGHT,
      slots: slotPairs(frontPage, backPage, axis),
      frontPlacement: frontPage,
      backPlacement: backPage,
    }));
  }
  return Object.freeze({
    pageOrientation: options.pageOrientation,
    flipMode: options.flipMode,
    pagePairs: Object.freeze(pagePairs),
  });
}
