export interface TrimGuideConfig {
  readonly enabled: boolean;
  readonly extentMm: number | "full";
}

export interface ExternalCutGuideConfig {
  readonly enabled: boolean;
  readonly strokeWidthPt: number;
}

export interface CutGuideConfig {
  readonly trim: TrimGuideConfig;
  readonly external: ExternalCutGuideConfig;
}

export const DEFAULT_CUT_GUIDE_CONFIG: CutGuideConfig = Object.freeze({
  trim: Object.freeze({ enabled: false, extentMm: 1 }),
  external: Object.freeze({ enabled: false, strokeWidthPt: 0.3 }),
});

export const TRIM_GUIDE_COLOR = "#00A6D6";
export const TRIM_GUIDE_STROKE_WIDTH_PT = 0.2;
export const EXTERNAL_CUT_GUIDE_COLOR = "#E87500";

export interface TrimRectangleMm {
  /** Page coordinate from the upper-left corner, in millimeters. */
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface CutGuideCardMm {
  readonly trim: TrimRectangleMm;
  readonly bleedMm: number;
}

export interface CutGuideSegmentMm {
  readonly x1Mm: number;
  readonly y1Mm: number;
  readonly x2Mm: number;
  readonly y2Mm: number;
}

export interface CutGuidePageSizeMm {
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface CutGuideRequest {
  readonly cards: readonly CutGuideCardMm[];
  readonly pageSizeMm: CutGuidePageSizeMm;
  readonly config: CutGuideConfig;
}

export interface CutGuideGeometry {
  readonly trimSegments: readonly CutGuideSegmentMm[];
  readonly externalSegments: readonly CutGuideSegmentMm[];
}

const GEOMETRY_TOLERANCE_MM = 1e-9;
const POINTS_PER_MM = 72 / 25.4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number.`);
}

function assertPositive(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero.`);
}

function assertNonNegative(value: number, label: string): void {
  assertFinite(value, label);
  if (value < 0) throw new RangeError(`${label} must be greater than or equal to zero.`);
}

/** Validates public config payloads and supplies the safe both-disabled default. */
export function parseCutGuideConfig(value: unknown): CutGuideConfig {
  if (value === undefined) return DEFAULT_CUT_GUIDE_CONFIG;
  if (typeof value === "string") {
    throw new TypeError("Legacy cut guide modes are not supported; send trim and external guide settings.");
  }
  if (!isRecord(value) || !isRecord(value.trim) || !isRecord(value.external)) {
    throw new TypeError("Cut guides must contain trim and external configuration objects.");
  }

  const { trim, external } = value;
  if (typeof trim.enabled !== "boolean") throw new TypeError("Trim guide enabled must be a boolean.");
  if (trim.extentMm !== "full" && typeof trim.extentMm !== "number") {
    throw new TypeError("Trim guide extent must be a positive number in millimeters or 'full'.");
  }
  if (trim.extentMm !== "full") assertPositive(trim.extentMm, "Trim guide extent");
  if (typeof external.enabled !== "boolean") throw new TypeError("External guide enabled must be a boolean.");
  if (typeof external.strokeWidthPt !== "number") throw new TypeError("External guide stroke width must be a number in points.");
  assertPositive(external.strokeWidthPt, "External guide stroke width");

  return Object.freeze({
    trim: Object.freeze({ enabled: trim.enabled, extentMm: trim.extentMm as number | "full" }),
    external: Object.freeze({ enabled: external.enabled, strokeWidthPt: external.strokeWidthPt }),
  });
}

