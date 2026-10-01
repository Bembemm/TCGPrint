import { calculateGridPagePlacements, parseTemplateLayoutGeometry, type GridPlacementMm, type PageOrientation, type TemplateLayoutGeometryMm } from "../../core/geometry";
import { createCutGeometryMm, createRectangularCutPathMm, type CutGeometryMm, type CutPathMm, type CutPointMm, type CutSegmentMm } from "../../core/cut";
import { generateRegistrationGeometry } from "../../core/registration";
import type { ProjectSettingsV2 } from "../../persistence/projects/serializer";
import { CutSourceError } from "./errors";

export const CUT_LAYOUT_SYNC_TOLERANCE_MM = 0.000001;

export interface CutPathSlotState {
  readonly slotIndex: number;
  readonly pathId: string;
  readonly state: "active" | "skipped" | "reserved" | "empty";
}

export interface CutLayoutResolution {
  readonly sourceGeometry: CutGeometryMm;
  readonly activeGeometry: CutGeometryMm | null;
  readonly placement: GridPlacementMm;
  readonly slotPaths: readonly CutPathSlotState[];
  readonly derivedTemplateGeometry?: TemplateLayoutGeometryMm;
}

function orientedDimensions(size: { readonly widthMm: number; readonly heightMm: number }, orientation: PageOrientation): { readonly widthMm: number; readonly heightMm: number } {
  const landscape = size.widthMm > size.heightMm;
  return landscape === (orientation === "landscape")
    ? { widthMm: size.widthMm, heightMm: size.heightMm }
    : { widthMm: size.heightMm, heightMm: size.widthMm };
}

function affinePoint(point: CutPointMm, matrix: readonly [number, number, number, number, number, number]): CutPointMm {
  return { xMm: matrix[0] * point.xMm + matrix[2] * point.yMm + matrix[4], yMm: matrix[1] * point.xMm + matrix[3] * point.yMm + matrix[5] };
}

function affineVector(point: CutPointMm, matrix: readonly [number, number, number, number, number, number]): CutPointMm {
  return { xMm: matrix[0] * point.xMm + matrix[2] * point.yMm, yMm: matrix[1] * point.xMm + matrix[3] * point.yMm };
}

function mapSegment(segment: CutSegmentMm, matrix: readonly [number, number, number, number, number, number]): CutSegmentMm {
  const map = (point: CutPointMm) => affinePoint(point, matrix);
  if (segment.type === "line") return { type: "line", from: map(segment.from), to: map(segment.to) };
  if (segment.type === "quadratic") return { type: "quadratic", from: map(segment.from), control: map(segment.control), to: map(segment.to) };
  if (segment.type === "cubic") return { type: "cubic", from: map(segment.from), control1: map(segment.control1), control2: map(segment.control2), to: map(segment.to) };
  return {
    type: "arc",
    from: map(segment.from),
    to: map(segment.to),
    center: map(segment.center),
    axisU: affineVector(segment.axisU, matrix),
    axisV: affineVector(segment.axisV, matrix),
    startAngleRad: segment.startAngleRad,
    sweepAngleRad: segment.sweepAngleRad,
  };
}

/** Rotates one immutable template page by a quarter turn without adjusting any path scale or offset. */
export function rotateCutGeometryToOrientation(
  geometry: CutGeometryMm,
  sourceOrientation: PageOrientation,
  targetOrientation: PageOrientation,
): CutGeometryMm {
  if (sourceOrientation === targetOrientation) return geometry;
  const { widthMm, heightMm } = geometry.pageSizeMm;
  const matrix: readonly [number, number, number, number, number, number] = sourceOrientation === "portrait"
    ? [0, 1, -1, 0, heightMm, 0]
    : [0, -1, 1, 0, 0, widthMm];
  return createCutGeometryMm({
    source: geometry.source,
    pageSizeMm: { widthMm: heightMm, heightMm: widthMm },
    paths: geometry.paths.map((path) => ({
      id: path.id,
      start: affinePoint(path.start, matrix),
      closed: path.closed,
      segments: path.segments.map((segment) => mapSegment(segment, matrix)),
    })),
  });
}

function uniqueCoordinates(values: readonly number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  const result: number[] = [];
  for (const value of sorted) {
    if (result.length === 0 || Math.abs(value - result[result.length - 1]!) > CUT_LAYOUT_SYNC_TOLERANCE_MM) result.push(value);
  }
  return result;
}

