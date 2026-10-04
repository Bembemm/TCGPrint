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
import { generateRegistrationGeometry, type RegistrationConfig, type RegistrationGeometryMm } from "../registration";
import { createDuplexPagePairing } from "./page-pairing";
import type { DuplexFlipMode, DuplexPagePairingPlan } from "./types";

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
  /** Effective per-card bleed values, in physical card order. */
  readonly bleedByCardMm?: readonly number[];
  readonly duplexFlipMode?: DuplexFlipMode;
}

export interface SharedPagePlacementResult {
  readonly pages: readonly GridPlacementPage[];
  readonly pageOrientation: PageOrientation;
  readonly registrationGeometry: RegistrationGeometryMm;
  readonly duplexPairing: DuplexPagePairingPlan;
}

/** Builds the canonical physical plan consumed by live composition, PDF, cut, registration and duplex. */
export function buildCanonicalPrintPlan(count: number, options: SharedPlacementOptions): SharedPagePlacementResult {
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
      bleedMm: options.bleedMm,
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
    bleedByCardMm: options.bleedByCardMm ?? Array.from({ length: count }, () => options.bleedMm),
  });
  const pageSizeMm = pages[0]?.placement.pageSizeMm;
  if (!pageSizeMm) throw new RangeError("Canonical print plan has no physical page.");
  const registrationGeometry = registration;
  const duplexPairing = createDuplexPagePairing(pages, {
    pageOrientation,
    flipMode: options.duplexFlipMode ?? "long-edge",
  });
  return { pages, pageOrientation, registrationGeometry, duplexPairing };
}

/** Backwards-compatible page-only projection of the canonical print plan. */
export function calculateSharedPagePlacements(count: number, options: SharedPlacementOptions): Pick<SharedPagePlacementResult, "pages" | "pageOrientation"> {
  const plan = buildCanonicalPrintPlan(count, options);
  return { pages: plan.pages, pageOrientation: plan.pageOrientation };
}
