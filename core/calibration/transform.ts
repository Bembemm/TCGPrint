import { CalibrationError } from "./errors";
import type {
  CalibrationAffineMatrixMm,
  CalibrationPageSizeMm,
  CalibrationPointMm,
  CalibrationPageRectMm,
  CalibrationPageOverflowMm,
  CalibrationSide,
  PrintCalibrationTransform,
  SideCalibration,
} from "./types";

export const CALIBRATION_OFFSET_MIN_UM = -10_000;
export const CALIBRATION_OFFSET_MAX_UM = 10_000;
export const CALIBRATION_ROTATION_MIN_DEG = -5;
export const CALIBRATION_ROTATION_MAX_DEG = 5;
export const CALIBRATION_SCALE_MIN = 0.98;
export const CALIBRATION_SCALE_MAX = 1.02;
export const CALIBRATION_SKEW_MIN_DEG = -1.5;
export const CALIBRATION_SKEW_MAX_DEG = 1.5;
export const CALIBRATION_PAGE_DIMENSION_MAX_MM = 2_000;

const SIDE_CALIBRATION_KEYS = new Set([
  "offsetXUm", "offsetYUm", "rotationDeg", "scaleX", "scaleY", "skewXDeg", "skewYDeg",
]);

function invalidCalibration(message: string): never {
  throw new CalibrationError("INVALID_CALIBRATION", message);
}

