export const CUT_GUIDE_MODES = ["none", "corners", "sides", "cross", "full", "guillotine"] as const;
export type CutGuideMode = (typeof CUT_GUIDE_MODES)[number];

export const CUT_GUIDE_LINE_STYLES = ["solid", "dashed", "dotted"] as const;
export type CutGuideLineStyle = (typeof CUT_GUIDE_LINE_STYLES)[number];

export interface CutGuideStyle {
  /** Six-digit sRGB hex color, for example #202020. */
  readonly color: string;
  readonly strokeWidthMm: number;
  readonly opacity: number;
  readonly lineStyle: CutGuideLineStyle;
}

export interface TrimRectangleMm {
  /** Page coordinate from the upper-left corner, in millimeters. */
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
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

interface CutGuideConfigBase {
  readonly style: CutGuideStyle;
}

export type CutGuideConfig =
  | (CutGuideConfigBase & { readonly mode: "none" })
  | (CutGuideConfigBase & {
    readonly mode: "corners";
    readonly externalLengthMm: number;
    readonly internalLengthMm: number;
    readonly offsetMm: number;
  })
  | (CutGuideConfigBase & {
    readonly mode: "sides";
    readonly externalLengthMm: number;
    readonly internalLengthMm: number;
    readonly offsetMm: number;
  })
  | (CutGuideConfigBase & { readonly mode: "cross"; readonly armLengthMm: number })
  | (CutGuideConfigBase & { readonly mode: "full" })
  | (CutGuideConfigBase & { readonly mode: "guillotine" });

export interface CutGuideRequest {
  readonly trims: readonly TrimRectangleMm[];
  readonly pageSizeMm: CutGuidePageSizeMm;
  readonly config: CutGuideConfig;
}

export interface CutGuideGeometry {
  readonly mode: CutGuideMode;
  readonly style: CutGuideStyle;
  readonly segments: readonly CutGuideSegmentMm[];
}

const GEOMETRY_TOLERANCE_MM = 1e-9;

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number.`);
}

function assertNonNegative(value: number, name: string): void {
  assertFinite(value, name);
  if (value < 0) throw new RangeError(`${name} must be greater than or equal to zero.`);
}

function assertPositive(value: number, name: string): void {
  assertFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be greater than zero.`);
}

function validateStyle(style: CutGuideStyle): CutGuideStyle {
  if (!style || typeof style !== "object") throw new TypeError("Cut guide style is required.");
  if (!/^#[\da-f]{6}$/i.test(style.color)) {
    throw new RangeError("Cut guide color must use the #RRGGBB format.");
  }
  assertPositive(style.strokeWidthMm, "Cut guide stroke width");
  assertFinite(style.opacity, "Cut guide opacity");
  if (style.opacity < 0 || style.opacity > 1) {
    throw new RangeError("Cut guide opacity must be between 0 and 1.");
  }
  if (!(CUT_GUIDE_LINE_STYLES as readonly string[]).includes(style.lineStyle)) {
    throw new RangeError(`Unsupported cut guide line style: ${String(style.lineStyle)}.`);
  }

  return Object.freeze({ ...style, color: style.color.toUpperCase() });
}