function validateRequest(request: CutGuideRequest): { readonly config: CutGuideConfig; readonly cards: readonly CutGuideCardMm[] } {
  if (!request || typeof request !== "object") throw new TypeError("Cut guide request is required.");
  assertPositive(request.pageSizeMm.widthMm, "Page width");
  assertPositive(request.pageSizeMm.heightMm, "Page height");
  if (!Array.isArray(request.cards)) throw new TypeError("Cut guide cards must be an array.");
  const config = parseCutGuideConfig(request.config);
  const cards = request.cards.map(({ trim, bleedMm }, index) => {
    if (!trim || typeof trim !== "object") throw new TypeError(`Card ${index + 1} trim rectangle is required.`);
    assertFinite(trim.xMm, `Card ${index + 1} trim X`);
    assertFinite(trim.yMm, `Card ${index + 1} trim Y`);
    assertPositive(trim.widthMm, `Card ${index + 1} trim width`);
    assertPositive(trim.heightMm, `Card ${index + 1} trim height`);
    assertNonNegative(bleedMm, `Card ${index + 1} bleed`);
    if (
      trim.xMm < -GEOMETRY_TOLERANCE_MM
      || trim.yMm < -GEOMETRY_TOLERANCE_MM
      || trim.xMm + trim.widthMm > request.pageSizeMm.widthMm + GEOMETRY_TOLERANCE_MM
      || trim.yMm + trim.heightMm > request.pageSizeMm.heightMm + GEOMETRY_TOLERANCE_MM
    ) {
      throw new RangeError(`Card ${index + 1} trim is outside page bounds.`);
    }
    return Object.freeze({ trim: Object.freeze({ ...trim }), bleedMm });
  });

  for (let first = 0; first < cards.length; first += 1) {
    for (let second = first + 1; second < cards.length; second += 1) {
      const a = cards[first].trim;
      const b = cards[second].trim;
      const overlapWidth = Math.min(a.xMm + a.widthMm, b.xMm + b.widthMm) - Math.max(a.xMm, b.xMm);
      const overlapHeight = Math.min(a.yMm + a.heightMm, b.yMm + b.heightMm) - Math.max(a.yMm, b.yMm);
      if (overlapWidth > GEOMETRY_TOLERANCE_MM && overlapHeight > GEOMETRY_TOLERANCE_MM) {
        throw new RangeError(`Trim rectangles ${first + 1} and ${second + 1} overlap.`);
      }
    }
  }
  return { config, cards };
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

interface AxisIntervals {
  readonly coordinate: number;
  readonly intervals: Interval[];
}

function addAxisInterval(groups: AxisIntervals[], coordinate: number, start: number, end: number): void {
  if (end - start <= GEOMETRY_TOLERANCE_MM) return;
  const group = groups.find((candidate) => Math.abs(candidate.coordinate - coordinate) <= GEOMETRY_TOLERANCE_MM);
  if (group) group.intervals.push({ start, end });
  else groups.push({ coordinate, intervals: [{ start, end }] });
}

function unionIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + GEOMETRY_TOLERANCE_MM) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, interval.end) };
    } else merged.push({ ...interval });
  }
  return merged;
}

function makeHorizontalSegments(groups: readonly AxisIntervals[]): CutGuideSegmentMm[] {
  return groups.flatMap(({ coordinate, intervals }) => unionIntervals(intervals).map(({ start, end }) => ({
    x1Mm: start,
    y1Mm: coordinate,
    x2Mm: end,
    y2Mm: coordinate,
  })));
}

function makeVerticalSegments(groups: readonly AxisIntervals[]): CutGuideSegmentMm[] {
  return groups.flatMap(({ coordinate, intervals }) => unionIntervals(intervals).map(({ start, end }) => ({
    x1Mm: coordinate,
    y1Mm: start,
    x2Mm: coordinate,
    y2Mm: end,
  })));
}

function generateTrimSegments(cards: readonly CutGuideCardMm[], extent: number | "full"): CutGuideSegmentMm[] {
  const horizontal: AxisIntervals[] = [];
  const vertical: AxisIntervals[] = [];
  for (const { trim } of cards) {
    const left = trim.xMm;
    const right = left + trim.widthMm;
    const top = trim.yMm;
    const bottom = top + trim.heightMm;
    const horizontalLength = extent === "full" ? trim.widthMm : Math.min(extent, trim.widthMm);
    const verticalLength = extent === "full" ? trim.heightMm : Math.min(extent, trim.heightMm);

    if (extent === "full") {
      addAxisInterval(horizontal, top, left, right);
      addAxisInterval(horizontal, bottom, left, right);
      addAxisInterval(vertical, left, top, bottom);
      addAxisInterval(vertical, right, top, bottom);
    } else {
      addAxisInterval(horizontal, top, left, left + horizontalLength);
      addAxisInterval(horizontal, top, right - horizontalLength, right);
      addAxisInterval(horizontal, bottom, left, left + horizontalLength);
      addAxisInterval(horizontal, bottom, right - horizontalLength, right);
      addAxisInterval(vertical, left, top, top + verticalLength);
      addAxisInterval(vertical, left, bottom - verticalLength, bottom);
      addAxisInterval(vertical, right, top, top + verticalLength);
      addAxisInterval(vertical, right, bottom - verticalLength, bottom);
    }
  }
  return [...makeHorizontalSegments(horizontal), ...makeVerticalSegments(vertical)];
}

