import type { CardFormat, PageMarginsMm, PageOrientation, PaperFormat } from "./index";
import { parseTemplateLayoutGeometry, type TemplateLayoutGeometryMm } from "./template-layout";
import { MAX_REGISTRATION_CUSTOM_MARKS, MAX_REGISTRATION_CUSTOM_ZONES } from "../registration/config";

export interface LayoutReservedZoneMm {
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface StableGridEnvelopeMm {
  /** Maximum physical bleed assigned to each fixed column for the document. */
  readonly columnBleedsMm: readonly number[];
  /** Maximum physical bleed assigned to each fixed row for the document. */
  readonly rowBleedsMm: readonly number[];
}

export interface CardSlotMm {
  /** Stable zero-based row-major slot identity, including skipped and reserved slots. */
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
  readonly skippedByUser: boolean;
  readonly reserved: boolean;
  /** Index into the requested card list when a card is assigned to this slot. */
  readonly cardIndex?: number;
}

export interface GridPlacementRequest {
  readonly paper: PaperFormat;
  readonly pageOrientation?: PageOrientation;
  readonly card: CardFormat;
  readonly cardOrientation?: PageOrientation;
  /** Number of card trims to place on this page. */
  readonly count: number;
  /** Uniform bleed used for every card unless bleedByCardMm is provided. */
  readonly bleedMm: number;
  readonly horizontalGapMm?: number;
  readonly verticalGapMm?: number;
  /** Optional per-card bleed amounts in the same row-major active-slot order. */
  readonly bleedByCardMm?: readonly number[];
  /** Internal document-wide envelope input used only while resolving a canonical paginated grid. */
  readonly documentBleedByCardMm?: readonly number[];
  /** Fixed document envelope reused by every page after capacity resolution. */
  readonly stableGridEnvelopeMm?: StableGridEnvelopeMm;
  /** Fixed registration-reserved slots reused by every page after capacity resolution. */
  readonly stableReservedSlotIndices?: readonly number[];
  readonly marginsMm?: PageMarginsMm;
  /** Pair of fixed dimensions for a template-defined stable grid. */
  readonly rows?: number;
  readonly columns?: number;
  /** Zero-based row-major slots omitted by explicit user choice. */
  readonly skippedSlotIndices?: readonly number[];
  /** Physical no-card areas; touching their edge is permitted. */
  readonly reservedZonesMm?: readonly LayoutReservedZoneMm[];
  /** Exact immutable slot geometry supplied by the selected Template Library version. */
  readonly templateGeometry?: TemplateLayoutGeometryMm;
}

export interface GridPlacementMm {
  readonly columns: number;
  readonly rows: number;
  /** Usable positions after user skips and reserved-zone checks. */
  readonly capacity: number;
  readonly gridXmm: number;
  readonly gridYmm: number;
  readonly gridWidthMm: number;
  readonly gridHeightMm: number;
  readonly bleedMm: number;
  readonly pageSizeMm: { readonly widthMm: number; readonly heightMm: number };
  readonly cardSizeMm: { readonly widthMm: number; readonly heightMm: number };
  /** Only slots assigned to cards, in card input order. */
  readonly slots: readonly CardSlotMm[];
  /** Full grid including user-skipped, reserved, and unfilled positions. */
  readonly gridSlots: readonly CardSlotMm[];
}

const PLACEMENT_EPSILON_MM = 1e-9;
const MAX_LAYOUT_RESERVED_ZONES = MAX_REGISTRATION_CUSTOM_MARKS + MAX_REGISTRATION_CUSTOM_ZONES;
const MAX_AUTO_GRID_POSITIONS = 1_128;

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a finite number greater than zero.`);
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite number greater than or equal to zero.`);
}

function orientSize<T extends { readonly widthMm: number; readonly heightMm: number }>(
  size: T,
  orientation: PageOrientation | undefined,
): T {
  if (!orientation) return size;
  if (orientation !== "portrait" && orientation !== "landscape") throw new RangeError("Orientation must be portrait or landscape.");
  const isLandscape = size.widthMm > size.heightMm;
  if ((orientation === "landscape") === isLandscape) return size;
  return { ...size, widthMm: size.heightMm, heightMm: size.widthMm };
}

function overlaps(first: LayoutReservedZoneMm, second: LayoutReservedZoneMm): boolean {
  return first.xMm < second.xMm + second.widthMm - PLACEMENT_EPSILON_MM
    && first.xMm + first.widthMm > second.xMm + PLACEMENT_EPSILON_MM
    && first.yMm < second.yMm + second.heightMm - PLACEMENT_EPSILON_MM
    && first.yMm + first.heightMm > second.yMm + PLACEMENT_EPSILON_MM;
}

