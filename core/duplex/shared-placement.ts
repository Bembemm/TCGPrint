import {
  MAGIC_STANDARD_CARD,
  PAPER_FORMATS,
  calculateGridPagePlacements,
  type CardFormat,
  type PaperFormat,
  type PageMarginsMm,
  type PageOrientation,
  type TemplateLayoutGeometryMm,
} from "../geometry";
import type { GridPlacementPage } from "../geometry/page-placement";
import { generateRegistrationGeometry, type RegistrationConfig } from "../registration";

export interface SharedPlacementOptions {
  readonly bleedMm: number;
  readonly pageOrientation?: PageOrientation;
  readonly cardOrientation?: PageOrientation;
  readonly paperFormat?: PaperFormat;
  readonly cardFormat?: CardFormat;
  readonly marginsMm?: PageMarginsMm;
  readonly horizontalGapMm?: number;
  readonly verticalGapMm?: number;
  readonly registration?: RegistrationConfig;
  readonly templateGeometry?: TemplateLayoutGeometryMm;
  readonly layoutRows?: number;
  readonly layoutColumns?: number;
  readonly skippedSlotIndices?: readonly number[];
}

export interface SharedPagePlacementResult {
  readonly pages: readonly GridPlacementPage[];
  readonly pageOrientation: PageOrientation;
}

/** Builds the one physical front placement plan consumed by preview, PDF, cut and duplex pairing. */
export function calculateSharedPagePlacements(count: number, options: SharedPlacementOptions): SharedPagePlacementResult {
  const paper = options.paperFormat ?? PAPER_FORMATS.A4;
  const pageOrientation = options.pageOrientation ?? (paper.widthMm > paper.heightMm ? "landscape" : "portrait");
  const pageShouldBeLandscape = pageOrientation === "landscape";
  const paperIsLandscape = paper.widthMm > paper.heightMm;
  const effectivePaper = paperIsLandscape === pageShouldBeLandscape
    ? paper
    : { ...paper, widthMm: paper.heightMm, heightMm: paper.widthMm };
  const registration = generateRegistrationGeometry(options.registration ?? { type: "none", orientation: "portrait" }, {
    widthMm: effectivePaper.widthMm,
    heightMm: effectivePaper.heightMm,
  });
  const pages = calculateGridPagePlacements({
    placement: {
      paper,
      pageOrientation,
      card: options.cardFormat ?? MAGIC_STANDARD_CARD,
      cardOrientation: options.cardOrientation,
      bleedMm: 0,
      horizontalGapMm: options.horizontalGapMm,
      verticalGapMm: options.verticalGapMm,
      ...(options.marginsMm ? { marginsMm: options.marginsMm } : {}),
      ...(options.templateGeometry ? { templateGeometry: options.templateGeometry } : {}),
      reservedZonesMm: registration.reservedZones,
      ...(options.skippedSlotIndices ? { skippedSlotIndices: options.skippedSlotIndices } : {}),
      ...(options.layoutRows !== undefined ? { rows: options.layoutRows } : {}),
      ...(options.layoutColumns !== undefined ? { columns: options.layoutColumns } : {}),
    },
    count,
    bleedByCardMm: Array.from({ length: count }, () => options.bleedMm),
  });
  return { pages, pageOrientation };
}
