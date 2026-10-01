import { describe, expect, it } from "vitest";
import {
  CalibrationError,
  applyCalibrationMatrix,
  createIdentitySideCalibration,
  createPrintCalibrationTransform,
  getCalibrationPageOverflowMm,
  pageYDownToPhysicalYUp,
  parseSideCalibration,
  physicalYUpToPageYDown,
} from "../../core/calibration";

describe("print calibration transform", () => {
  it("keeps identity as an exact identity in both PDF and SVG coordinate frames", () => {
    const transform = createPrintCalibrationTransform(
      { widthMm: 210, heightMm: 297 },
      createIdentitySideCalibration(),
      "front",
    );

    expect(transform.isIdentity).toBe(true);
    expect(transform.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(transform.svgMatrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(transform.side).toBe("front");
  });

  it("converts visual positive Y up to the existing page positive Y down", () => {
    expect(pageYDownToPhysicalYUp(20, 150)).toBe(130);
    expect(physicalYUpToPageYDown(130, 150)).toBe(20);
  });

  it("translates a point by +1.250 mm right and +0.500 mm physically up", () => {
    const transform = createPrintCalibrationTransform(
      { widthMm: 100, heightMm: 150 },
      parseSideCalibration({
        offsetXUm: 1_250,
        offsetYUm: 500,
        rotationDeg: 0,
        scaleX: 1,
        scaleY: 1,
      }),
      "front",
    );

    const pdfPoint = applyCalibrationMatrix({ xMm: 10, yMm: 130 }, transform.matrix);
    const pagePoint = {
      xMm: pdfPoint.xMm,
      yMm: physicalYUpToPageYDown(pdfPoint.yMm, 150),
    };
    expect(pdfPoint).toEqual({ xMm: 11.25, yMm: 130.5 });
    expect(pagePoint).toEqual({ xMm: 11.25, yMm: 19.5 });
    expect(applyCalibrationMatrix({ xMm: 10, yMm: 20 }, transform.svgMatrix))
      .toEqual({ xMm: 11.25, yMm: 19.5 });
  });

  it("uses the actual oriented page center and transforms asymmetric corners", () => {
    const transform = createPrintCalibrationTransform(
      { widthMm: 100, heightMm: 150 },
      parseSideCalibration({
        offsetXUm: 0,
        offsetYUm: 0,
        rotationDeg: 1,
        scaleX: 1,
        scaleY: 1,
      }),
      "back",
    );

    expect(transform.anchor).toEqual({ xMm: 50, yMm: 75 });
    expect(applyCalibrationMatrix(transform.anchor, transform.matrix)).toEqual(transform.anchor);
    expect(applyCalibrationMatrix({ xMm: 0, yMm: 150 }, transform.matrix).xMm).toBeCloseTo(-1.301315, 5);
    expect(applyCalibrationMatrix({ xMm: 0, yMm: 150 }, transform.matrix).yMm).toBeCloseTo(149.115957, 5);
    expect(applyCalibrationMatrix({ xMm: 100, yMm: 0 }, transform.matrix).xMm).toBeCloseTo(101.301315, 5);
    expect(applyCalibrationMatrix({ xMm: 100, yMm: 0 }, transform.matrix).yMm).toBeCloseTo(0.884043, 5);
  });

  it("scales X and Y independently around the page center", () => {
    const transform = createPrintCalibrationTransform(
      { widthMm: 100, heightMm: 150 },
      parseSideCalibration({ offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1.01, scaleY: 0.99 }),
      "front",
    );

    expect(applyCalibrationMatrix({ xMm: 60, yMm: 100 }, transform.matrix))
      .toEqual({ xMm: 60.1, yMm: 99.75 });
  });

  it("applies each bounded shear component in the documented order", () => {
    const xShear = createPrintCalibrationTransform(
      { widthMm: 100, heightMm: 150 },
      parseSideCalibration({ offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1, skewXDeg: 1 }),
      "front",
    );
    const yShear = createPrintCalibrationTransform(
      { widthMm: 100, heightMm: 150 },
      parseSideCalibration({ offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1, skewYDeg: 1 }),
      "front",
    );

    expect(applyCalibrationMatrix({ xMm: 50, yMm: 120 }, xShear.matrix).xMm).toBeCloseTo(50.785478, 5);
    expect(applyCalibrationMatrix({ xMm: 60, yMm: 75 }, yShear.matrix).yMm).toBeCloseTo(75.174551, 5);
  });

  it("composes scale, both shears, rotation, center anchor, and signed offsets", () => {
    const transform = createPrintCalibrationTransform(
      { widthMm: 100, heightMm: 150 },
      parseSideCalibration({
        offsetXUm: -683,
        offsetYUm: 247,
        rotationDeg: 0.031,
        scaleX: 1.00012,
        scaleY: 0.99987,
        skewXDeg: 0.2,
        skewYDeg: -0.1,
      }),
      "back",
    );

    expect(applyCalibrationMatrix({ xMm: 13, yMm: 31 }, transform.matrix).xMm).toBeCloseTo(12.182764059, 8);
    expect(applyCalibrationMatrix({ xMm: 13, yMm: 31 }, transform.matrix).yMm).toBeCloseTo(31.297207010, 8);
  });

  it("anchors A4 at the center of its actual portrait or landscape page size", () => {
    const identity = createIdentitySideCalibration();

    expect(createPrintCalibrationTransform({ widthMm: 210, heightMm: 297 }, identity, "front").anchor)
      .toEqual({ xMm: 105, yMm: 148.5 });
    expect(createPrintCalibrationTransform({ widthMm: 297, heightMm: 210 }, identity, "back").anchor)
      .toEqual({ xMm: 148.5, yMm: 105 });
  });

  it("detects calibrated bounds without resizing or clipping the page", () => {
    const transform = createPrintCalibrationTransform(
      { widthMm: 100, heightMm: 150 },
      parseSideCalibration({ offsetXUm: 1_250, offsetYUm: 500, rotationDeg: 0, scaleX: 1, scaleY: 1 }),
      "front",
    );
    expect(getCalibrationPageOverflowMm({ widthMm: 100, heightMm: 150 }, {
      xMm: 90, yMm: 20, widthMm: 10, heightMm: 20,
    }, transform.matrix)).toEqual({ leftMm: 0, rightMm: 1.25, bottomMm: 0, topMm: 0, maximumMm: 1.25, minimumClearanceMm: -1.25 });
  });

  it("rejects values outside the documented printer correction bounds", () => {
    for (const invalid of [
      { offsetXUm: 10_001 },
      { offsetYUm: -10_001 },
      { rotationDeg: 5.001 },
      { scaleX: 0 },
      { scaleY: -1 },
      { scaleX: 1.021 },
      { skewXDeg: 1.501 },
      { skewYDeg: -1.501 },
      { offsetXUm: 0.1 },
      { rotationDeg: Number.NaN },
      { scaleX: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => parseSideCalibration({
        offsetXUm: 0,
        offsetYUm: 0,
        rotationDeg: 0,
        scaleX: 1,
        scaleY: 1,
        ...invalid,
      })).toThrow(CalibrationError);
    }
  });
});
