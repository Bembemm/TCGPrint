import { CalibrationError } from "./errors";
import type { CalibrationPageSizeMm, CalibrationPointMm } from "./types";

export const CALIBRATION_POINT_IDS = [
  "center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export type CalibrationPointId = (typeof CALIBRATION_POINT_IDS)[number];

/** Nominal fixture target centers in physical PDF coordinates (origin bottom-left, +Y up). */
export function getCalibrationTargetPoints(pageSize: CalibrationPageSizeMm): Readonly<Record<CalibrationPointId, CalibrationPointMm>> {
  if (!pageSize || !Number.isFinite(pageSize.widthMm) || !Number.isFinite(pageSize.heightMm)
    || pageSize.widthMm <= 0 || pageSize.heightMm <= 0 || pageSize.widthMm > 2_000 || pageSize.heightMm > 2_000) {
    throw new CalibrationError("CALIBRATION_PAGE_SIZE_INVALID", "Calibration target page dimensions must be positive finite values no greater than 2000 mm.");
  }
  const insetMm = Math.min(15, pageSize.widthMm / 10, pageSize.heightMm / 10);
  return Object.freeze({
    center: Object.freeze({ xMm: pageSize.widthMm / 2, yMm: pageSize.heightMm / 2 }),
    "top-left": Object.freeze({ xMm: insetMm, yMm: pageSize.heightMm - insetMm }),
    "top-right": Object.freeze({ xMm: pageSize.widthMm - insetMm, yMm: pageSize.heightMm - insetMm }),
    "bottom-left": Object.freeze({ xMm: insetMm, yMm: insetMm }),
    "bottom-right": Object.freeze({ xMm: pageSize.widthMm - insetMm, yMm: insetMm }),
  });
}

/** Signed observation error (observed minus nominal), in integer µm; +Y is physically up. */
export interface CalibrationMeasurement {
  readonly pointId: CalibrationPointId;
  readonly deltaXUm: number;
  readonly deltaYUm: number;
}

const MILLIMETER_INPUT = /^([+-]?)(?:(\d+)(?:[.,](\d{1,3}))?|[.,](\d{1,3}))$/;

/** Parses a user-entered mm value exactly at the 1 µm storage boundary. */
export function parseMillimeterInputToUm(text: string): number {
  if (typeof text !== "string") {
    throw new CalibrationError("INVALID_CALIBRATION", "Millimeter input must be text using a dot or comma decimal separator.");
  }
  const match = MILLIMETER_INPUT.exec(text);
  if (!match) {
    throw new CalibrationError("INVALID_CALIBRATION", "Enter millimeters with at most three decimal places and no grouping separators.");
  }

  const sign = match[1] === "-" ? -1 : 1;
  const whole = match[2] ?? "0";
  const fraction = (match[3] ?? match[4] ?? "").padEnd(3, "0");
  const absoluteUm = Number(whole) * 1_000 + Number(fraction || "0");
  const result = sign * absoluteUm;
  if (!Number.isSafeInteger(result) || Math.abs(result) > 10_000) {
    throw new CalibrationError("CALIBRATION_OUT_OF_BOUNDS", "Millimeter input must be between -10.000 and +10.000 mm.");
  }
  return result;
}