function validateZones(zones: readonly LayoutReservedZoneMm[] | undefined, page: PaperFormat): readonly LayoutReservedZoneMm[] {
  const input = zones ?? [];
  if (!Array.isArray(input) || input.length > MAX_LAYOUT_RESERVED_ZONES) {
    throw new RangeError(`At most ${MAX_LAYOUT_RESERVED_ZONES} reserved zones are supported.`);
  }
  return input.map((zone, index) => {
    if (!zone || typeof zone !== "object") throw new RangeError(`Reserved zone ${index + 1} must be a rectangle.`);
    const { xMm, yMm, widthMm, heightMm } = zone;
    if (![xMm, yMm, widthMm, heightMm].every(Number.isFinite)
      || xMm < 0 || yMm < 0 || widthMm <= 0 || heightMm <= 0) {
      throw new RangeError(`Reserved zone ${index + 1} has invalid physical bounds.`);
    }
    if (xMm + widthMm > page.widthMm + PLACEMENT_EPSILON_MM
      || yMm + heightMm > page.heightMm + PLACEMENT_EPSILON_MM) {
      throw new RangeError(`Reserved zone ${index + 1} is outside page bounds.`);
    }
    return Object.freeze({ xMm, yMm, widthMm, heightMm });
  });
}

interface Candidate {
  readonly columns: number;
  readonly rows: number;
  readonly horizontalGapMm: number;
  readonly verticalGapMm: number;
  readonly positions: number;
  readonly columnBleeds: readonly number[];
  readonly rowBleeds: readonly number[];
  readonly gridWidthMm: number;
  readonly gridHeightMm: number;
  readonly aspectError: number;
  readonly capacity: number;
  readonly reservedGridIndices: readonly number[];
}