function nearestIndex(values: readonly number[], value: number): number | undefined {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const current = values[middle]!;
    if (Math.abs(current - value) <= CUT_LAYOUT_SYNC_TOLERANCE_MM) return middle;
    if (current < value) low = middle + 1;
    else high = middle - 1;
  }
  for (const index of [low - 1, low]) {
    if (index >= 0 && index < values.length && Math.abs(values[index]! - value) <= CUT_LAYOUT_SYNC_TOLERANCE_MM) return index;
  }
  return undefined;
}

/** Derives only a complete orthogonal grid whose paths match the explicit card trim size. */
export function deriveTemplateLayoutFromCutGeometry(
  geometry: CutGeometryMm,
  cardSizeMm: { readonly widthMm: number; readonly heightMm: number },
  orientation: PageOrientation,
  cardOrientation: PageOrientation,
): TemplateLayoutGeometryMm {
  const xCoordinates = uniqueCoordinates(geometry.paths.map(({ boundsMm }) => boundsMm.xMm));
  const yCoordinates = uniqueCoordinates(geometry.paths.map(({ boundsMm }) => boundsMm.yMm));
  if (xCoordinates.length * yCoordinates.length !== geometry.paths.length) {
    throw new CutSourceError("CUT_LAYOUT_MISMATCH", "Cut file does not describe a complete rectangular grid; provide explicit immutable templateGeometry.");
  }
  if (xCoordinates.length * yCoordinates.length > 1_128) throw new CutSourceError("CUT_LAYOUT_MISMATCH", "Cut layout exceeds the 1128-slot limit.");
  const slots = new Array<{ index: number; row: number; column: number; xMm: number; yMm: number }>(geometry.paths.length);
  const occupied = new Set<number>();
  for (const path of geometry.paths) {
    if (!path.closed || Math.abs(path.boundsMm.widthMm - cardSizeMm.widthMm) > CUT_LAYOUT_SYNC_TOLERANCE_MM
      || Math.abs(path.boundsMm.heightMm - cardSizeMm.heightMm) > CUT_LAYOUT_SYNC_TOLERANCE_MM) {
      throw new CutSourceError("CUT_LAYOUT_MISMATCH", `Cut path ${path.id} is not one closed trim path with the configured ${cardSizeMm.widthMm} × ${cardSizeMm.heightMm} mm card size.`);
    }
    const column = nearestIndex(xCoordinates, path.boundsMm.xMm);
    const row = nearestIndex(yCoordinates, path.boundsMm.yMm);
    if (row === undefined || column === undefined) throw new CutSourceError("CUT_LAYOUT_MISMATCH", `Cut path ${path.id} does not fit a stable row/column grid.`);
    const index = row * xCoordinates.length + column;
    if (occupied.has(index)) throw new CutSourceError("CUT_LAYOUT_MISMATCH", `Multiple cut paths occupy template slot ${index + 1}.`);
    occupied.add(index);
    slots[index] = { index, row, column, xMm: path.boundsMm.xMm, yMm: path.boundsMm.yMm };
  }
  return parseTemplateLayoutGeometry({
    orientation,
    cardOrientation,
    pageSizeMm: geometry.pageSizeMm,
    cardSizeMm,
    rows: yCoordinates.length,
    columns: xCoordinates.length,
    slots,
  });
}

function normalizedCoordinate(value: number): number {
  return Math.round(value / CUT_LAYOUT_SYNC_TOLERANCE_MM);
}

function pathMatchKey(x: number, y: number, width: number, height: number): string {
  return `${normalizedCoordinate(x)}:${normalizedCoordinate(y)}:${normalizedCoordinate(width)}:${normalizedCoordinate(height)}`;
}