function validateRequest(request: CutGuideRequest): {
  readonly style: CutGuideStyle;
  readonly trims: readonly TrimRectangleMm[];
} {
  if (!request || typeof request !== "object") throw new TypeError("Cut guide request is required.");
  const { pageSizeMm } = request;
  assertPositive(pageSizeMm.widthMm, "Page width");
  assertPositive(pageSizeMm.heightMm, "Page height");
  if (!Array.isArray(request.trims)) throw new TypeError("Cut guide trims must be an array.");
  if (!request.config || !(CUT_GUIDE_MODES as readonly string[]).includes(request.config.mode)) {
    throw new RangeError(`Unsupported cut guide mode: ${String(request.config?.mode)}.`);
  }

  const style = validateStyle(request.config.style);
  const trims = request.trims.map((trim, index) => {
    assertFinite(trim.xMm, `Trim ${index + 1} X`);
    assertFinite(trim.yMm, `Trim ${index + 1} Y`);
    assertPositive(trim.widthMm, `Trim ${index + 1} width`);
    assertPositive(trim.heightMm, `Trim ${index + 1} height`);
    if (
      trim.xMm < -GEOMETRY_TOLERANCE_MM
      || trim.yMm < -GEOMETRY_TOLERANCE_MM
      || trim.xMm + trim.widthMm > pageSizeMm.widthMm + GEOMETRY_TOLERANCE_MM
      || trim.yMm + trim.heightMm > pageSizeMm.heightMm + GEOMETRY_TOLERANCE_MM
    ) {
      throw new RangeError(`Trim ${index + 1} is outside page bounds.`);
    }
    return Object.freeze({ ...trim });
  });

  for (let first = 0; first < trims.length; first += 1) {
    for (let second = first + 1; second < trims.length; second += 1) {
      const a = trims[first];
      const b = trims[second];
      const overlapWidth = Math.min(a.xMm + a.widthMm, b.xMm + b.widthMm) - Math.max(a.xMm, b.xMm);
      const overlapHeight = Math.min(a.yMm + a.heightMm, b.yMm + b.heightMm) - Math.max(a.yMm, b.yMm);
      if (overlapWidth > GEOMETRY_TOLERANCE_MM && overlapHeight > GEOMETRY_TOLERANCE_MM) {
        throw new RangeError(`Trim rectangles ${first + 1} and ${second + 1} overlap.`);
      }
    }
  }

  switch (request.config.mode) {
    case "corners":
    case "sides":
      assertNonNegative(request.config.externalLengthMm, "External guide length");
      assertNonNegative(request.config.internalLengthMm, "Internal guide length");
      assertNonNegative(request.config.offsetMm, "Guide offset");
      if (request.config.externalLengthMm === 0 && request.config.internalLengthMm === 0) {
        throw new RangeError("Cut guide lengths cannot both be zero.");
      }
      break;
    case "cross":
      assertPositive(request.config.armLengthMm, "Cross arm length");
      break;
    case "none":
    case "full":
    case "guillotine":
      break;
  }

  return { style, trims };
}

function addSegment(
  segments: CutGuideSegmentMm[],
  x1Mm: number,
  y1Mm: number,
  x2Mm: number,
  y2Mm: number,
): void {
  if (Math.hypot(x2Mm - x1Mm, y2Mm - y1Mm) <= GEOMETRY_TOLERANCE_MM) {
    throw new RangeError("Cut guide configuration generated a zero-length segment.");
  }
  segments.push({ x1Mm, y1Mm, x2Mm, y2Mm });
}

function generateCornerSegments(
  trim: TrimRectangleMm,
  config: Extract<CutGuideConfig, { mode: "corners" }>,
  segments: CutGuideSegmentMm[],
): void {
  const left = trim.xMm;
  const right = left + trim.widthMm;
  const top = trim.yMm;
  const bottom = top + trim.heightMm;
  const { externalLengthMm: outside, internalLengthMm: alongside, offsetMm: gap } = config;

  addSegment(segments, left - outside, top - gap, left + alongside, top - gap);
  addSegment(segments, left - gap, top - outside, left - gap, top + alongside);
  addSegment(segments, right - alongside, top - gap, right + outside, top - gap);
  addSegment(segments, right + gap, top - outside, right + gap, top + alongside);
  addSegment(segments, left - outside, bottom + gap, left + alongside, bottom + gap);
  addSegment(segments, left - gap, bottom - alongside, left - gap, bottom + outside);
  addSegment(segments, right - alongside, bottom + gap, right + outside, bottom + gap);
  addSegment(segments, right + gap, bottom - alongside, right + gap, bottom + outside);
}

function generateSideSegments(
  trim: TrimRectangleMm,
  config: Extract<CutGuideConfig, { mode: "sides" }>,
  segments: CutGuideSegmentMm[],
): void {
  const { externalLengthMm: outside, internalLengthMm: inside, offsetMm: gap } = config;
  const centerX = trim.xMm + trim.widthMm / 2;
  const centerY = trim.yMm + trim.heightMm / 2;
  const right = trim.xMm + trim.widthMm;
  const bottom = trim.yMm + trim.heightMm;

  if (outside > 0) {
    addSegment(segments, centerX, trim.yMm - gap - outside, centerX, trim.yMm - gap);
    addSegment(segments, centerX, bottom + gap, centerX, bottom + gap + outside);
    addSegment(segments, trim.xMm - gap - outside, centerY, trim.xMm - gap, centerY);
    addSegment(segments, right + gap, centerY, right + gap + outside, centerY);
  }
  if (inside > 0) {
    addSegment(segments, centerX, trim.yMm, centerX, trim.yMm + inside);
    addSegment(segments, centerX, bottom - inside, centerX, bottom);
    addSegment(segments, trim.xMm, centerY, trim.xMm + inside, centerY);
    addSegment(segments, right - inside, centerY, right, centerY);
  }
}