function candidateFor(
  columns: number,
  rows: number,
  request: GridPlacementRequest,
  page: PaperFormat,
  card: CardFormat,
  margins: PageMarginsMm,
  zones: readonly LayoutReservedZoneMm[],
  skipSet: ReadonlySet<number>,
  bleedByCardMm: readonly number[],
): Candidate | undefined {
  const positions = columns * rows;
  if (skipSet.size && Math.max(...skipSet) >= positions) return undefined;
  const activeGridIndices = Array.from({ length: positions }, (_, index) => index)
    .filter((index) => !skipSet.has(index));
  const horizontalGapMm = request.horizontalGapMm ?? 0;
  const verticalGapMm = request.verticalGapMm ?? 0;
  const availableWidthMm = page.widthMm - margins.left - margins.right;
  const availableHeightMm = page.heightMm - margins.top - margins.bottom;
  const reservedGridIndices = new Set<number>(request.stableReservedSlotIndices ?? []);
  const gridXmm = margins.left;
  const gridYmm = margins.top;
  // Resolve one document-wide slot envelope before pagination. Page-local
  // bleed slices may validate artwork bounds, but can never move another
  // physical trim by changing a row/column offset.
  const stableEnvelope = request.stableGridEnvelopeMm;
  if (stableEnvelope && (stableEnvelope.columnBleedsMm.length !== columns || stableEnvelope.rowBleedsMm.length !== rows)) return undefined;
  const finalColumnBleeds = stableEnvelope
    ? stableEnvelope.columnBleedsMm.map((bleed) => Math.max(request.bleedMm, bleed))
    : Array.from({ length: columns }, () => request.bleedMm);
  const finalRowBleeds = stableEnvelope
    ? stableEnvelope.rowBleedsMm.map((bleed) => Math.max(request.bleedMm, bleed))
    : Array.from({ length: rows }, () => request.bleedMm);
  const documentBleeds = request.documentBleedByCardMm;
  if (!stableEnvelope && documentBleeds === undefined) {
    for (let cardIndex = 0; cardIndex < Math.min(request.count, positions); cardIndex += 1) {
      const bleed = bleedByCardMm[cardIndex] ?? request.bleedMm;
      const column = cardIndex % columns;
      const row = Math.floor(cardIndex / columns);
      finalColumnBleeds[column] = Math.max(finalColumnBleeds[column]!, bleed);
      finalRowBleeds[row] = Math.max(finalRowBleeds[row]!, bleed);
    }
  }
  let gridWidthMm = 0;
  let gridHeightMm = 0;
  let dimensionsFit = false;
  let columnOffsets: number[] = [];
  let rowOffsets: number[] = [];
  const resolveOffsets = () => {
    gridWidthMm = columns * card.widthMm
      + 2 * finalColumnBleeds.reduce((sum, value) => sum + value, 0)
      + Math.max(0, columns - 1) * horizontalGapMm;
    gridHeightMm = rows * card.heightMm
      + 2 * finalRowBleeds.reduce((sum, value) => sum + value, 0)
      + Math.max(0, rows - 1) * verticalGapMm;
    dimensionsFit = gridWidthMm <= availableWidthMm + PLACEMENT_EPSILON_MM
      && gridHeightMm <= availableHeightMm + PLACEMENT_EPSILON_MM;
    columnOffsets = finalColumnBleeds.map((_bleed, column) =>
      gridXmm + finalColumnBleeds.slice(0, column).reduce((sum, value) => sum + card.widthMm + 2 * value + horizontalGapMm, 0));
    rowOffsets = finalRowBleeds.map((_bleed, row) =>
      gridYmm + finalRowBleeds.slice(0, row).reduce((sum, value) => sum + card.heightMm + 2 * value + verticalGapMm, 0));
  };
  let capacity = 0;
  if (!stableEnvelope && documentBleeds !== undefined) {
    // Resolve slot reservations and row/column envelopes as one document-wide
    // fixed point. Physical cards repeat through the same eligible row-major
    // sequence on every page, so a page boundary cannot change a slot mask.
    let resolved = false;
    for (let iteration = 0; iteration <= activeGridIndices.length; iteration += 1) {
      const eligibleIndices = activeGridIndices.filter((index) => !reservedGridIndices.has(index));
      if (eligibleIndices.length === 0) return undefined;
      finalColumnBleeds.fill(request.bleedMm);
      finalRowBleeds.fill(request.bleedMm);
      const bleedsBySlot = new Map<number, number[]>();
      for (let cardIndex = 0; cardIndex < documentBleeds.length; cardIndex += 1) {
        const gridIndex = eligibleIndices[cardIndex % eligibleIndices.length]!;
        const bleed = Math.max(request.bleedMm, documentBleeds[cardIndex]!);
        const slotBleeds = bleedsBySlot.get(gridIndex) ?? [];
        slotBleeds.push(bleed);
        bleedsBySlot.set(gridIndex, slotBleeds);
        const column = gridIndex % columns;
        const row = Math.floor(gridIndex / columns);
        finalColumnBleeds[column] = Math.max(finalColumnBleeds[column]!, bleed);
        finalRowBleeds[row] = Math.max(finalRowBleeds[row]!, bleed);
      }
      resolveOffsets();
      const newlyReserved = eligibleIndices.filter((gridIndex) => {
        const column = gridIndex % columns;
        const row = Math.floor(gridIndex / columns);
        const assignedBleeds = bleedsBySlot.get(gridIndex) ?? [request.bleedMm];
        return assignedBleeds.some((bleed) => zones.some((zone) => overlaps({
          xMm: columnOffsets[column]! + finalColumnBleeds[column]! - bleed,
          yMm: rowOffsets[row]! + finalRowBleeds[row]! - bleed,
          widthMm: card.widthMm + 2 * bleed,
          heightMm: card.heightMm + 2 * bleed,
        }, zone)));
      });
      if (newlyReserved.length > 0) {
        newlyReserved.forEach((index) => reservedGridIndices.add(index));
        if (iteration === activeGridIndices.length) return undefined;
        continue;
      }
      if (!dimensionsFit) return undefined;
      capacity = eligibleIndices.length;
      resolved = true;
      break;
    }
    if (!resolved) return undefined;
  } else {
    resolveOffsets();
    // For page-local placements, a document-wide mask and envelope have
    // already been resolved. This loop is the ordinary standalone placement
    // path and keeps its existing reserved-zone reassignment behavior.
    for (let iteration = 0; iteration <= activeGridIndices.length; iteration += 1) {
      const eligibleIndices = activeGridIndices.filter((index) => !reservedGridIndices.has(index));
      const assignments = new Map(eligibleIndices.slice(0, request.count).map((index, cardIndex) => [index, cardIndex] as const));
      const newlyReserved = eligibleIndices.filter((gridIndex) => {
        const column = gridIndex % columns;
        const row = Math.floor(gridIndex / columns);
        const cardIndex = assignments.get(gridIndex);
        const bleed = cardIndex === undefined
          ? request.bleedMm
          : Math.max(request.bleedMm, bleedByCardMm[cardIndex] ?? request.bleedMm);
        return zones.some((zone) => overlaps({
          xMm: columnOffsets[column]! + finalColumnBleeds[column]! - bleed,
          yMm: rowOffsets[row]! + finalRowBleeds[row]! - bleed,
          widthMm: card.widthMm + 2 * bleed,
          heightMm: card.heightMm + 2 * bleed,
        }, zone));
      });
      if (newlyReserved.length === 0) {
        if (!dimensionsFit) return undefined;
        const assignedBounds = [...assignments].map(([gridIndex, cardIndex]) => {
          const column = gridIndex % columns;
          const row = Math.floor(gridIndex / columns);
          const bleed = bleedByCardMm[cardIndex] ?? request.bleedMm;
          const trimXmm = columnOffsets[column]! + finalColumnBleeds[column]!;
          const trimYmm = rowOffsets[row]! + finalRowBleeds[row]!;
          return {
            gridIndex,
            column,
            row,
            bounds: {
              xMm: trimXmm - bleed,
              yMm: trimYmm - bleed,
              widthMm: card.widthMm + 2 * bleed,
              heightMm: card.heightMm + 2 * bleed,
            },
          };
        });
        if (assignedBounds.some(({ bounds }) => bounds.xMm < margins.left - PLACEMENT_EPSILON_MM
          || bounds.yMm < margins.top - PLACEMENT_EPSILON_MM
          || bounds.xMm + bounds.widthMm > page.widthMm - margins.right + PLACEMENT_EPSILON_MM
          || bounds.yMm + bounds.heightMm > page.heightMm - margins.bottom + PLACEMENT_EPSILON_MM)) return undefined;
        for (let firstIndex = 0; firstIndex < assignedBounds.length; firstIndex += 1) {
          const first = assignedBounds[firstIndex]!;
          for (let secondIndex = firstIndex + 1; secondIndex < assignedBounds.length; secondIndex += 1) {
            const second = assignedBounds[secondIndex]!;
            if (overlaps(first.bounds, second.bounds)) return undefined;
            if (second.row === first.row && second.column === first.column + 1
              && second.bounds.xMm - (first.bounds.xMm + first.bounds.widthMm) < horizontalGapMm - PLACEMENT_EPSILON_MM) return undefined;
            if (second.column === first.column && second.row === first.row + 1
              && second.bounds.yMm - (first.bounds.yMm + first.bounds.heightMm) < verticalGapMm - PLACEMENT_EPSILON_MM) return undefined;
          }
        }
        capacity = eligibleIndices.length;
        break;
      }
      if (request.stableReservedSlotIndices !== undefined) {
        throw new RangeError("Resolved document reserved-slot mask does not cover a page-local registration collision.");
      }
      newlyReserved.forEach((index) => reservedGridIndices.add(index));
      if (iteration === activeGridIndices.length) return undefined;
    }
  }
  if (capacity === 0 && activeGridIndices.length > 0 && reservedGridIndices.size < activeGridIndices.length) return undefined;

  return {
    columns,
    rows,
    horizontalGapMm,
    verticalGapMm,
    positions,
    columnBleeds: finalColumnBleeds,
    rowBleeds: finalRowBleeds,
    gridWidthMm,
    gridHeightMm,
    aspectError: Math.abs(Math.log((gridWidthMm / gridHeightMm) / (availableWidthMm / availableHeightMm))),
    capacity,
    reservedGridIndices: [...reservedGridIndices],
  };
}

