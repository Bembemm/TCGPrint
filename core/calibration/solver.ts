import { CalibrationError } from "./errors";
import { parseSideCalibration } from "./transform";
import type { CalibrationPageSizeMm, CalibrationPointMm, SideCalibration } from "./types";
import { CALIBRATION_POINT_IDS, getCalibrationTargetPoints, type CalibrationMeasurement, type CalibrationPointId } from "./measurements";

export interface SimpleCalibrationInput {
  readonly offsetXUm: number;
  readonly offsetYUm: number;
  readonly rotationDeg: number;
}

export interface CalibrationResidual {
  readonly pointId: CalibrationPointId;
  readonly deltaXmm: number;
  readonly deltaYmm: number;
  readonly magnitudeMm: number;
}

export interface CalibrationResidualSummary {
  readonly meanMagnitudeMm: number;
  readonly minimumMagnitudeMm: number;
  readonly maximumMagnitudeMm: number;
}

export interface CalibrationSolution {
  readonly calibration: SideCalibration;
  readonly residuals: readonly CalibrationResidual[];
  readonly summary: CalibrationResidualSummary | null;
  /** Infinity-norm condition estimate of the normalized QR fit. */
  readonly conditionEstimate?: number;
}

const MAX_CONDITION_ESTIMATE = 100_000;
const MIN_TARGET_SPAN_MM = 0.01;

function invalidMeasurements(code: "CALIBRATION_MEASUREMENTS_INSUFFICIENT" | "CALIBRATION_MEASUREMENTS_DUPLICATE" | "CALIBRATION_MEASUREMENTS_DEGENERATE" | "CALIBRATION_UNSTABLE", message: string): never {
  throw new CalibrationError(code, message);
}

/** Simple mode values are already the desired correction; this performs validation only. */
export function solveSimpleCalibration(input: SimpleCalibrationInput): CalibrationSolution {
  const calibration = parseSideCalibration({
    offsetXUm: input.offsetXUm,
    offsetYUm: input.offsetYUm,
    rotationDeg: input.rotationDeg,
    scaleX: 1,
    scaleY: 1,
  });
  return Object.freeze({ calibration, residuals: Object.freeze([]), summary: null });
}

function targetsFor(pageSize: CalibrationPageSizeMm): Record<CalibrationPointId, CalibrationPointMm> {
  if (!pageSize || !Number.isFinite(pageSize.widthMm) || !Number.isFinite(pageSize.heightMm)
    || pageSize.widthMm <= 0 || pageSize.heightMm <= 0
    || pageSize.widthMm > 2_000 || pageSize.heightMm > 2_000) {
    throw new CalibrationError("CALIBRATION_PAGE_SIZE_INVALID", "Solver page dimensions must be positive finite values no greater than 2000 mm.");
  }
  if (pageSize.widthMm < MIN_TARGET_SPAN_MM || pageSize.heightMm < MIN_TARGET_SPAN_MM) {
    invalidMeasurements("CALIBRATION_MEASUREMENTS_DEGENERATE", "Calibration targets are too close together to solve reliably.");
  }
  return getCalibrationTargetPoints(pageSize) as Record<CalibrationPointId, CalibrationPointMm>;
}

/** Modified Gram-Schmidt QR on a small normalized design matrix (n×3). */
function qrSolve(rows: readonly (readonly [number, number, number])[], values: readonly number[]): { coefficients: [number, number, number]; condition: number } {
  const columns = [0, 1, 2].map((column) => rows.map((row) => row[column]));
  const q: number[][] = [];
  const r = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let columnIndex = 0; columnIndex < 3; columnIndex += 1) {
    let column = [...columns[columnIndex]!];
    for (let previous = 0; previous < columnIndex; previous += 1) {
      const projection = dot(q[previous]!, column);
      r[previous]![columnIndex] = projection;
      column = column.map((value, index) => value - projection * q[previous]![index]!);
    }
    const norm = Math.sqrt(dot(column, column));
    if (!Number.isFinite(norm) || norm < 1e-12) {
      invalidMeasurements("CALIBRATION_MEASUREMENTS_DEGENERATE", "Calibration targets are collinear or nearly degenerate.");
    }
    r[columnIndex]![columnIndex] = norm;
    q.push(column.map((value) => value / norm));
  }

  const projected = q.map((basis) => dot(basis, values));
  const coefficients = solveUpperTriangular(r, projected);
  const condition = infinityNorm(r) * infinityNorm(invert3x3(r));
  if (!Number.isFinite(condition) || condition > MAX_CONDITION_ESTIMATE) {
    invalidMeasurements("CALIBRATION_UNSTABLE", `Calibration fit condition estimate ${condition} exceeds ${MAX_CONDITION_ESTIMATE}.`);
  }
  return { coefficients, condition };
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

