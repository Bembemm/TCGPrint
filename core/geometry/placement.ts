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
  /** Uniform bleed used for every card unless bleedByCardMm is provided. */
  readonly bleedMm: number;
  /** Optional per-card bleed amounts in the same row-major order as the slots. */
  readonly bleedByCardMm?: readonly number[];
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
 * bleed in millimeters. Per-column and per-row clearances use the largest bleed
 * assigned to that column and row. The returned trims always retain card size.
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
  if (request.bleedByCardMm && request.bleedByCardMm.length !== count) {
    throw new RangeError("Per-card bleed values must contain one value per requested card.");
  }

  const bleedByCardMm = request.bleedByCardMm ?? Array.from({ length: count }, () => bleedMm);
  for (const value of bleedByCardMm) {
    assertNonNegative(value, "Per-card bleed");
    if (value > 3) throw new RangeError("Bleed must not exceed 3 mm.");
  }

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
  if (count === 0) {
    if (capacity < 1) {
      throw new RangeError("No physical card slot fits on the selected paper with the requested bleed.");
    }

    return Object.freeze({
      columns: maximumColumns,
      rows: maximumRows,
      capacity,
      gridXmm: margins.left + (availableWidthMm - maximumColumns * slotWidthMm) / 2,
      gridYmm: margins.top + (availableHeightMm - maximumRows * slotHeightMm) / 2,
      gridWidthMm: maximumColumns * slotWidthMm,
      gridHeightMm: maximumRows * slotHeightMm,
      bleedMm,
      slots: Object.freeze([]),
    });
  }

  const candidates: Array<{
    readonly columns: number;
    readonly rows: number;
    readonly columnBleeds: readonly number[];
    readonly rowBleeds: readonly number[];
    readonly gridWidthMm: number;
    readonly gridHeightMm: number;
    readonly aspectError: number;
  }> = [];

  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const columnBleeds = Array.from({ length: columns }, () => 0);
    const rowBleeds = Array.from({ length: rows }, () => 0);
    for (let index = 0; index < count; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      columnBleeds[column] = Math.max(columnBleeds[column], bleedByCardMm[index]);
      rowBleeds[row] = Math.max(rowBleeds[row], bleedByCardMm[index]);
    }

    const gridWidthMm = columns * card.widthMm + 2 * columnBleeds.reduce((sum, value) => sum + value, 0);
    const gridHeightMm = rows * card.heightMm + 2 * rowBleeds.reduce((sum, value) => sum + value, 0);
    if (
      gridWidthMm > availableWidthMm + PLACEMENT_EPSILON_MM
      || gridHeightMm > availableHeightMm + PLACEMENT_EPSILON_MM
    ) {
      continue;
    }

    candidates.push({
      columns,
      rows,
      columnBleeds,
      rowBleeds,
      gridWidthMm,
      gridHeightMm,
      aspectError: Math.abs(Math.log((gridWidthMm / gridHeightMm) / (availableWidthMm / availableHeightMm))),
    });
  }

  if (candidates.length === 0) {
    throw new RangeError(`No physical card slot fits the requested ${count} card slots on the selected paper.`);
  }

  candidates.sort((a, b) => a.aspectError - b.aspectError || (b.gridWidthMm * b.gridHeightMm) - (a.gridWidthMm * a.gridHeightMm));
  const selected = candidates[0];
  const { columns, rows, columnBleeds, rowBleeds, gridWidthMm, gridHeightMm } = selected;
  const gridXmm = margins.left + (availableWidthMm - gridWidthMm) / 2;
  const gridYmm = margins.top + (availableHeightMm - gridHeightMm) / 2;
  const columnOffsets = columnBleeds.map((_bleed, column) =>
    gridXmm + columnBleeds.slice(0, column).reduce((sum, value) => sum + card.widthMm + 2 * value, 0),
  );
  const rowOffsets = rowBleeds.map((_bleed, row) =>
    gridYmm + rowBleeds.slice(0, row).reduce((sum, value) => sum + card.heightMm + 2 * value, 0),
  );
  const slots = Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const columnBleedMm = columnBleeds[column];
    const rowBleedMm = rowBleeds[row];
    const slotXmm = columnOffsets[column];
    const slotYmm = rowOffsets[row];

    return Object.freeze({
      index,
      column,
      row,
      slotXmm,
      slotYmm,
      slotWidthMm: card.widthMm + 2 * columnBleedMm,
      slotHeightMm: card.heightMm + 2 * rowBleedMm,
      trim: Object.freeze({
        xMm: slotXmm + columnBleedMm,
        yMm: slotYmm + rowBleedMm,
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
    bleedMm: Math.max(bleedMm, ...bleedByCardMm),
    slots: Object.freeze(slots),
  });
}