/**
 * Makes a top-left anchored, row-major capacity grid while reserving external bleed.
 * Automatic grid shape and coordinates are independent of the current card
 * count. User skips keep their stable grid index; reserved zones stay separate.
 */
export function calculateGridPlacement(request: GridPlacementRequest): GridPlacementMm {
  const templateGeometry = request.templateGeometry === undefined ? undefined : parseTemplateLayoutGeometry(request.templateGeometry);
  const pageOrientation = request.pageOrientation ?? templateGeometry?.orientation;
  const page = orientSize(request.paper, pageOrientation);
  const card = orientSize(request.card, request.cardOrientation);
  assertPositive(page.widthMm, "Paper width");
  assertPositive(page.heightMm, "Paper height");
  assertPositive(card.widthMm, "Card width");
  assertPositive(card.heightMm, "Card height");
  const { count, bleedMm } = request;
  if (!Number.isInteger(count) || count < 0) throw new RangeError("Card count must be a non-negative integer.");
  assertNonNegative(bleedMm, "Bleed");
  if (bleedMm > 3) throw new RangeError("Bleed must not exceed 3 mm.");
  const horizontalGapMm = request.horizontalGapMm ?? 0;
  const verticalGapMm = request.verticalGapMm ?? 0;
  assertNonNegative(horizontalGapMm, "Horizontal gap");
  assertNonNegative(verticalGapMm, "Vertical gap");
  if (horizontalGapMm > 2_000 || verticalGapMm > 2_000) throw new RangeError("Layout gaps must not exceed 2000 mm.");
  if (request.bleedByCardMm && request.bleedByCardMm.length !== count) {
    throw new RangeError("Per-card bleed values must contain one value per requested card.");
  }
  for (const value of request.documentBleedByCardMm ?? []) {
    assertNonNegative(value, "Document per-card bleed");
    if (value > 3) throw new RangeError("Bleed must not exceed 3 mm.");
  }
  if (request.stableGridEnvelopeMm) {
    for (const value of [...request.stableGridEnvelopeMm.columnBleedsMm, ...request.stableGridEnvelopeMm.rowBleedsMm]) {
      assertNonNegative(value, "Stable grid envelope bleed");
      if (value > 3) throw new RangeError("Bleed must not exceed 3 mm.");
    }
  }
  const bleedByCardMm = request.bleedByCardMm ?? Array.from({ length: count }, () => bleedMm);
  for (const value of bleedByCardMm) {
    assertNonNegative(value, "Per-card bleed");
    if (value > 3) throw new RangeError("Bleed must not exceed 3 mm.");
  }
  const margins = request.marginsMm ?? { top: 0, right: 0, bottom: 0, left: 0 };
  for (const side of ["top", "right", "bottom", "left"] as const) {
    assertNonNegative(margins[side], `Page margin ${side}`);
    if (margins[side] > 2_000) throw new RangeError(`Page margin ${side} must not exceed 2000 mm.`);
  }
  const zones = validateZones(request.reservedZonesMm, page);
  const skipped = request.skippedSlotIndices ?? [];
  if (!Array.isArray(skipped) || skipped.length > 1_128
    || skipped.some((index) => !Number.isSafeInteger(index) || index < 0)
    || new Set(skipped).size !== skipped.length) {
    throw new RangeError("Skipped slot indices must be unique non-negative integers within the grid.");
  }
  const skipSet = new Set(skipped);
  if ((request.rows === undefined) !== (request.columns === undefined)) {
    throw new RangeError("Rows and columns must be supplied together for a fixed grid.");
  }
  const fixed = request.rows !== undefined && request.columns !== undefined;
  if (skipped.length > 0 && !fixed && !templateGeometry) {
    throw new RangeError("Skipped slots require a fixed grid or exact template geometry so other slot positions remain stable.");
  }
  if (request.stableReservedSlotIndices) {
    const stablePositionCount = fixed
      ? request.rows! * request.columns!
      : templateGeometry ? templateGeometry.rows * templateGeometry.columns : undefined;
    if (stablePositionCount === undefined || !Number.isSafeInteger(stablePositionCount)
      || request.stableReservedSlotIndices.length > 1_128
      || request.stableReservedSlotIndices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= stablePositionCount)
      || new Set(request.stableReservedSlotIndices).size !== request.stableReservedSlotIndices.length) {
      throw new RangeError("Stable reserved slot indices must be unique indexes within a fixed grid or template geometry.");
    }
  }
  if (templateGeometry) {
    return buildTemplatePlacement({ request, geometry: templateGeometry, page, card, margins, zones, skipSet, bleedByCardMm, bleedMm, horizontalGapMm, verticalGapMm });
  }

  const availableWidthMm = page.widthMm - margins.left - margins.right;
  const availableHeightMm = page.heightMm - margins.top - margins.bottom;
  if (availableWidthMm <= 0 || availableHeightMm <= 0) throw new RangeError("No physical card slot fits inside the page margins.");
  const maximumColumns = Math.floor((availableWidthMm + horizontalGapMm + PLACEMENT_EPSILON_MM) / (card.widthMm + 2 * bleedMm + horizontalGapMm));
  const maximumRows = Math.floor((availableHeightMm + verticalGapMm + PLACEMENT_EPSILON_MM) / (card.heightMm + 2 * bleedMm + verticalGapMm));
  if (maximumColumns < 1 || maximumRows < 1) {
    throw new RangeError("No physical card slot fits on the selected paper inside the requested margins with the requested bleed and gaps.");
  }
  if (fixed && (!Number.isSafeInteger(request.rows) || request.rows! < 1
    || !Number.isSafeInteger(request.columns) || request.columns! < 1
    || request.rows! * request.columns! > MAX_AUTO_GRID_POSITIONS)) {
    throw new RangeError(`Fixed grid dimensions must be positive integers with at most ${MAX_AUTO_GRID_POSITIONS} positions.`);
  }
  if (fixed && skipped.some((index) => index >= request.rows! * request.columns!)) {
    throw new RangeError("A skipped slot index is outside the fixed grid.");
  }
  const candidates: Candidate[] = [];
  const columnOptions = fixed ? [request.columns!] : Array.from({ length: maximumColumns }, (_, index) => index + 1);
  for (const columns of columnOptions) {
    const maximumCandidateRows = fixed
      ? request.rows!
      : Math.min(maximumRows, Math.floor(MAX_AUTO_GRID_POSITIONS / columns));
    for (let rows = 1; rows <= maximumCandidateRows; rows += 1) {
      const positions = columns * rows;
      if (columns > maximumColumns || rows > maximumRows || positions > MAX_AUTO_GRID_POSITIONS) continue;
      // Evaluate every possible shape but validate collisions only for the
      // cards actually assigned on this page.
      const candidate = candidateFor(columns, rows, request, page, card, margins, zones, skipSet, bleedByCardMm);
      if (candidate && candidate.capacity >= count) candidates.push(candidate);
    }
  }
  if (candidates.length === 0) {
    const reason = zones.length > 0 ? " after applying reserved zones" : "";
    throw new RangeError(`No physical card slot fits the requested ${count} card slots with the configured margins, bleed, and gaps${reason}; card size and bleed were preserved.`);
  }
  candidates.sort((a, b) => b.capacity - a.capacity || a.aspectError - b.aspectError || (b.gridWidthMm * b.gridHeightMm) - (a.gridWidthMm * a.gridHeightMm));
  return buildPlacement(candidates[0], page, card, margins, zones, skipSet, count, bleedByCardMm, bleedMm);
}

