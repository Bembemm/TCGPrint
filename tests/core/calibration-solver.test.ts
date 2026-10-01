import { describe, expect, it } from "vitest";
import {
  CalibrationError,
  CALIBRATION_POINT_IDS,
  getCalibrationTargetPoints,
  parseMillimeterInputToUm,
  solveAdvancedCalibration,
  solveSimpleCalibration,
} from "../../core/calibration";

const page = { widthMm: 100, heightMm: 150 };

function measurementsForAffine(
  matrix: { a: number; b: number; c: number; d: number; txMm: number; tyMm: number },
) {
  const targets = getCalibrationTargetPoints(page);
  return CALIBRATION_POINT_IDS.map((pointId) => {
    const target = targets[pointId];
    const { xMm: x, yMm: y } = target;
    return {
    pointId,
    deltaXUm: Math.round((matrix.a * x + matrix.c * y + matrix.txMm - x) * 1_000),
    deltaYUm: Math.round((matrix.b * x + matrix.d * y + matrix.tyMm - y) * 1_000),
    };
  });
}

describe("calibration measurements and solver", () => {
  it("parses signed millimeters to integer micrometers without losing 0.001 mm", () => {
    expect(parseMillimeterInputToUm("-0.683")).toBe(-683);
    expect(parseMillimeterInputToUm("+0,247")).toBe(247);
    expect(parseMillimeterInputToUm(".001")).toBe(1);
    expect(parseMillimeterInputToUm("-10")).toBe(-10_000);
  });

  it.each(["", "1,000.2", "0.0001", "Infinity", "10.001", "--1", " 0.1 "])(
    "rejects ambiguous or out of range millimeter input %s",
    (value) => expect(() => parseMillimeterInputToUm(value)).toThrow(CalibrationError),
  );

  it("validates and packages direct Simple mode corrections", () => {
    expect(solveSimpleCalibration({ offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031 })).toMatchObject({
      calibration: { offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1, scaleY: 1 },
      residuals: [],
      summary: null,
    });
    expect(() => solveSimpleCalibration({ offsetXUm: 0.5, offsetYUm: 0, rotationDeg: 0 })).toThrow(CalibrationError);
  });

  it("solves translation, rotation, independent scales, and a small X shear", () => {
    // Independently specified observed map in physical Y-up coordinates.
    const observed = {
      a: 1.0002,
      b: 0.0001,
      c: 0.0003,
      d: 0.9998,
      txMm: 0.683,
      tyMm: -0.247,
    };
    const solved = solveAdvancedCalibration(page, measurementsForAffine(observed));

    expect(solved.calibration.offsetXUm).toBe(-715);
    expect(solved.calibration.offsetYUm).toBe(257);
    expect(solved.calibration.rotationDeg).toBeCloseTo(-0.005729, 5);
    expect(solved.calibration.scaleX).toBeCloseTo(0.999800, 6);
    expect(solved.calibration.scaleY).toBeCloseTo(1.000200, 6);
    expect(solved.calibration.skewXDeg).toBeCloseTo(-0.022918, 5);
    expect(solved.calibration.skewYDeg ?? 0).toBe(0);
    expect(solved.residuals).toHaveLength(5);
    expect(solved.summary?.maximumMagnitudeMm).toBeLessThan(0.001);
  });

  it("returns residual vectors and magnitude summary for rounded measured deltas", () => {
    const measurements = measurementsForAffine({ a: 1, b: 0, c: 0, d: 1, txMm: 0.123, tyMm: -0.456 });
    const solved = solveAdvancedCalibration(page, measurements);

    expect(solved.residuals).toHaveLength(5);
    expect(solved.summary?.meanMagnitudeMm).toBeLessThan(0.001);
    expect(solved.summary?.minimumMagnitudeMm).toBeLessThanOrEqual(solved.summary?.maximumMagnitudeMm ?? 0);
    expect(solved.residuals[0]).toMatchObject({ pointId: "center" });
  });

  it("rejects too few or duplicate measurements and invalid point deltas", () => {
    const measurements = measurementsForAffine({ a: 1, b: 0, c: 0, d: 1, txMm: 0.1, tyMm: 0.2 });
    expect(() => solveAdvancedCalibration(page, measurements.slice(0, 3))).toThrow(CalibrationError);
    expect(() => solveAdvancedCalibration(page, [...measurements.slice(0, 4), measurements[0]!])).toThrow(CalibrationError);
    expect(() => solveAdvancedCalibration(page, measurements.map((item, index) => index === 0
      ? { ...item, deltaXUm: Number.NaN }
      : item))).toThrow(CalibrationError);
    expect(() => solveAdvancedCalibration({ widthMm: 0.000001, heightMm: 150 }, measurements)).toThrow(CalibrationError);
  });

  it("rejects numerically unstable or out-of-bounds solutions", () => {
    const measurements = measurementsForAffine({ a: 1, b: 0, c: 0, d: 1, txMm: 20, tyMm: 0 });
    expect(() => solveAdvancedCalibration(page, measurements)).toThrow(CalibrationError);
    expect(() => solveAdvancedCalibration({ widthMm: 0.001, heightMm: 0.001 }, measurements)).toThrow(CalibrationError);
  });
});
