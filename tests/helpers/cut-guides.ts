import type { CutGuideConfig } from "../../core/geometry";

export const NO_CUT_GUIDES: CutGuideConfig = {
  trim: { enabled: false, extentMm: 1 },
  external: { enabled: false, strokeWidthPt: 0.3 },
};

export const FULL_TRIM_GUIDES: CutGuideConfig = {
  trim: { enabled: true, extentMm: "full" },
  external: { enabled: false, strokeWidthPt: 0.3 },
};