function subtractIntervals(source: Interval, obstructions: readonly Interval[]): Interval[] {
  let remaining = [source];
  for (const obstruction of unionIntervals(obstructions)) {
    remaining = remaining.flatMap((interval) => {
      if (obstruction.end <= interval.start + GEOMETRY_TOLERANCE_MM || obstruction.start >= interval.end - GEOMETRY_TOLERANCE_MM) {
        return [interval];
      }
      const next: Interval[] = [];
      if (obstruction.start > interval.start + GEOMETRY_TOLERANCE_MM) {
        next.push({ start: interval.start, end: Math.min(obstruction.start, interval.end) });
      }
      if (obstruction.end < interval.end - GEOMETRY_TOLERANCE_MM) {
        next.push({ start: Math.max(obstruction.end, interval.start), end: interval.end });
      }
      return next;
    });
  }
  return remaining.filter(({ start, end }) => end - start > GEOMETRY_TOLERANCE_MM);
}

function externalIntervals(
  cards: readonly CutGuideCardMm[],
  coordinate: number,
  strokeRadiusMm: number,
  pageLengthMm: number,
  horizontal: boolean,
): Interval[] {
  const pageInterval = { start: strokeRadiusMm, end: pageLengthMm - strokeRadiusMm };
  if (pageInterval.end - pageInterval.start <= GEOMETRY_TOLERANCE_MM) return [];
  const obstructions: Interval[] = [];
  for (const { trim, bleedMm } of cards) {
    const left = trim.xMm - bleedMm;
    const right = trim.xMm + trim.widthMm + bleedMm;
    const top = trim.yMm - bleedMm;
    const bottom = trim.yMm + trim.heightMm + bleedMm;
    const lineBandStart = coordinate - strokeRadiusMm;
    const lineBandEnd = coordinate + strokeRadiusMm;
    const overlapsOnFixedAxis = horizontal
      ? lineBandEnd > top + GEOMETRY_TOLERANCE_MM && lineBandStart < bottom - GEOMETRY_TOLERANCE_MM
      : lineBandEnd > left + GEOMETRY_TOLERANCE_MM && lineBandStart < right - GEOMETRY_TOLERANCE_MM;
    if (!overlapsOnFixedAxis) continue;
    obstructions.push(horizontal
      ? { start: left - strokeRadiusMm, end: right + strokeRadiusMm }
      : { start: top - strokeRadiusMm, end: bottom + strokeRadiusMm });
  }
  return subtractIntervals(pageInterval, obstructions);
}

function generateExternalSegments(
  cards: readonly CutGuideCardMm[],
  pageSizeMm: CutGuidePageSizeMm,
  strokeWidthPt: number,
): CutGuideSegmentMm[] {
  const strokeRadiusMm = strokeWidthPt / POINTS_PER_MM / 2;
  const uniqueCoordinates = (values: readonly number[]) => [...values].sort((a, b) => a - b).filter((value, index, sorted) =>
    index === 0 || Math.abs(value - sorted[index - 1]) > GEOMETRY_TOLERANCE_MM,
  );
  const horizontalCoordinates = uniqueCoordinates(cards.flatMap(({ trim }) => [trim.yMm, trim.yMm + trim.heightMm]));
  const verticalCoordinates = uniqueCoordinates(cards.flatMap(({ trim }) => [trim.xMm, trim.xMm + trim.widthMm]));
  const segments: CutGuideSegmentMm[] = [];

  for (const yMm of horizontalCoordinates) {
    for (const { start, end } of externalIntervals(cards, yMm, strokeRadiusMm, pageSizeMm.widthMm, true)) {
      segments.push({ x1Mm: start, y1Mm: yMm, x2Mm: end, y2Mm: yMm });
    }
  }
  for (const xMm of verticalCoordinates) {
    for (const { start, end } of externalIntervals(cards, xMm, strokeRadiusMm, pageSizeMm.heightMm, false)) {
      segments.push({ x1Mm: xMm, y1Mm: start, x2Mm: xMm, y2Mm: end });
    }
  }
  return segments;
}

export class CutGuideEngine {
  generate(request: CutGuideRequest): CutGuideGeometry {
    const { config, cards } = validateRequest(request);
    const trimSegments = config.trim.enabled ? generateTrimSegments(cards, config.trim.extentMm) : [];
    const externalSegments = config.external.enabled
      ? generateExternalSegments(cards, request.pageSizeMm, config.external.strokeWidthPt)
      : [];
    return Object.freeze({
      trimSegments: Object.freeze(trimSegments.map((segment) => Object.freeze(segment))),
      externalSegments: Object.freeze(externalSegments.map((segment) => Object.freeze(segment))),
    });
  }
}
