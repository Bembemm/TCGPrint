import { describe, expect, it } from "vitest";
import type { CutGuideConfig } from "../../core/geometry";
import { buildBleedExportOptions, buildCutGuideConfig } from "../../src/app/bleed-export-options";

describe("buildBleedExportOptions", () => {
  it("converts form extent and stroke values into the independent config shape", () => {
    expect(buildCutGuideConfig(true, "5", false, "0.3")).toEqual({
      trim: { enabled: true, extentMm: 5 },
      external: { enabled: false, strokeWidthPt: 0.3 },
    });
    expect(buildCutGuideConfig(false, "full", true, "0.7")).toEqual({
      trim: { enabled: false, extentMm: "full" },
      external: { enabled: true, strokeWidthPt: 0.7 },
    });
  });

  it("preserves independent guide settings and parses the physical bleed", () => {
    const cutGuides: CutGuideConfig = {
      trim: { enabled: true, extentMm: 5 },
      external: { enabled: false, strokeWidthPt: 0.3 },
    };

    expect(buildBleedExportOptions("0.625", cutGuides, true)).toEqual({
      bleedMm: 0.625,
      cutGuides,
      roundedCorners: true,
    });
  });

  it("does not enable either guide by default", () => {
    expect(buildBleedExportOptions("0", {
      trim: { enabled: false, extentMm: 1 },
      external: { enabled: false, strokeWidthPt: 0.3 },
    })).toEqual({
      bleedMm: 0,
      cutGuides: {
        trim: { enabled: false, extentMm: 1 },
        external: { enabled: false, strokeWidthPt: 0.3 },
      },
      roundedCorners: false,
    });
  });
});