function solveUpperTriangular(matrix: number[][], values: number[]): [number, number, number] {
  const result = [0, 0, 0];
  for (let row = 2; row >= 0; row -= 1) {
    let value = values[row]!;
    for (let column = row + 1; column < 3; column += 1) value -= matrix[row]![column]! * result[column]!;
    result[row] = value / matrix[row]![row]!;
  }
  return result as [number, number, number];
}

function invert3x3(matrix: number[][]): number[][] {
  const augmented = matrix.map((row, index) => [
    ...row,
    ...[0, 1, 2].map((column) => Number(index === column)),
  ]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![column]!) < 1e-12) {
      invalidMeasurements("CALIBRATION_MEASUREMENTS_DEGENERATE", "Calibration targets are collinear or nearly degenerate.");
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    augmented[column] = augmented[column]!.map((value) => value / divisor);
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      augmented[row] = augmented[row]!.map((value, index) => value - factor * augmented[column]![index]!);
    }
  }
  return augmented.map((row) => row.slice(3));
}

function infinityNorm(matrix: readonly (readonly number[])[]): number {
  return Math.max(...matrix.map((row) => row.reduce((sum, value) => sum + Math.abs(value), 0)));
}

function decomposeCorrection(a: number, b: number, c: number, d: number): { rotationDeg: number; scaleX: number; scaleY: number; skewXDeg: number } {
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant <= 1e-9) {
    throw new CalibrationError("CALIBRATION_SINGULAR", "Measured printer mapping cannot be inverted safely.");
  }
  const rotationRadians = Math.atan2(b, a);
  const cosine = Math.cos(rotationRadians);
  const sine = Math.sin(rotationRadians);
  const scaleX = Math.hypot(a, b);
  const skewNumerator = cosine * c + sine * d;
  const scaleY = -sine * c + cosine * d;
  if (scaleX <= 0 || scaleY <= 0 || !Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
    throw new CalibrationError("CALIBRATION_SINGULAR", "Measured printer mapping has a non-positive scale.");
  }
  const skewXDeg = Math.atan(skewNumerator / scaleY) * 180 / Math.PI;
  return { rotationDeg: rotationRadians * 180 / Math.PI, scaleX, scaleY, skewXDeg };
}