function buildTemplatePlacement(input: {
  readonly request: GridPlacementRequest;
  readonly geometry: TemplateLayoutGeometryMm;
  readonly page: PaperFormat;
  readonly card: CardFormat;
  readonly margins: PageMarginsMm;
  readonly zones: readonly LayoutReservedZoneMm[];
  readonly skipSet: ReadonlySet<number>;
  readonly bleedByCardMm: readonly number[];
  readonly bleedMm: number;
  readonly horizontalGapMm: number;
  readonly verticalGapMm: number;
}): GridPlacementMm {
  const { request, geometry, page, card, margins, zones, skipSet, bleedByCardMm, bleedMm, horizontalGapMm, verticalGapMm } = input;
  const requestedOrientation = request.pageOrientation ?? geometry.orientation;
  const rotate = requestedOrientation !== geometry.orientation;
  const templatePage = rotate
    ? { widthMm: geometry.pageSizeMm.heightMm, heightMm: geometry.pageSizeMm.widthMm }
    : geometry.pageSizeMm;
  const templateCard = rotate
    ? { widthMm: geometry.cardSizeMm.heightMm, heightMm: geometry.cardSizeMm.widthMm }
    : geometry.cardSizeMm;
  const nearlyEqual = (left: number, right: number) => Math.abs(left - right) <= PLACEMENT_EPSILON_MM;
  if (!nearlyEqual(page.widthMm, templatePage.widthMm) || !nearlyEqual(page.heightMm, templatePage.heightMm)) {
    throw new RangeError("Selected paper dimensions do not match the immutable template page dimensions in the chosen page orientation.");
  }
  if (!nearlyEqual(card.widthMm, templateCard.widthMm) || !nearlyEqual(card.heightMm, templateCard.heightMm)) {
    throw new RangeError("Selected card dimensions do not match the immutable template card dimensions in the chosen card orientation.");
  }
  if ((request.rows !== undefined && request.rows !== geometry.rows)
    || (request.columns !== undefined && request.columns !== geometry.columns)) {
    throw new RangeError("Manual grid dimensions conflict with the selected template's immutable rows and columns.");
  }
  const slotByIndex = new Map(geometry.slots.map((slot) => [slot.index, slot] as const));
  if ([...skipSet].some((index) => !slotByIndex.has(index))) {
    throw new RangeError("A skipped slot index does not exist in the selected template geometry.");
  }
  if (request.count > geometry.slots.length) {
    throw new RangeError(`Selected template has only ${geometry.slots.length} physical slots for ${request.count} requested cards.`);
  }
  const expectedBleed = Math.max(bleedMm, ...bleedByCardMm);
  const slots = geometry.slots.map((templateSlot) => {
    const xMm = rotate
      ? geometry.orientation === "portrait"
        ? geometry.pageSizeMm.heightMm - (templateSlot.yMm + geometry.cardSizeMm.heightMm)
        : templateSlot.yMm
      : templateSlot.xMm;
    const yMm = rotate
      ? geometry.orientation === "portrait"
        ? templateSlot.xMm
        : geometry.pageSizeMm.widthMm - (templateSlot.xMm + geometry.cardSizeMm.widthMm)
      : templateSlot.yMm;
    return { ...templateSlot, xMm, yMm };
  });
  const assignedSlotIndices: number[] = [];
  const reservedSlotIndices = new Set<number>(request.stableReservedSlotIndices ?? []);
  const documentBleeds = request.documentBleedByCardMm;
  if (documentBleeds !== undefined && request.stableReservedSlotIndices === undefined) {
    let resolved = false;
    for (let iteration = 0; iteration <= slots.length; iteration += 1) {
      const eligibleSlots = slots.filter((slot) => !skipSet.has(slot.index) && !reservedSlotIndices.has(slot.index));
      if (eligibleSlots.length === 0) {
        resolved = true;
        break;
      }
      const bleedsBySlot = new Map<number, number[]>();
      for (let documentCardIndex = 0; documentCardIndex < documentBleeds.length; documentCardIndex += 1) {
        const slot = eligibleSlots[documentCardIndex % eligibleSlots.length]!;
        const requestedBleed = Math.max(bleedMm, documentBleeds[documentCardIndex]!);
        const slotBleeds = bleedsBySlot.get(slot.index) ?? [];
        slotBleeds.push(requestedBleed);
        bleedsBySlot.set(slot.index, slotBleeds);
      }
      const newlyReserved = eligibleSlots.filter((slot) => {
        const assignedBleeds = bleedsBySlot.get(slot.index) ?? [bleedMm];
        return assignedBleeds.some((requestedBleed) => {
          const bounds = {
            xMm: slot.xMm - requestedBleed,
            yMm: slot.yMm - requestedBleed,
            widthMm: card.widthMm + 2 * requestedBleed,
            heightMm: card.heightMm + 2 * requestedBleed,
          };
          return zones.some((zone) => overlaps(bounds, zone));
        });
      });
      if (newlyReserved.length === 0) {
        resolved = true;
        break;
      }
      newlyReserved.forEach((slot) => reservedSlotIndices.add(slot.index));
      if (iteration === slots.length) break;
    }
    if (!resolved) throw new RangeError("Unable to resolve stable registration-reserved template slots.");
  }
  const perSlotBleed = new Map<number, number>();
  let cardIndex = 0;
  for (const slot of slots) {
    if (skipSet.has(slot.index)) continue;
    if (reservedSlotIndices.has(slot.index)) continue;
    const slotBleed = bleedByCardMm[cardIndex] ?? bleedMm;
    const bounds = {
      xMm: slot.xMm - slotBleed,
      yMm: slot.yMm - slotBleed,
      widthMm: card.widthMm + 2 * slotBleed,
      heightMm: card.heightMm + 2 * slotBleed,
    };
    const reserved = zones.some((zone) => overlaps(bounds, zone));
    if (reserved) {
      if (request.stableReservedSlotIndices !== undefined || documentBleeds !== undefined) {
        throw new RangeError(`Template slot ${slot.index + 1} collides with a registration zone after document-wide bleed resolution.`);
      }
      reservedSlotIndices.add(slot.index);
    }
    else {
      perSlotBleed.set(slot.index, slotBleed);
      if (assignedSlotIndices.length < request.count) assignedSlotIndices.push(slot.index);
      cardIndex += 1;
    }
  }
  const capacity = slots.length - skipSet.size - reservedSlotIndices.size;
  if (capacity < request.count) {
    throw new RangeError(`Selected template has capacity ${capacity} after skipped slots, requested bleed, and registration reserved zones; card size and bleed were preserved.`);
  }
  const mappedSlots = slots.map((slot) => {
    const slotBleed = perSlotBleed.get(slot.index) ?? bleedMm;
    const reserved = reservedSlotIndices.has(slot.index);
    const outer = {
      xMm: slot.xMm - slotBleed,
      yMm: slot.yMm - slotBleed,
      widthMm: card.widthMm + 2 * slotBleed,
      heightMm: card.heightMm + 2 * slotBleed,
    };
    if (outer.xMm < margins.left - PLACEMENT_EPSILON_MM || outer.yMm < margins.top - PLACEMENT_EPSILON_MM
      || outer.xMm + outer.widthMm > page.widthMm - margins.right + PLACEMENT_EPSILON_MM
      || outer.yMm + outer.heightMm > page.heightMm - margins.bottom + PLACEMENT_EPSILON_MM) {
      throw new RangeError(`Template slot ${slot.index + 1} with requested bleed falls outside the selected page margins; exact template position was preserved.`);
    }
    if (assignedSlotIndices.includes(slot.index)) {
      for (const zone of zones) {
        if (overlaps(outer, zone)) {
          throw new RangeError(`Template slot ${slot.index + 1} overlaps a registration reserved zone; exact template position, card size, and bleed were preserved.`);
        }
      }
    }
    return Object.freeze({
      index: slot.index,
      column: slot.column,
      row: slot.row,
      slotXmm: outer.xMm,
      slotYmm: outer.yMm,
      slotWidthMm: outer.widthMm,
      slotHeightMm: outer.heightMm,
      trim: Object.freeze({ xMm: slot.xMm, yMm: slot.yMm, widthMm: card.widthMm, heightMm: card.heightMm }),
      skippedByUser: skipSet.has(slot.index),
      reserved,
      ...(assignedSlotIndices.includes(slot.index) ? { cardIndex: assignedSlotIndices.indexOf(slot.index) } : {}),
    });
  });
  const eligibleTemplateSlots = mappedSlots.filter((slot) =>
    !slot.skippedByUser && !reservedSlotIndices.has(slot.index) && perSlotBleed.has(slot.index));
  for (let firstIndex = 0; firstIndex < eligibleTemplateSlots.length; firstIndex += 1) {
    const first = eligibleTemplateSlots[firstIndex]!;
    const firstBleed = perSlotBleed.get(first.index)!;
    const firstBounds = {
      xMm: first.trim.xMm - firstBleed,
      yMm: first.trim.yMm - firstBleed,
      widthMm: first.trim.widthMm + 2 * firstBleed,
      heightMm: first.trim.heightMm + 2 * firstBleed,
    };
    for (let secondIndex = firstIndex + 1; secondIndex < eligibleTemplateSlots.length; secondIndex += 1) {
      const second = eligibleTemplateSlots[secondIndex]!;
      const secondBleed = perSlotBleed.get(second.index)!;
      const secondBounds = {
        xMm: second.trim.xMm - secondBleed,
        yMm: second.trim.yMm - secondBleed,
        widthMm: second.trim.widthMm + 2 * secondBleed,
        heightMm: second.trim.heightMm + 2 * secondBleed,
      };
      if (overlaps(firstBounds, secondBounds)) {
        throw new RangeError(`Template slots ${first.index + 1} and ${second.index + 1} overlap after requested bleed; exact template positions, card size, and bleed were preserved.`);
      }
    }
  }
  const trimLeft = Math.min(...mappedSlots.map(({ trim }) => trim.xMm));
  const trimTop = Math.min(...mappedSlots.map(({ trim }) => trim.yMm));
  const boundsRight = Math.max(...mappedSlots.map(({ slotXmm, slotWidthMm }) => slotXmm + slotWidthMm));
  const boundsBottom = Math.max(...mappedSlots.map(({ slotYmm, slotHeightMm }) => slotYmm + slotHeightMm));

  // Gaps are minimum clear distances between adjacent template slots in the declared grid.
  for (const left of mappedSlots) {
    const right = mappedSlots.find((candidate) => candidate.row === left.row && candidate.column === left.column + 1);
    if (right && !left.skippedByUser && !right.skippedByUser && !left.reserved && !right.reserved
      && right.trim.xMm - (left.trim.xMm + left.trim.widthMm + perSlotBleed.get(left.index)! + perSlotBleed.get(right.index)!)
      < horizontalGapMm - PLACEMENT_EPSILON_MM) {
      throw new RangeError(`Template slots ${left.index + 1} and ${right.index + 1} do not satisfy the requested horizontal gap; exact template positions were preserved.`);
    }
    const below = mappedSlots.find((candidate) => candidate.column === left.column && candidate.row === left.row + 1);
    if (below && !left.skippedByUser && !below.skippedByUser && !left.reserved && !below.reserved
      && below.trim.yMm - (left.trim.yMm + left.trim.heightMm + perSlotBleed.get(left.index)! + perSlotBleed.get(below.index)!)
      < verticalGapMm - PLACEMENT_EPSILON_MM) {
      throw new RangeError(`Template slots ${left.index + 1} and ${below.index + 1} do not satisfy the requested vertical gap; exact template positions were preserved.`);
    }
  }
  const activeSlots = mappedSlots.filter(({ cardIndex: assigned }) => assigned !== undefined);
  return Object.freeze({
    columns: geometry.columns,
    rows: geometry.rows,
    capacity,
    gridXmm: trimLeft,
    gridYmm: trimTop,
    gridWidthMm: boundsRight - Math.min(...mappedSlots.map(({ slotXmm }) => slotXmm)),
    gridHeightMm: boundsBottom - Math.min(...mappedSlots.map(({ slotYmm }) => slotYmm)),
    bleedMm: expectedBleed,
    pageSizeMm: Object.freeze({ widthMm: page.widthMm, heightMm: page.heightMm }),
    cardSizeMm: Object.freeze({ widthMm: card.widthMm, heightMm: card.heightMm }),
    slots: Object.freeze(activeSlots),
    gridSlots: Object.freeze(mappedSlots),
  });
}