function generateCrossSegments(
  trim: TrimRectangleMm,
  armLengthMm: number,
  segments: CutGuideSegmentMm[],
): void {
  const left = trim.xMm;
  const right = left + trim.widthMm;
  const top = trim.yMm;
  const bottom = top + trim.heightMm;

  for (const [xMm, yMm] of [[left, top], [right, top], [left, bottom], [right, bottom]]) {
    addSegment(segments, xMm - armLengthMm, yMm, xMm + armLengthMm, yMm);
    addSegment(segments, xMm, yMm - armLengthMm, xMm, yMm + armLengthMm);
  }
}

function generateFullSegments(trim: TrimRectangleMm, segments: CutGuideSegmentMm[]): void {
  const right = trim.xMm + trim.widthMm;
  const bottom = trim.yMm + trim.heightMm;
  addSegment(segments, trim.xMm, trim.yMm, right, trim.yMm);
  addSegment(segments, trim.xMm, bottom, right, bottom);
  addSegment(segments, trim.xMm, trim.yMm, trim.xMm, bottom);
  addSegment(segments, right, trim.yMm, right, bottom);
}

function collectUniqueCoordinates(values: readonly number[]): number[] {
  const unique: number[] = [];
  for (const value of values) {
    if (!unique.some((candidate) => Math.abs(candidate - value) <= GEOMETRY_TOLERANCE_MM)) {
      unique.push(value);
    }
  }
  return unique.sort((a, b) => a - b);
}

function deduplicateSegments(segments: readonly CutGuideSegmentMm[]): CutGuideSegmentMm[] {
  const keys = new Set<string>();
  return segments.filter((segment) => {
    const first = `${segment.x1Mm.toFixed(9)},${segment.y1Mm.toFixed(9)}`;
    const second = `${segment.x2Mm.toFixed(9)},${segment.y2Mm.toFixed(9)}`;
    const key = first < second ? `${first}|${second}` : `${second}|${first}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

export class CutGuideEngine {
  generate(request: CutGuideRequest): CutGuideGeometry {
    const { style, trims } = validateRequest(request);
    const segments: CutGuideSegmentMm[] = [];

    switch (request.config.mode) {
      case "none":
        break;
      case "corners":
        for (const trim of trims) generateCornerSegments(trim, request.config, segments);
        break;
      case "sides":
        for (const trim of trims) generateSideSegments(trim, request.config, segments);
        break;
      case "cross":
        for (const trim of trims) generateCrossSegments(trim, request.config.armLengthMm, segments);
        break;
      case "full":
        for (const trim of trims) generateFullSegments(trim, segments);
        break;
      case "guillotine": {
        const xCoordinates = collectUniqueCoordinates(trims.flatMap(({ xMm, widthMm }) => [xMm, xMm + widthMm]));
        const yCoordinates = collectUniqueCoordinates(trims.flatMap(({ yMm, heightMm }) => [yMm, yMm + heightMm]));
        for (const xMm of xCoordinates) {
          addSegment(segments, xMm, 0, xMm, request.pageSizeMm.heightMm);
        }
        for (const yMm of yCoordinates) {
          addSegment(segments, 0, yMm, request.pageSizeMm.widthMm, yMm);
        }
        break;
      }
      default:
        throw new RangeError(`Unsupported cut guide mode: ${String((request.config as { mode?: unknown }).mode)}.`);
    }

    const uniqueSegments = deduplicateSegments(segments);
    for (const segment of uniqueSegments) {
      if (
        Math.min(segment.x1Mm, segment.x2Mm) < -GEOMETRY_TOLERANCE_MM
        || Math.min(segment.y1Mm, segment.y2Mm) < -GEOMETRY_TOLERANCE_MM
        || Math.max(segment.x1Mm, segment.x2Mm) > request.pageSizeMm.widthMm + GEOMETRY_TOLERANCE_MM
        || Math.max(segment.y1Mm, segment.y2Mm) > request.pageSizeMm.heightMm + GEOMETRY_TOLERANCE_MM
      ) {
        throw new RangeError("Cut guide geometry extends outside page bounds.");
      }
    }

    return Object.freeze({
      mode: request.config.mode,
      style,
      segments: Object.freeze(uniqueSegments.map((segment) => Object.freeze(segment))),
    });
  }
}
