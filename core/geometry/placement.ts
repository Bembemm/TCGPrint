import type { CardFormat, PageMarginsMm, PaperFormat } from "./index";

export interface CardSlotMm {
  readonly index: number;
  readonly column: number;
  readonly row: number;
  readonly slotXmm: number;
  readonly slotYmm: number;
  readonly slotWidthMm: number;
  readonly slotHeightMm: number;
  readonly trim: {
    readonly xMm: number;
    readonly yMm: number;
    readonly widthMm: number;
    readonly heightMm: number;
  };
}

export interface GridPlacementRequest {
  readonly paper: PaperFormat;
  readonly card: CardFormat;
  /** Number of card trims to place on this page. */
  readonly count: number;
  readonly bleedMm: number;
  readonly marginsMm?: PageMarginsMm;
}

export interface GridPlacementMm {
  readonly columns: number;
  readonly rows: number;
  readonly capacity: number;
  readonly gridXmm: number;
  readonly gridYmm: number;
  readonly gridWidthMm: number;
  readonly gridHeightMm: number;
  readonly bleedMm: number;
  readonly slots: readonly CardSlotMm[];
}

const PLACEMENT_EPSILON_MM = 1e-9;

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than zero.`);
  }
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to zero.`);
  }
}

/**
 * Makes a centered, row-major card grid while reserving each card's external
 * bleed in millimeters. The returned trim rectangles always retain card size.
 */
export function calculateGridPlacement(request: GridPlacementRequest): GridPlacementMm {
  const { paper, card, count, bleedMm } = request;
  assertPositive(paper.widthMm, "Paper width");
  assertPositive(paper.heightMm, "Paper height");
  assertPositive(card.widthMm, "Card width");
  assertPositive(card.heightMm, "Card height");
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("Card count must be a non-negative integer.");
  }
  assertNonNegative(bleedMm, "Bleed");
  if (bleedMm > 3) throw new RangeError("Bleed must not exceed 3 mm.");

  const margins = request.marginsMm ?? { top: 0, right: 0, bottom: 0, left: 0 };
  for (const side of ["top", "right", "bottom", "left"] as const) {
    assertNonNegative(margins[side], `Page margin ${side}`);
  }
  const availableWidthMm = paper.widthMm - margins.left - margins.right;
  const availableHeightMm = paper.heightMm - margins.top - margins.bottom;
  const slotWidthMm = card.widthMm + 2 * bleedMm;
  const slotHeightMm = card.heightMm + 2 * bleedMm;
  if (availableWidthMm <= 0 || availableHeightMm <= 0) {
    throw new RangeError("No physical card slot fits inside the page margins.");
  }

  const maximumColumns = Math.floor((availableWidthMm + PLACEMENT_EPSILON_MM) / slotWidthMm);
  const maximumRows = Math.floor((availableHeightMm + PLACEMENT_EPSILON_MM) / slotHeightMm);
  const capacity = maximumColumns * maximumRows;
  if (capacity < 1) {
    throw new RangeError("No physical card slot fits on the selected paper with the requested bleed.");
  }
  if (count > capacity) {
    throw new RangeError(`The requested ${count} card slots do not fit; this page holds at most ${capacity}.`);
  }

  const columns = count === 0
    ? maximumColumns
    : Math.min(maximumColumns, Math.max(1, Math.ceil(Math.sqrt(
      (count * availableWidthMm * slotHeightMm) / (availableHeightMm * slotWidthMm),
    ))));
  const rows = count === 0 ? maximumRows : Math.ceil(count / columns);

  const gridWidthMm = columns * slotWidthMm;
  const gridHeightMm = rows * slotHeightMm;
  const gridXmm = margins.left + (availableWidthMm - gridWidthMm) / 2;
  const gridYmm = margins.top + (availableHeightMm - gridHeightMm) / 2;
  const slots = Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const slotXmm = gridXmm + column * slotWidthMm;
    const slotYmm = gridYmm + row * slotHeightMm;

    return Object.freeze({
      index,
      column,
      row,
      slotXmm,
      slotYmm,
      slotWidthMm,
      slotHeightMm,
      trim: Object.freeze({
        xMm: slotXmm + bleedMm,
        yMm: slotYmm + bleedMm,
        widthMm: card.widthMm,
        heightMm: card.heightMm,
      }),
    });
  });

  return Object.freeze({
    columns,
    rows,
    capacity,
    gridXmm,
    gridYmm,
    gridWidthMm,
    gridHeightMm,
    bleedMm,
    slots: Object.freeze(slots),
  });
}
