const MILLIMETERS_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number.`);
  }
}

function assertPositiveDpi(dpi: number): void {
  assertFinite(dpi, "DPI");

  if (dpi <= 0) {
    throw new RangeError("DPI must be greater than zero.");
  }
}

/** Converts canonical millimeters to PDF points (72 points per inch). */
export function mmToPoints(millimeters: number): number {
  assertFinite(millimeters, "Millimeters");
  return (millimeters * POINTS_PER_INCH) / MILLIMETERS_PER_INCH;
}

/** Converts PDF points to canonical millimeters. */
export function pointsToMm(points: number): number {
  assertFinite(points, "Points");
  return (points * MILLIMETERS_PER_INCH) / POINTS_PER_INCH;
}

/** Converts canonical millimeters to pixels for an explicit output DPI. */
export function mmToPixels(millimeters: number, dpi: number): number {
  assertFinite(millimeters, "Millimeters");
  assertPositiveDpi(dpi);
  return (millimeters * dpi) / MILLIMETERS_PER_INCH;
}

/** Converts pixels to canonical millimeters for an explicit source DPI. */
export function pixelsToMm(pixels: number, dpi: number): number {
  assertFinite(pixels, "Pixels");
  assertPositiveDpi(dpi);
  return (pixels * MILLIMETERS_PER_INCH) / dpi;
}