function outOfBounds(message: string): never {
  throw new CalibrationError("CALIBRATION_OUT_OF_BOUNDS", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedNumber(value: unknown, key: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidCalibration(`${key} must be a finite number.`);
  }
  if (value < minimum || value > maximum) {
    outOfBounds(`${key} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function micrometers(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    invalidCalibration(`${key} must be a safe integer count of micrometers.`);
  }
  if (value < CALIBRATION_OFFSET_MIN_UM || value > CALIBRATION_OFFSET_MAX_UM) {
    outOfBounds(`${key} must be between ${CALIBRATION_OFFSET_MIN_UM} and ${CALIBRATION_OFFSET_MAX_UM} µm.`);
  }
  return value;
}

export function createIdentitySideCalibration(): SideCalibration {
  return Object.freeze({ offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 });
}

/** Strictly validates stored or API supplied calibration parameters. */
export function parseSideCalibration(value: unknown): SideCalibration {
  if (!isPlainObject(value)) invalidCalibration("Side calibration must be a plain object.");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !SIDE_CALIBRATION_KEYS.has(key)) {
      invalidCalibration(`Side calibration contains unsupported property ${String(key)}.`);
    }
  }
  for (const key of ["offsetXUm", "offsetYUm", "rotationDeg", "scaleX", "scaleY"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalidCalibration(`Side calibration is missing ${key}.`);
  }

  const skewXDeg = value.skewXDeg === undefined
    ? undefined
    : boundedNumber(value.skewXDeg, "skewXDeg", CALIBRATION_SKEW_MIN_DEG, CALIBRATION_SKEW_MAX_DEG);
  const skewYDeg = value.skewYDeg === undefined
    ? undefined
    : boundedNumber(value.skewYDeg, "skewYDeg", CALIBRATION_SKEW_MIN_DEG, CALIBRATION_SKEW_MAX_DEG);

  return Object.freeze({
    offsetXUm: micrometers(value.offsetXUm, "offsetXUm"),
    offsetYUm: micrometers(value.offsetYUm, "offsetYUm"),
    rotationDeg: boundedNumber(value.rotationDeg, "rotationDeg", CALIBRATION_ROTATION_MIN_DEG, CALIBRATION_ROTATION_MAX_DEG),
    scaleX: boundedNumber(value.scaleX, "scaleX", CALIBRATION_SCALE_MIN, CALIBRATION_SCALE_MAX),
    scaleY: boundedNumber(value.scaleY, "scaleY", CALIBRATION_SCALE_MIN, CALIBRATION_SCALE_MAX),
    ...(skewXDeg !== undefined ? { skewXDeg } : {}),
    ...(skewYDeg !== undefined ? { skewYDeg } : {}),
  });
}

function validatePageSize(pageSizeMm: CalibrationPageSizeMm): void {
  if (!pageSizeMm || !Number.isFinite(pageSizeMm.widthMm) || !Number.isFinite(pageSizeMm.heightMm)
    || pageSizeMm.widthMm <= 0 || pageSizeMm.heightMm <= 0
    || pageSizeMm.widthMm > CALIBRATION_PAGE_DIMENSION_MAX_MM || pageSizeMm.heightMm > CALIBRATION_PAGE_DIMENSION_MAX_MM) {
    throw new CalibrationError("CALIBRATION_PAGE_SIZE_INVALID", "Calibration page dimensions must be positive finite values no greater than 2000 mm.");
  }
}

function identityMatrix(): CalibrationAffineMatrixMm {
  return Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
}

function toSvgMatrix(matrix: CalibrationAffineMatrixMm, pageHeightMm: number): CalibrationAffineMatrixMm {
  // F · M · F, where F maps top-left/Y-down page coordinates into physical Y-up coordinates.
  return Object.freeze({
    a: matrix.a,
    b: -matrix.b,
    c: -matrix.c,
    d: matrix.d,
    e: matrix.c * pageHeightMm + matrix.e,
    f: pageHeightMm * (1 - matrix.d) - matrix.f,
  });
}

/**
 * Builds scale → skew → rotation → translation about the center of the oriented page.
 * The matrix acts in the physical PDF frame, where positive Y is upward.
 */
export function createPrintCalibrationTransform(
  pageSizeMm: CalibrationPageSizeMm,
  input: SideCalibration,
  side: CalibrationSide,
): PrintCalibrationTransform {
  validatePageSize(pageSizeMm);
  if (side !== "front" && side !== "back") invalidCalibration("Calibration side must be front or back.");
  const calibration = parseSideCalibration(input);
  const anchor = Object.freeze({ xMm: pageSizeMm.widthMm / 2, yMm: pageSizeMm.heightMm / 2 });
  const isIdentity = calibration.offsetXUm === 0
    && calibration.offsetYUm === 0
    && calibration.rotationDeg === 0
    && calibration.scaleX === 1
    && calibration.scaleY === 1
    && (calibration.skewXDeg ?? 0) === 0
    && (calibration.skewYDeg ?? 0) === 0;
  if (isIdentity) {
    const matrix = identityMatrix();
    return Object.freeze({ side, anchor, matrix, svgMatrix: matrix, isIdentity: true });
  }

  const radians = Math.PI / 180;
  const rotation = calibration.rotationDeg * radians;
  const skewX = Math.tan((calibration.skewXDeg ?? 0) * radians);
  const skewY = Math.tan((calibration.skewYDeg ?? 0) * radians);
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);

  // H · S, then R · (H · S); column-vector right-to-left application.
  const hs00 = calibration.scaleX;
  const hs01 = skewX * calibration.scaleY;
  const hs10 = skewY * calibration.scaleX;
  const hs11 = calibration.scaleY;
  const a = cosine * hs00 - sine * hs10;
  const c = cosine * hs01 - sine * hs11;
  const b = sine * hs00 + cosine * hs10;
  const d = sine * hs01 + cosine * hs11;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant <= 1e-9) {
    throw new CalibrationError("CALIBRATION_SINGULAR", "Calibration matrix must be finite and nonsingular.");
  }

  const offsetXmm = calibration.offsetXUm / 1_000;
  const offsetYmm = calibration.offsetYUm / 1_000;
  const e = anchor.xMm - a * anchor.xMm - c * anchor.yMm + offsetXmm;
  const f = anchor.yMm - b * anchor.xMm - d * anchor.yMm + offsetYmm;
  const matrix = Object.freeze({ a, b, c, d, e, f });
  return Object.freeze({
    side,
    anchor,
    matrix,
    svgMatrix: toSvgMatrix(matrix, pageSizeMm.heightMm),
    isIdentity: false,
  });
}

export function applyCalibrationMatrix(point: CalibrationPointMm, matrix: CalibrationAffineMatrixMm): CalibrationPointMm {
  if (!Number.isFinite(point.xMm) || !Number.isFinite(point.yMm)) {
    throw new CalibrationError("INVALID_CALIBRATION", "Calibration point coordinates must be finite millimeters.");
  }
  return Object.freeze({
    xMm: matrix.a * point.xMm + matrix.c * point.yMm + matrix.e,
    yMm: matrix.b * point.xMm + matrix.d * point.yMm + matrix.f,
  });
}

/** Returns calibrated overflow for a nominal page-frame rectangle; no clipping or auto-scaling is applied. */
export function getCalibrationPageOverflowMm(
  pageSizeMm: CalibrationPageSizeMm,
  rect: CalibrationPageRectMm,
  matrix: CalibrationAffineMatrixMm,
): CalibrationPageOverflowMm {
  validatePageSize(pageSizeMm);
  if (!rect || ![rect.xMm, rect.yMm, rect.widthMm, rect.heightMm].every(Number.isFinite)
    || rect.widthMm <= 0 || rect.heightMm <= 0
    || !matrix || ![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)) {
    invalidCalibration("Page bounds and calibration matrix must contain finite dimensions and coefficients.");
  }
  const corners = [
    { xMm: rect.xMm, yMm: pageSizeMm.heightMm - rect.yMm },
    { xMm: rect.xMm + rect.widthMm, yMm: pageSizeMm.heightMm - rect.yMm },
    { xMm: rect.xMm, yMm: pageSizeMm.heightMm - rect.yMm - rect.heightMm },
    { xMm: rect.xMm + rect.widthMm, yMm: pageSizeMm.heightMm - rect.yMm - rect.heightMm },
  ].map((point) => applyCalibrationMatrix(point, matrix));
  const left = Math.min(...corners.map(({ xMm }) => xMm));
  const right = Math.max(...corners.map(({ xMm }) => xMm));
  const bottom = Math.min(...corners.map(({ yMm }) => yMm));
  const top = Math.max(...corners.map(({ yMm }) => yMm));
  const leftMm = Math.max(0, -left);
  const rightMm = Math.max(0, right - pageSizeMm.widthMm);
  const bottomMm = Math.max(0, -bottom);
  const topMm = Math.max(0, top - pageSizeMm.heightMm);
  return Object.freeze({
    leftMm,
    rightMm,
    bottomMm,
    topMm,
    maximumMm: Math.max(leftMm, rightMm, bottomMm, topMm),
    minimumClearanceMm: Math.min(left, pageSizeMm.widthMm - right, bottom, pageSizeMm.heightMm - top),
  });
}
