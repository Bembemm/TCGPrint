import { CalibrationError } from "./errors";

/** Converts page-model top-left/Y-down millimeters to PDF physical Y-up millimeters. */
export function pageYDownToPhysicalYUp(yMm: number, pageHeightMm: number): number {
  if (!Number.isFinite(yMm) || !Number.isFinite(pageHeightMm) || pageHeightMm <= 0) {
    throw new CalibrationError("CALIBRATION_PAGE_SIZE_INVALID", "Page Y conversion requires finite coordinates and a positive page height.");
  }
  return pageHeightMm - yMm;
}

/** Converts PDF physical Y-up millimeters to page-model top-left/Y-down millimeters. */
export function physicalYUpToPageYDown(yMm: number, pageHeightMm: number): number {
  if (!Number.isFinite(yMm) || !Number.isFinite(pageHeightMm) || pageHeightMm <= 0) {
    throw new CalibrationError("CALIBRATION_PAGE_SIZE_INVALID", "Page Y conversion requires finite coordinates and a positive page height.");
  }
  return pageHeightMm - yMm;
}
