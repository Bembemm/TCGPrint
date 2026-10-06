import { describe, expect, it } from "vitest";
import { selectCompositorDisplayBucket } from "../../src/app/compositor-display-bucket";

describe("compositor display buckets", () => {
  it("uses the smallest bucket that provides the requested source density", () => {
    expect(selectCompositorDisplayBucket(200, 1)).toBe(512);
    expect(selectCompositorDisplayBucket(300, 1)).toBe(768);
    expect(selectCompositorDisplayBucket(400, 1)).toBe(1024);
    expect(selectCompositorDisplayBucket(550, 1)).toBe(1280);
    expect(selectCompositorDisplayBucket(900, 1)).toBe(1280);
  });

  it("selects a larger bucket at DPR 2 when the displayed width crosses a boundary", () => {
    expect(selectCompositorDisplayBucket(250, 1)).toBe(512);
    expect(selectCompositorDisplayBucket(250, 2)).toBe(768);
  });

  it("handles invalid dimensions and DPR without returning arbitrary widths", () => {
    expect(selectCompositorDisplayBucket(Number.NaN, Number.NaN)).toBe(512);
    expect(selectCompositorDisplayBucket(Number.POSITIVE_INFINITY, 2)).toBe(512);
    expect(selectCompositorDisplayBucket(-1, 2)).toBe(512);
    expect(selectCompositorDisplayBucket(10_000, 2)).toBe(1280);
  });
});
