export interface PhysicalFormat {
  readonly name: string;
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface CardFormat extends PhysicalFormat {
  readonly id: string;
  readonly cornerRadiusMm?: number;
}

export interface PaperFormat extends PhysicalFormat {}

export type PageOrientation = "portrait" | "landscape";

export interface PageMarginsMm {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Page settings keep output orientation separate from the paper's dimensions. */
export interface PageConfiguration {
  readonly paper: PaperFormat;
  readonly orientation: PageOrientation;
  readonly marginsMm: PageMarginsMm;
}

export const MAGIC_STANDARD_CARD: CardFormat = Object.freeze({
  id: "magic-standard",
  name: "Magic Standard",
  widthMm: 63.5,
  heightMm: 88.9,
});

export const PAPER_FORMATS = Object.freeze({
  A4: Object.freeze({ id: "a4", name: "A4", widthMm: 210, heightMm: 297 }),
  A3: Object.freeze({ id: "a3", name: "A3", widthMm: 297, heightMm: 420 }),
  LETTER: Object.freeze({ id: "letter", name: "Letter", widthMm: 215.9, heightMm: 279.4 }),
  LEGAL: Object.freeze({ id: "legal", name: "Legal", widthMm: 215.9, heightMm: 355.6 }),
  TABLOID: Object.freeze({ id: "tabloid", name: "Tabloid", widthMm: 279.4, heightMm: 431.8 }),
} satisfies Record<string, PaperFormat>);

function assertPositiveDimension(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number greater than zero.`);
  }
}

function assertNonNegativeMargin(value: number, side: keyof PageMarginsMm): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Page margin ${side} must be a finite number greater than or equal to zero.`);
  }
}

/** Custom paper dimensions intentionally have no catalog ID. */
export function createCustomPaperFormat(widthMm: number, heightMm: number): PaperFormat {
  assertPositiveDimension(widthMm, "Paper width");
  assertPositiveDimension(heightMm, "Paper height");

  return Object.freeze({
    name: "Custom",
    widthMm,
    heightMm,
  });
}

export function createPageConfiguration(
  paper: PaperFormat,
  orientation: PageOrientation,
  marginsMm: PageMarginsMm,
): PageConfiguration {
  if (orientation !== "portrait" && orientation !== "landscape") {
    throw new RangeError(`Unsupported page orientation: ${String(orientation)}.`);
  }

  for (const side of ["top", "right", "bottom", "left"] as const) {
    assertNonNegativeMargin(marginsMm[side], side);
  }

  return Object.freeze({
    paper,
    orientation,
    marginsMm: Object.freeze({ ...marginsMm }),
  });
}

export {
  CUT_GUIDE_LINE_STYLES,
  CUT_GUIDE_MODES,
  CutGuideEngine,
} from "./cut-guides";
export type {
  CutGuideConfig,
  CutGuideGeometry,
  CutGuideLineStyle,
  CutGuideMode,
  CutGuidePageSizeMm,
  CutGuideSegmentMm,
  CutGuideStyle,
  CutGuideRequest,
  TrimRectangleMm,
} from "./cut-guides";
export { calculateGridPlacement } from "./placement";
export type { CardSlotMm, GridPlacementMm, GridPlacementRequest } from "./placement";