function matchSourcePaths(geometry: CutGeometryMm, placement: GridPlacementMm): Map<number, CutPathMm> {
  if (Math.abs(geometry.pageSizeMm.widthMm - placement.pageSizeMm.widthMm) > CUT_LAYOUT_SYNC_TOLERANCE_MM
    || Math.abs(geometry.pageSizeMm.heightMm - placement.pageSizeMm.heightMm) > CUT_LAYOUT_SYNC_TOLERANCE_MM) {
    throw new CutSourceError("CUT_LAYOUT_MISMATCH", "SVG/DXF physical page dimensions do not match the PDF layout page.");
  }
  if (geometry.paths.length !== placement.gridSlots.length) {
    throw new CutSourceError("CUT_LAYOUT_MISMATCH", `Cut file has ${geometry.paths.length} paths for ${placement.gridSlots.length} template slots; export is blocked.`);
  }
  const slotsByKey = new Map<string, number[]>();
  const slotByIndex = new Map(placement.gridSlots.map((slot) => [slot.index, slot]));
  for (const slot of placement.gridSlots) {
    const bounds = slot.trim;
    const key = pathMatchKey(bounds.xMm, bounds.yMm, bounds.widthMm, bounds.heightMm);
    slotsByKey.set(key, [...(slotsByKey.get(key) ?? []), slot.index]);
  }
  const pathBySlot = new Map<number, CutPathMm>();
  for (const path of geometry.paths) {
    if (!path.closed) throw new CutSourceError("CUT_LAYOUT_MISMATCH", `Cut path ${path.id} is open; one closed cut path per template slot is required.`);
    const b = path.boundsMm;
    let matchedIndex: number | undefined;
    for (let dx = -1; dx <= 1 && matchedIndex === undefined; dx += 1) {
      for (let dy = -1; dy <= 1 && matchedIndex === undefined; dy += 1) {
        for (let dw = -1; dw <= 1 && matchedIndex === undefined; dw += 1) {
          for (let dh = -1; dh <= 1 && matchedIndex === undefined; dh += 1) {
            const candidates = slotsByKey.get(`${normalizedCoordinate(b.xMm) + dx}:${normalizedCoordinate(b.yMm) + dy}:${normalizedCoordinate(b.widthMm) + dw}:${normalizedCoordinate(b.heightMm) + dh}`) ?? [];
            matchedIndex = candidates.find((slotIndex) => {
              const slot = slotByIndex.get(slotIndex)!;
              return Math.abs(b.xMm - slot.trim.xMm) <= CUT_LAYOUT_SYNC_TOLERANCE_MM
                && Math.abs(b.yMm - slot.trim.yMm) <= CUT_LAYOUT_SYNC_TOLERANCE_MM
                && Math.abs(b.widthMm - slot.trim.widthMm) <= CUT_LAYOUT_SYNC_TOLERANCE_MM
                && Math.abs(b.heightMm - slot.trim.heightMm) <= CUT_LAYOUT_SYNC_TOLERANCE_MM
                && !pathBySlot.has(slotIndex);
            });
          }
        }
      }
    }
    if (matchedIndex === undefined) throw new CutSourceError("CUT_LAYOUT_MISMATCH", `Cut path ${path.id} does not coincide with a PDF trim rectangle within ${CUT_LAYOUT_SYNC_TOLERANCE_MM} mm.`);
    pathBySlot.set(matchedIndex, path);
  }
  if (pathBySlot.size !== placement.gridSlots.length) throw new CutSourceError("CUT_LAYOUT_MISMATCH", "One or more PDF template slots do not have a matching cut path.");
  return pathBySlot;
}

export interface CutLayoutRequest {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly settings: ProjectSettingsV2;
  readonly cardCount: number;
  /** Effective bleed values in the same flattened order used by the PDF engine. */
  readonly bleedByCardMm?: readonly number[];
  readonly sourceGeometry?: CutGeometryMm;
  readonly sourceOrientation?: PageOrientation;
}

export interface CutPageLayoutResolution extends CutLayoutResolution {
  readonly pageNumber: number;
  readonly startCardIndex: number;
  readonly endCardIndex: number;
}

