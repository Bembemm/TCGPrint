import type { CutGuideConfig } from "../../core/geometry";

export const NO_CUT_GUIDES: CutGuideConfig = {
  trim: { enabled: false, extentMm: 1, color: "blue" },
  external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
};

export const FULL_TRIM_GUIDES: CutGuideConfig = {
  trim: { enabled: true, extentMm: "full", color: "blue" },
  external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
};