/** Fits observed = printerMap(nominal), then returns the inverse page correction. */
export function solveAdvancedCalibration(pageSizeMm: CalibrationPageSizeMm, input: readonly CalibrationMeasurement[]): CalibrationSolution {
  const targetPoints = targetsFor(pageSizeMm);
  if (!Array.isArray(input) || input.length < 4 || input.length > 5) {
    invalidMeasurements("CALIBRATION_MEASUREMENTS_INSUFFICIENT", "Advanced calibration requires four or five distinct target measurements.");
  }
  const seen = new Set<string>();
  const measurements: CalibrationMeasurement[] = (input as readonly CalibrationMeasurement[]).map((measurement: CalibrationMeasurement) => {
    if (!measurement || !CALIBRATION_POINT_IDS.includes(measurement.pointId)) {
      throw new CalibrationError("INVALID_CALIBRATION", "Measurement uses an unknown target point.");
    }
    if (seen.has(measurement.pointId)) invalidMeasurements("CALIBRATION_MEASUREMENTS_DUPLICATE", `Target ${measurement.pointId} was measured more than once.`);
    seen.add(measurement.pointId);
    if (!Number.isSafeInteger(measurement.deltaXUm) || !Number.isSafeInteger(measurement.deltaYUm)) {
      throw new CalibrationError("INVALID_CALIBRATION", "Measured X/Y errors must be finite integer micrometers.");
    }
    return measurement;
  });

  const centerX = pageSizeMm.widthMm / 2;
  const centerY = pageSizeMm.heightMm / 2;
  const halfWidth = centerX;
  const halfHeight = centerY;
  const rows = measurements.map(({ pointId }) => {
    const point = targetPoints[pointId];
    return [(point.xMm - centerX) / halfWidth, (point.yMm - centerY) / halfHeight, 1] as const;
  });
  const observedX = measurements.map(({ pointId, deltaXUm }) => {
    const point = targetPoints[pointId];
    return (point.xMm + deltaXUm / 1_000 - centerX) / halfWidth;
  });
  const observedY = measurements.map(({ pointId, deltaYUm }) => {
    const point = targetPoints[pointId];
    return (point.yMm + deltaYUm / 1_000 - centerY) / halfHeight;
  });
  const fitX = qrSolve(rows, observedX);
  const fitY = qrSolve(rows, observedY);
  const printerA = fitX.coefficients[0];
  const printerC = fitX.coefficients[1] * halfWidth / halfHeight;
  const printerTx = centerX + halfWidth * fitX.coefficients[2] - printerA * centerX - printerC * centerY;
  const printerB = fitY.coefficients[0] * halfHeight / halfWidth;
  const printerD = fitY.coefficients[1];
  const printerTy = centerY + halfHeight * fitY.coefficients[2] - printerB * centerX - printerD * centerY;
  const determinant = printerA * printerD - printerB * printerC;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) {
    throw new CalibrationError("CALIBRATION_SINGULAR", "Measured printer mapping is singular or numerically unstable.");
  }
  const correctionA = printerD / determinant;
  const correctionB = -printerB / determinant;
  const correctionC = -printerC / determinant;
  const correctionD = printerA / determinant;
  const correctionTx = -(correctionA * printerTx + correctionC * printerTy);
  const correctionTy = -(correctionB * printerTx + correctionD * printerTy);
  const decomposed = decomposeCorrection(correctionA, correctionB, correctionC, correctionD);
  const offsetXUm = Math.round((correctionA * centerX + correctionC * centerY + correctionTx - centerX) * 1_000);
  const offsetYUm = Math.round((correctionB * centerX + correctionD * centerY + correctionTy - centerY) * 1_000);
  const calibration = parseSideCalibration({
    offsetXUm,
    offsetYUm,
    rotationDeg: decomposed.rotationDeg,
    scaleX: decomposed.scaleX,
    scaleY: decomposed.scaleY,
    skewXDeg: decomposed.skewXDeg,
  });

  const residuals = measurements.map(({ pointId }) => {
    const target = targetPoints[pointId];
    const measured = measurements.find((measurement) => measurement.pointId === pointId)!;
    const observed = { xMm: target.xMm + measured.deltaXUm / 1_000, yMm: target.yMm + measured.deltaYUm / 1_000 };
    const correctedX = correctionA * observed.xMm + correctionC * observed.yMm + correctionTx;
    const correctedY = correctionB * observed.xMm + correctionD * observed.yMm + correctionTy;
    const deltaXmm = correctedX - target.xMm;
    const deltaYmm = correctedY - target.yMm;
    return Object.freeze({ pointId, deltaXmm, deltaYmm, magnitudeMm: Math.hypot(deltaXmm, deltaYmm) });
  });
  const magnitudes = residuals.map((residual) => residual.magnitudeMm);
  const summary = Object.freeze({
    meanMagnitudeMm: magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length,
    minimumMagnitudeMm: Math.min(...magnitudes),
    maximumMagnitudeMm: Math.max(...magnitudes),
  });
  return Object.freeze({
    calibration,
    residuals: Object.freeze(residuals),
    summary,
    conditionEstimate: Math.max(fitX.condition, fitY.condition),
  });
}