/** Builds the exact per-page placements shared by cut exports and PDF. */
export function resolveCutLayoutPages(request: CutLayoutRequest): readonly CutPageLayoutResolution[] {
  const settings = request.settings;
  const pageSizeMm = orientedDimensions(settings.paperFormat, settings.pageOrientation);
  const cardSizeMm = orientedDimensions(settings.cardFormat, settings.cardOrientation);
  let sourceGeometry = request.sourceGeometry;
  if (sourceGeometry && request.sourceOrientation && request.sourceOrientation !== settings.pageOrientation) {
    sourceGeometry = rotateCutGeometryToOrientation(sourceGeometry, request.sourceOrientation, settings.pageOrientation);
  }
  let derivedTemplateGeometry: TemplateLayoutGeometryMm | undefined;
  if (sourceGeometry && !settings.layout.templateGeometry) {
    derivedTemplateGeometry = deriveTemplateLayoutFromCutGeometry(sourceGeometry, cardSizeMm, settings.pageOrientation, settings.cardOrientation);
  }
  const registration = generateRegistrationGeometry(settings.registration, pageSizeMm);
  const placements = calculateGridPagePlacements({
    placement: {
      paper: settings.paperFormat,
      pageOrientation: settings.pageOrientation,
      card: settings.cardFormat,
      cardOrientation: settings.cardOrientation,
      bleedMm: 0,
      marginsMm: settings.marginsMm,
      horizontalGapMm: settings.horizontalGapMm,
      verticalGapMm: settings.verticalGapMm,
      ...(settings.layout.templateGeometry ? { templateGeometry: settings.layout.templateGeometry } : derivedTemplateGeometry ? { templateGeometry: derivedTemplateGeometry } : {}),
      ...(settings.layout.rows !== undefined && settings.layout.columns !== undefined ? { rows: settings.layout.rows, columns: settings.layout.columns } : {}),
      skippedSlotIndices: settings.layout.skippedSlotIndices,
      reservedZonesMm: registration.reservedZones,
    },
    count: request.cardCount,
    bleedByCardMm: request.bleedByCardMm ?? Array.from({ length: request.cardCount }, () => settings.bleedMm),
  });
  const manualSource = { kind: "project-layout" as const, projectId: request.projectId, projectRevision: request.projectRevision };
  return Object.freeze(placements.map(({ pageIndex, startCardIndex, endCardIndex, placement }): CutPageLayoutResolution => {
    if (sourceGeometry) {
      const pathBySlot = matchSourcePaths(sourceGeometry, placement);
      const slotPaths = placement.gridSlots.map((slot): CutPathSlotState => ({
        slotIndex: slot.index,
        pathId: pathBySlot.get(slot.index)!.id,
        state: slot.skippedByUser ? "skipped" : slot.reserved ? "reserved" : slot.cardIndex === undefined ? "empty" : "active",
      }));
      const activePaths = placement.slots.map((slot) => pathBySlot.get(slot.index)!).filter(Boolean);
      const activeGeometry = activePaths.length > 0
        ? createCutGeometryMm({ source: sourceGeometry.source, pageSizeMm, paths: activePaths.map(({ id, start, closed, segments }) => ({ id, start, closed, segments })) })
        : null;
      return { pageNumber: pageIndex + 1, startCardIndex, endCardIndex, sourceGeometry, activeGeometry, placement, slotPaths: Object.freeze(slotPaths), ...(derivedTemplateGeometry ? { derivedTemplateGeometry } : {}) };
    }
    const generatedPaths = placement.gridSlots.map((slot) => createRectangularCutPathMm(`slot-${slot.index}`, slot.trim));
    const generated = createCutGeometryMm({ source: manualSource, pageSizeMm, paths: generatedPaths });
    const slotPaths = placement.gridSlots.map((slot): CutPathSlotState => ({
      slotIndex: slot.index,
      pathId: `slot-${slot.index}`,
      state: slot.skippedByUser ? "skipped" : slot.reserved ? "reserved" : slot.cardIndex === undefined ? "empty" : "active",
    }));
    const activeIds = new Set(placement.slots.map(({ index }) => `slot-${index}`));
    const activePaths = generated.paths.filter(({ id }) => activeIds.has(id));
    const activeGeometry = activePaths.length > 0
      ? createCutGeometryMm({ source: manualSource, pageSizeMm, paths: activePaths.map(({ id, start, closed, segments }) => ({ id, start, closed, segments })) })
      : null;
    return { pageNumber: pageIndex + 1, startCardIndex, endCardIndex, sourceGeometry: generated, activeGeometry, placement, slotPaths: Object.freeze(slotPaths) };
  }));
}

/** Backwards-compatible single-page projection of the explicit page list. */
export function resolveCutLayout(request: CutLayoutRequest): CutLayoutResolution {
  const pages = resolveCutLayoutPages(request);
  if (pages.length > 1) {
    throw new CutSourceError("CUT_LAYOUT_MISMATCH", `Project resolves to ${pages.length} physical pages; use resolveCutLayoutPages to preserve the PDF page mapping.`);
  }
  const firstPage = pages[0];
  if (!firstPage) throw new RangeError("Cut layout did not resolve any physical pages.");
  const { pageNumber: _pageNumber, startCardIndex: _startCardIndex, endCardIndex: _endCardIndex, ...layout } = firstPage;
  return layout;
}