function buildPlacement(
  selected: Candidate,
  page: PaperFormat,
  card: CardFormat,
  margins: PageMarginsMm,
  zones: readonly LayoutReservedZoneMm[],
  skipSet: ReadonlySet<number>,
  count: number,
  bleedByCardMm: readonly number[],
  bleedMm: number,
): GridPlacementMm {
  const gridXmm = margins.left;
  const gridYmm = margins.top;
  const columnOffsets = selected.columnBleeds.map((_bleed, column) =>
    gridXmm + selected.columnBleeds.slice(0, column).reduce((sum, value) => sum + card.widthMm + 2 * value + selected.horizontalGapMm, 0));
  const rowOffsets = selected.rowBleeds.map((_bleed, row) =>
    gridYmm + selected.rowBleeds.slice(0, row).reduce((sum, value) => sum + card.heightMm + 2 * value + selected.verticalGapMm, 0));
  const activeGridIndices = Array.from({ length: selected.positions }, (_, index) => index)
    .filter((index) => !skipSet.has(index));
  const reservedGridIndices = new Set(selected.reservedGridIndices);
  const assignments = new Map<number, number>();
  let assignedCardIndex = 0;
  for (const index of activeGridIndices) {
    if (reservedGridIndices.has(index)) continue;
    if (assignedCardIndex < count) assignments.set(index, assignedCardIndex++);
  }
  if (assignedCardIndex !== count) throw new RangeError("No physical card slots remain after reserved-zone validation.");
  for (const [index, cardIndex] of assignments) {
    const column = index % selected.columns;
    const row = Math.floor(index / selected.columns);
    const bleed = bleedByCardMm[cardIndex] ?? bleedMm;
    const trimXmm = columnOffsets[column]! + selected.columnBleeds[column]!;
    const trimYmm = rowOffsets[row]! + selected.rowBleeds[row]!;
    const actualCardBounds = {
      xMm: trimXmm - bleed,
      yMm: trimYmm - bleed,
      widthMm: card.widthMm + 2 * bleed,
      heightMm: card.heightMm + 2 * bleed,
    };
    if (zones.some((zone) => overlaps(actualCardBounds, zone))) {
      throw new RangeError(`Card slot ${index + 1} overlaps a registration reserved zone after requested bleed was applied.`);
    }
  }
  const gridSlots = Array.from({ length: selected.positions }, (_, index) => {
    const column = index % selected.columns;
    const row = Math.floor(index / selected.columns);
    const slotXmm = columnOffsets[column];
    const slotYmm = rowOffsets[row];
    const columnBleedMm = selected.columnBleeds[column];
    const rowBleedMm = selected.rowBleeds[row];
    const bounds = {
      xMm: slotXmm,
      yMm: slotYmm,
      widthMm: card.widthMm + 2 * columnBleedMm,
      heightMm: card.heightMm + 2 * rowBleedMm,
    };
    const skippedSlotIntersectsZone = skipSet.has(index) && zones.some((zone) => overlaps({
      xMm: slotXmm + columnBleedMm - bleedMm,
      yMm: slotYmm + rowBleedMm - bleedMm,
      widthMm: card.widthMm + 2 * bleedMm,
      heightMm: card.heightMm + 2 * bleedMm,
    }, zone));
    const reserved = reservedGridIndices.has(index) || skippedSlotIntersectsZone;
    return Object.freeze({
      index,
      column,
      row,
      slotXmm,
      slotYmm,
      slotWidthMm: bounds.widthMm,
      slotHeightMm: bounds.heightMm,
      trim: Object.freeze({
        xMm: slotXmm + columnBleedMm,
        yMm: slotYmm + rowBleedMm,
        widthMm: card.widthMm,
        heightMm: card.heightMm,
      }),
      skippedByUser: skipSet.has(index),
      reserved,
      ...(assignments.has(index) ? { cardIndex: assignments.get(index)! } : {}),
    });
  });
  const slots = gridSlots.filter((slot) => slot.cardIndex !== undefined);

  return Object.freeze({
    columns: selected.columns,
    rows: selected.rows,
    capacity: selected.capacity,
    gridXmm,
    gridYmm,
    gridWidthMm: selected.gridWidthMm,
    gridHeightMm: selected.gridHeightMm,
    bleedMm: Math.max(bleedMm, ...selected.columnBleeds, ...selected.rowBleeds),
    pageSizeMm: Object.freeze({ widthMm: page.widthMm, heightMm: page.heightMm }),
    cardSizeMm: Object.freeze({ widthMm: card.widthMm, heightMm: card.heightMm }),
    slots: Object.freeze(slots),
    gridSlots: Object.freeze(gridSlots),
  });
}
