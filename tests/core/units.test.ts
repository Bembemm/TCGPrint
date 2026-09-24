import { describe, expect, it } from "vitest";
import { mmToPixels, mmToPoints, pixelsToMm, pointsToMm } from "../../core/units";

describe("physical unit conversions", () => {
  it("converts millimeters to PDF points and back", () => {
    expect(mmToPoints(25.4)).toBeCloseTo(72, 12);
    expect(pointsToMm(72)).toBeCloseTo(25.4, 12);

    const millimeters = 1.234;
    const points = mmToPoints(millimeters);

    expect(points).toBeCloseTo((millimeters * 72) / 25.4, 12);
    expect(pointsToMm(points)).toBeCloseTo(millimeters, 12);
  });

  it("converts millimeters to pixels only when a DPI is supplied", () => {
    expect(mmToPixels(25.4, 300)).toBeCloseTo(300, 12);
    expect(pixelsToMm(300, 300)).toBeCloseTo(25.4, 12);
  });

  it("keeps fractional physical values without rounding", () => {
    const millimeters = 1.234;
    const pixels = mmToPixels(millimeters, 600);

    expect(pixels).toBeCloseTo((millimeters * 600) / 25.4, 12);
    expect(pixelsToMm(pixels, 600)).toBeCloseTo(millimeters, 12);
  });

  it("rejects non-finite values and non-positive DPI", () => {
    expect(() => mmToPoints(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => mmToPixels(10, 0)).toThrow(RangeError);
  });
});
