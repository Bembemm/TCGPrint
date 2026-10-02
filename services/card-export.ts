import { createHash } from "node:crypto";
import { PDFDocument } from "@pdfme/pdf-lib";
import {
  BLEED_ALGORITHM_VERSION,
  BleedEngine,
  BleedGenerationError,
  createBleedCacheKey,
  resolveBleedSourcePolicy,
  type BleedMode,
  type BleedModePreference,
  type BleedDerivativeResult,
  type BleedResult,
} from "../image-engine/bleed";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS, type CardFormat, type CutGuideConfig, type PaperFormat, type TemplateLayoutGeometryMm } from "../core/geometry";
import { CutGuideEngine, getCutGuideStrokeBoundsMm, parseCutGuideConfig } from "../core/geometry/cut-guides";
import { createDuplexPagePairing, DuplexPairingError, type DuplexPagePairingPlan, type DuplexFlipMode } from "../core/duplex";
import type { PageMarginsMm, PageOrientation } from "../core/geometry";
import { generateRegistrationGeometry, transformRegistrationGeometry, type RegistrationConfig } from "../core/registration";
import type { GridPlacementPage } from "../core/geometry/page-placement";
import { LosslessPdfEngine, PdfExportError } from "../pdf-engine/document";
import { mpcArtworkCandidateId } from "../core/cards/ids";
import { MAX_PHYSICAL_CARDS_PER_EXPORT } from "../core/cards/limits";
import type { ArtworkCandidate, CardFaceSide, SelectedArtwork, WorkingCard, WorkingCardMpcReference } from "../core/cards/types";
import { fallbackToProjectDefaultBack, resolveEffectiveCardBack, isDoubleFacedIdentity } from "../core/cards/back-selection";
import type { BackLibraryAssetReference, CardIdentity } from "../core/cards/types";
import type { CardWorkbench } from "./card-workbench";
import type { ArtworkOriginal } from "../artwork/storage/types";
import { BackLibraryError } from "./back-library";
import type { ExportContentMode, MissingBackPolicy } from "../persistence/projects/serializer";
import { calculateSharedPagePlacements } from "../core/duplex/shared-placement";
import type { DuplexBackPageTransform } from "../core/duplex";
import { CalibrationError, createPrintCalibrationTransform, getCalibrationPageOverflowMm, type CalibrationSide, type PrinterProfileSnapshot, type SideCalibration } from "../core/calibration";

export interface CardExportOptions {
  readonly bleedMm: number;
  readonly cutGuides: CutGuideConfig;
  readonly roundedCorners?: boolean;
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
  /** Internal shared front/back placement plan; absent for the legacy front-only path. */
  readonly pagePlacements?: readonly GridPlacementPage[];
  /** Internal vector/page transform required by every back-side render. */
  readonly duplexBackPageTransform?: DuplexBackPageTransform;
  /** Missing back indexes remain in pagePlacements while no image is painted. */
  readonly skipImageIndexes?: ReadonlySet<number>;
  readonly exportContentMode?: ExportContentMode;
  readonly duplexFlipMode?: DuplexFlipMode;
  readonly missingBackPolicy?: MissingBackPolicy;
  readonly projectDefaultBack?: BackLibraryAssetReference | null;
  readonly projectRevision?: number | null;
  /** Validated immutable Project profile snapshot used to select each physical side correction. */
  readonly printerProfileSelection?: PrinterProfileSnapshot | null;
  /** Low-level page-engine option for direct engine callers; project exports use the profile snapshot. */
  readonly printCalibration?: SideCalibration;
  readonly calibrationSide?: CalibrationSide;
}

export interface CardExportBleedDiagnostic {
  readonly workingCardId: string;
  readonly identityId: string | null;
  readonly cardName: string;
  readonly source: ArtworkCandidate["source"];
  readonly requestedMode: BleedModePreference;
  readonly resolvedMode: BleedMode;
  readonly effectiveMode: BleedResult["effectiveMode"];
  readonly algorithmVersion: typeof BLEED_ALGORITHM_VERSION;
  readonly policyId: string;
  readonly bleedMm: number;
  readonly trimSizeMm: BleedResult["trimSizeMm"];
  readonly roundedCorners: boolean;
  readonly cornerRadiusMm?: number;
  readonly sideDiagnostics: BleedDerivativeResult["sideDiagnostics"];
  readonly previewSha256: string;
}

export interface CardExportResult {
  readonly pdfBytes: Uint8Array;
  readonly bleedDiagnostics: readonly CardExportBleedDiagnostic[];
  readonly calibrationBoundsWarnings: readonly CalibrationBoundsWarning[];
}

export interface CalibrationBoundsWarning {
  readonly code: "CALIBRATION_NEAR_PAGE_EDGE";
  readonly side: CalibrationSide;
  readonly pageNumber: number;
  readonly content: string;
  readonly nearestEdgeClearanceMm: number;
}

const CALIBRATION_EDGE_WARNING_CLEARANCE_MM = 0.5;
const MAX_CALIBRATION_BOUNDS_WARNINGS = 20;

export interface BackExportPreflightItem {
  readonly cardId: string;
  readonly cardName: string;
  readonly physicalCardIndex: number;
  readonly copyNumber: number;
  readonly backMode: WorkingCard["backMode"];
  readonly reason: string;
}

export interface BackExportPreflight {
  readonly projectRevision: number | null;
  readonly totalPhysicalCards: number;
  readonly dfcPhysicalCards: number;
  readonly simplePhysicalCards: number;
  readonly backs: {
    readonly auto: number;
    readonly projectDefault: number;
    readonly manual: number;
    readonly noneOrMissing: number;
  };
  readonly missing: readonly BackExportPreflightItem[];
  readonly warnings: readonly BackExportPreflightItem[];
}

export interface SeparatePdfManifest {
  readonly schemaVersion: 1;
  readonly projectRevision: number | null;
  readonly pageOrientation: PageOrientation;
  readonly cardOrientation: PageOrientation;
  readonly flipMode: DuplexFlipMode;
  readonly frontPdf: { readonly filename: "front.pdf"; readonly sha256: string; readonly pageCount: number };
  readonly backPdf: { readonly filename: "back.pdf"; readonly sha256: string; readonly pageCount: number };
  readonly pagePairs: readonly {
    readonly frontPageNumber: number;
    readonly backPageNumber: number;
    readonly physicalSlotReflectionAxis: "x" | "y";
    readonly registrationReflectionAxis: "x" | "y";
    readonly backArtworkRotationDegrees: 0 | 180;
    readonly slots: readonly {
      readonly physicalCardIndex: number | null;
      readonly frontSlotIndex: number;
      readonly backSlotIndex: number;
      readonly skipped: boolean;
      readonly reserved: boolean;
    }[];
  }[];
  readonly calibration?: CalibrationExportDiagnostic;
  readonly calibrationBoundsWarnings?: readonly CalibrationBoundsWarning[];
}

export interface CalibrationExportDiagnostic {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileHash: string;
  readonly effectiveSides: readonly {
    readonly side: CalibrationSide;
    readonly parameters: SideCalibration;
  }[];
}

export interface CardExportModeResult {
  readonly contentMode: ExportContentMode;
  readonly pdfBytes?: Uint8Array;
  readonly bleedDiagnostics: readonly CardExportBleedDiagnostic[];
  readonly frontPdfBytes?: Uint8Array;
  readonly backPdfBytes?: Uint8Array;
  readonly manifest?: SeparatePdfManifest;
  readonly pagePairingPlan?: DuplexPagePairingPlan;
  readonly pageOrder?: readonly string[];
  readonly preflight: BackExportPreflight;
  readonly calibration?: CalibrationExportDiagnostic;
  readonly calibrationBoundsWarnings?: readonly CalibrationBoundsWarning[];
}

export class CardExportServiceError extends Error {
  constructor(readonly code: "ARTWORK_REQUIRED" | "ARTWORK_ORIGINAL_UNAVAILABLE" | "BACK_REQUIRED" | "BACK_ORIGINAL_UNAVAILABLE" | "INVALID_BACK_MODE" | "INVALID_DUPLEX_FLIP" | "DUPLEX_PAIRING_FAILED" | "INVALID_CARD_ID" | "UNSUPPORTED_FORMAT" | "INVALID_BLEED" | "INVALID_ROUNDED_CORNERS" | "EXPORT_FAILED" | "EXPORT_TOO_LARGE", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CardExportServiceError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}

function mpcReferencesForSelection(card: WorkingCard, selection: SelectedArtwork): readonly WorkingCardMpcReference[] {
  if (selection.source !== "mpc") return card.mpcReferences;
  const faceId: CardFaceSide = selection.faceId === "back" ? "back" : "front";
  const providerAssetId = selection.providerAssetId ?? selection.selectedArtworkId;
  if (!providerAssetId || mpcArtworkCandidateId(providerAssetId, faceId) !== selection.candidateId) return card.mpcReferences;
  const alreadyReferenced = card.mpcReferences.some((reference) =>
    (reference.faceId === "front" || reference.faceId === "back")
    && mpcArtworkCandidateId(reference.importedAssetId, reference.faceId) === selection.candidateId,
  );
  if (alreadyReferenced) return card.mpcReferences;
  return [...card.mpcReferences, {
    faceId,
    importedAssetId: providerAssetId,
    providerAssetId,
    selectedArtworkId: selection.selectedArtworkId ?? providerAssetId,
    referenceOrigin: "gallery-selection",
    slots: [],
    availableLocally: false,
  }];
}

function isMpcUnsupportedFormat(error: unknown): error is Error & { readonly kind: "unsupported-format" } {
  return error instanceof Error && "kind" in error && error.kind === "unsupported-format";
}

function mpcExportFailure(error: unknown): CardExportServiceError {
  if (isMpcUnsupportedFormat(error)) return new CardExportServiceError("UNSUPPORTED_FORMAT", error.message, { cause: error });
  return new CardExportServiceError(
    "ARTWORK_ORIGINAL_UNAVAILABLE",
    `The selected MPC original is missing, corrupt, or not validated in local storage, and the provider could not revalidate it${error instanceof Error ? `: ${error.message}` : "."}`,
    { cause: error },
  );
}

/** Composes quantity copies only here, then delegates all geometry/raster/PDF work to the existing engines. */
export async function exportWorkingCardsWithDiagnostics(
  catalog: Pick<CardWorkbench, "getArtworkCandidate" | "getArtworkOriginal">,
  cards: readonly WorkingCard[],
  options: CardExportOptions,
  signal?: AbortSignal,
): Promise<CardExportResult> {
  if (!Number.isFinite(options.bleedMm) || options.bleedMm < 0 || options.bleedMm > 3) {
    throw new CardExportServiceError("INVALID_BLEED", "Bleed must be between 0 and 3 mm.");
  }
  const roundedCorners = options.roundedCorners ?? false;
  if (typeof roundedCorners !== "boolean") {
    throw new CardExportServiceError("INVALID_ROUNDED_CORNERS", "Rounded corners must be enabled or disabled explicitly.");
  }

  const total = cards.reduce((sum, card) => sum + card.quantity, 0);
  if (total < 1) throw new CardExportServiceError("ARTWORK_REQUIRED", "Add at least one card to export.");
  if (total > MAX_PHYSICAL_CARDS_PER_EXPORT) throw new CardExportServiceError("EXPORT_TOO_LARGE", `The first export is limited to ${MAX_PHYSICAL_CARDS_PER_EXPORT} physical cards per PDF.`);

  const uniqueImages = new Map<string, Uint8Array>();
  const uniqueBleeds = new Map<string, BleedResult>();
  const composedImages: Uint8Array[] = [];
  const composedBleeds: Array<BleedResult | undefined> = [];
  const bleedDiagnostics: CardExportBleedDiagnostic[] = [];
  const bleedEngine = new BleedEngine();
  const pdfEngine = new LosslessPdfEngine();
  const paperFormat = options.paperFormat ?? PAPER_FORMATS.A4;
  const cardFormat = options.cardFormat ?? MAGIC_STANDARD_CARD;
  // Bleed is generated in the source artwork's coordinate frame. The PDF
  // engine rotates the finished artwork and derivative together for card
  // orientation, so these dimensions must remain the unrotated CardFormat.
  const trimSizeMm = { widthMm: cardFormat.widthMm, heightMm: cardFormat.heightMm };
  if (roundedCorners && cardFormat.cornerRadiusMm === undefined) {
    throw new CardExportServiceError("INVALID_ROUNDED_CORNERS", "Rounded-corner bleed needs a card format with an explicit physical corner radius.");
  }

  let nextPhysicalCardIndex = 0;
  for (const card of [...cards].sort((a, b) => a.order - b.order)) {
    if (signal?.aborted) throw new CardExportServiceError("EXPORT_FAILED", "PDF export was cancelled.");
    const physicalCardIndexes = Array.from({ length: card.quantity }, () => nextPhysicalCardIndex++);
    const drawableCopies = physicalCardIndexes.filter((index) => !options.skipImageIndexes?.has(index));
    if (drawableCopies.length === 0) {
      for (const _physicalCardIndex of physicalCardIndexes) {
        composedImages.push(new Uint8Array());
        composedBleeds.push(undefined);
      }
      continue;
    }
    const selection = card.selectedArtworkByFace.front;
    if (!selection) throw new CardExportServiceError("ARTWORK_REQUIRED", `${card.identity?.name ?? card.identityHints.name ?? "Custom card"} needs a selected front artwork.`);
    let candidate: ArtworkCandidate | undefined;
    try {
      candidate = await catalog.getArtworkCandidate(selection.candidateId, {
        mpcReferences: mpcReferencesForSelection(card, selection),
        ...(card.identity ? { identity: card.identity } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (selection.source === "mpc") throw mpcExportFailure(error);
      throw error;
    }
    if (!candidate || candidate.source !== selection.source || !candidate.originalAvailable) {
      throw new CardExportServiceError("ARTWORK_ORIGINAL_UNAVAILABLE", "The selected artwork has no locally available, validated original. MPC references need local bytes before PDF export.");
    }
    let original: Awaited<ReturnType<CardWorkbench["getArtworkOriginal"]>>;
    try {
      original = await catalog.getArtworkOriginal(candidate.id, signal);
    } catch (error) {
      if (selection.source === "mpc") throw mpcExportFailure(error);
      throw error;
    }
    if (!(original.bytes instanceof Uint8Array) || original.bytes.byteLength !== original.byteLength) {
      throw new CardExportServiceError("ARTWORK_ORIGINAL_UNAVAILABLE", "The selected original failed local byte validation.");
    }
    if (!["jpeg", "png", "svg"].includes(original.format)) {
      throw new CardExportServiceError("UNSUPPORTED_FORMAT", `The PDF engine does not currently support ${original.format.toUpperCase()} artwork.`);
    }
    const hash = digest(original.bytes);
    let image = uniqueImages.get(hash);
    if (!image) {
      image = original.bytes;
      uniqueImages.set(hash, image);
    }
    let bleed: BleedResult | undefined;
    if (options.bleedMm > 0 || roundedCorners) {
      if (original.format === "svg") {
        throw new CardExportServiceError("UNSUPPORTED_FORMAT", "SVG artwork stays vector; raster bleed and rounded-corner derivatives are not supported for SVG.");
      }
      const policy = resolveBleedSourcePolicy({ source: candidate.source, format: original.format, metadata: candidate.metadata });
      const cornerRadiusMm = cardFormat.cornerRadiusMm;
      const key = createBleedCacheKey({
        originalSha256: hash,
        bleedMm: options.bleedMm,
        trimWidthMm: trimSizeMm.widthMm,
        trimHeightMm: trimSizeMm.heightMm,
        roundedCorners,
        ...(roundedCorners ? { cornerRadiusMm } : {}),
      });
      bleed = uniqueBleeds.get(key);
      if (!bleed) {
        try {
          bleed = await bleedEngine.generate({
            imageBytes: image,
            bleedMm: options.bleedMm,
            trimSizeMm,
            mode: policy.mode,
            policyId: policy.policyId,
            roundedCorners,
            ...(roundedCorners ? { cornerRadiusMm } : {}),
          });
          uniqueBleeds.set(key, bleed);
        } catch (error) {
          if (error instanceof BleedGenerationError) throw new CardExportServiceError("EXPORT_FAILED", error.message, { cause: error });
          throw error;
        }
      }
      if (bleed.status !== "derived") throw new CardExportServiceError("EXPORT_FAILED", "Positive bleed unexpectedly returned a passthrough result.");
      bleedDiagnostics.push({
        workingCardId: card.id,
        identityId: card.identity?.id ?? null,
        cardName: card.identity?.name ?? card.identityHints.name ?? "Custom card",
        source: candidate.source,
        requestedMode: policy.requestedMode,
        resolvedMode: policy.mode,
        effectiveMode: bleed.effectiveMode,
        algorithmVersion: bleed.algorithmVersion,
        policyId: policy.policyId,
        bleedMm: options.bleedMm,
        trimSizeMm: bleed.trimSizeMm,
        roundedCorners,
        ...(roundedCorners ? { cornerRadiusMm } : {}),
        sideDiagnostics: bleed.sideDiagnostics,
        previewSha256: digest(bleed.preview.bytes),
      });
    }
    for (const physicalCardIndex of physicalCardIndexes) {
      if (options.skipImageIndexes?.has(physicalCardIndex)) {
        composedImages.push(new Uint8Array());
        composedBleeds.push(undefined);
      } else {
        composedImages.push(image);
        composedBleeds.push(bleed);
      }
    }
  }

  const pagePlacements = options.pagePlacements ?? calculateSharedPagePlacements(total, options).pages;
  const calibrationBoundsWarnings: CalibrationBoundsWarning[] = [];
  if (options.printCalibration) {
    const side = options.calibrationSide ?? "front";
    const addWarning = (pageNumber: number, content: string, minimumClearanceMm: number) => {
      if (minimumClearanceMm > 0.001 && minimumClearanceMm <= CALIBRATION_EDGE_WARNING_CLEARANCE_MM
        && calibrationBoundsWarnings.length < MAX_CALIBRATION_BOUNDS_WARNINGS) {
        calibrationBoundsWarnings.push({
          code: "CALIBRATION_NEAR_PAGE_EDGE", side, pageNumber, content,
          nearestEdgeClearanceMm: Number(minimumClearanceMm.toFixed(3)),
        });
      }
    };
    const guideConfig = parseCutGuideConfig(options.cutGuides);
    for (const page of pagePlacements) {
      const pageSizeMm = page.placement.pageSizeMm;
      const transform = createPrintCalibrationTransform(pageSizeMm, options.printCalibration, side);
      if (transform.isIdentity) continue;
      for (let imageIndex = page.startCardIndex; imageIndex < page.endCardIndex; imageIndex += 1) {
        if (options.skipImageIndexes?.has(imageIndex)) continue;
        const slot = page.placement.slots.find((item) => item.cardIndex === imageIndex - page.startCardIndex);
        if (!slot) continue;
        const bleedMm = composedBleeds[imageIndex]?.status === "derived" ? composedBleeds[imageIndex]!.bleedMm : 0;
        const bounds = getCalibrationPageOverflowMm(pageSizeMm, {
          xMm: slot.trim.xMm - bleedMm,
          yMm: slot.trim.yMm - bleedMm,
          widthMm: page.placement.cardSizeMm.widthMm + 2 * bleedMm,
          heightMm: page.placement.cardSizeMm.heightMm + 2 * bleedMm,
        }, transform.matrix);
        addWarning(page.pageIndex + 1, `card ${imageIndex + 1}`, bounds.minimumClearanceMm);
      }
      const registration = generateRegistrationGeometry(options.registration ?? { type: "none", orientation: "portrait" }, pageSizeMm);
      const pageRegistration = options.duplexBackPageTransform
        ? transformRegistrationGeometry(registration, pageSizeMm, options.duplexBackPageTransform.registrationReflectionAxis)
        : registration;
      for (const mark of pageRegistration.marks) {
        const bounds = getCalibrationPageOverflowMm(pageSizeMm, mark.bounds, transform.matrix);
        addWarning(page.pageIndex + 1, `registration mark ${mark.id}`, bounds.minimumClearanceMm);
      }
      const guideCards = page.placement.slots.map((slot, localCardIndex) => {
        const bleed = composedBleeds[page.startCardIndex + localCardIndex];
        return {
          trim: slot.trim,
          bleedMm: bleed?.status === "derived" ? bleed.bleedMm : 0,
        };
      });
      const guideGeometry = new CutGuideEngine().generate({ cards: guideCards, pageSizeMm, config: guideConfig });
      for (const guide of getCutGuideStrokeBoundsMm(guideGeometry, guideConfig)) {
        const bounds = getCalibrationPageOverflowMm(pageSizeMm, guide.bounds, transform.matrix);
        if (bounds.maximumMm > 0.001) {
          throw new CalibrationError(
            "CALIBRATED_CONTENT_OUT_OF_BOUNDS",
            `Calibrated ${guide.kind} cut guide ${guide.index + 1} extends ${bounds.maximumMm.toFixed(3)} mm beyond the printable page bounds.`,
          );
        }
        addWarning(page.pageIndex + 1, `${guide.kind} cut guide ${guide.index + 1}`, bounds.minimumClearanceMm);
      }
    }
  }

  try {
    const pdfBytes = await pdfEngine.generate({
      images: composedImages,
      bleedResults: composedBleeds,
      cutGuides: options.cutGuides,
      paperFormat,
      cardFormat,
      pageOrientation: options.pageOrientation,
      cardOrientation: options.cardOrientation,
      marginsMm: options.marginsMm,
      horizontalGapMm: options.horizontalGapMm,
      verticalGapMm: options.verticalGapMm,
      templateGeometry: options.templateGeometry,
      registration: options.registration,
      layoutRows: options.layoutRows,
      layoutColumns: options.layoutColumns,
      skippedSlotIndices: options.skippedSlotIndices,
      pagePlacements,
      ...(options.duplexBackPageTransform ? { duplexBackPageTransform: options.duplexBackPageTransform } : {}),
      ...(options.skipImageIndexes ? { skipImageIndexes: options.skipImageIndexes } : {}),
      ...(options.printCalibration ? { printCalibration: options.printCalibration, calibrationSide: options.calibrationSide ?? "front" } : {}),
    });
    return { pdfBytes, bleedDiagnostics, calibrationBoundsWarnings: Object.freeze(calibrationBoundsWarnings) };
  } catch (error) {
    if (error instanceof PdfExportError) throw new CardExportServiceError("EXPORT_FAILED", error.message, { cause: error });
    throw error;
  }
}

export async function exportWorkingCards(
  catalog: Pick<CardWorkbench, "getArtworkCandidate" | "getArtworkOriginal">,
  cards: readonly WorkingCard[],
  options: CardExportOptions,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return (await exportWorkingCardsWithDiagnostics(catalog, cards, options, signal)).pdfBytes;
}

export interface CardExportContentOptions extends CardExportOptions {
  readonly exportContentMode?: ExportContentMode;
  readonly duplexFlipMode?: DuplexFlipMode;
  readonly missingBackPolicy?: MissingBackPolicy;
  readonly projectDefaultBack?: BackLibraryAssetReference | null;
  readonly projectRevision?: number | null;
}

function optionsForSide(options: CardExportContentOptions, side: CalibrationSide): CardExportOptions {
  const profile = options.printerProfileSelection;
  return {
    ...options,
    ...(profile ? { printCalibration: profile[side], calibrationSide: side } : {}),
  };
}

function calibrationDiagnostic(options: CardExportContentOptions, sides: readonly CalibrationSide[]): CalibrationExportDiagnostic | undefined {
  const profile = options.printerProfileSelection;
  if (!profile) return undefined;
  return {
    profileId: profile.id,
    profileVersion: profile.version,
    profileHash: profile.profileHash,
    effectiveSides: sides.map((side) => ({ side, parameters: profile[side] })),
  };
}

export interface BackLibraryOriginalSource {
  resolveOriginal(reference: BackLibraryAssetReference): Promise<ArtworkOriginal>;
}

interface PhysicalCopy {
  readonly card: WorkingCard;
  readonly physicalCardIndex: number;
  readonly copyNumber: number;
}

interface ResolvedBack {
  readonly mode: WorkingCard["backMode"];
  readonly selection?: SelectedArtwork;
  readonly libraryReference?: BackLibraryAssetReference;
  readonly missingReason?: string;
}

function orderedPhysicalCopies(cards: readonly WorkingCard[]): readonly PhysicalCopy[] {
  const physical: PhysicalCopy[] = [];
  const ids = new Set<string>();
  for (const card of cards) {
    if (!card.id || ids.has(card.id)) throw new CardExportServiceError("INVALID_CARD_ID", "Every logical card in an export must have a unique card ID.");
    ids.add(card.id);
  }
  const orderedCards = cards.map((card, index) => ({ card, index })).sort((left, right) => left.card.order - right.card.order || left.index - right.index);
  for (const { card } of orderedCards) {
    for (let copy = 0; copy < card.quantity; copy += 1) {
      physical.push({ card, physicalCardIndex: physical.length, copyNumber: copy + 1 });
    }
  }
  return physical;
}

function backName(card: WorkingCard): string {
  return card.identity?.name ?? card.identityHints.name ?? "Custom card";
}

function sharedPagePlacements(count: number, options: CardExportOptions): { readonly pages: readonly GridPlacementPage[]; readonly pageOrientation: PageOrientation } {
  return calculateSharedPagePlacements(count, options);
}

function memoizedArtworkCatalog(
  catalog: Pick<CardWorkbench, "getArtworkCandidate" | "getArtworkOriginal">,
  directCandidates: ReadonlyMap<string, ArtworkCandidate>,
  directOriginals: ReadonlyMap<string, ArtworkOriginal>,
): Pick<CardWorkbench, "getArtworkCandidate" | "getArtworkOriginal"> {
  const candidates = new Map<string, ReturnType<CardWorkbench["getArtworkCandidate"]>>();
  const originals = new Map<string, ReturnType<CardWorkbench["getArtworkOriginal"]>>();
  return {
    getArtworkCandidate(candidateId, options) {
      const direct = directCandidates.get(candidateId);
      if (direct) return Promise.resolve(direct);
      const key = JSON.stringify([candidateId, options?.identity?.id ?? null, options?.mpcReferences ?? []]);
      let pending = candidates.get(key);
      if (!pending) {
        pending = catalog.getArtworkCandidate(candidateId, options);
        candidates.set(key, pending);
      }
      return pending;
    },
    getArtworkOriginal(candidateId, signal) {
      const direct = directOriginals.get(candidateId);
      if (direct) return Promise.resolve(direct);
      let pending = originals.get(candidateId);
      if (!pending) {
        pending = catalog.getArtworkOriginal(candidateId, signal);
        originals.set(candidateId, pending);
      }
      return pending;
    },
  };
}

function separateManifest(
  plan: DuplexPagePairingPlan,
  frontPdfBytes: Uint8Array,
  backPdfBytes: Uint8Array,
  projectRevision: number | null,
  cardOrientation: PageOrientation,
  calibration?: CalibrationExportDiagnostic,
  calibrationBoundsWarnings: readonly CalibrationBoundsWarning[] = [],
): SeparatePdfManifest {
  return {
    schemaVersion: 1,
    projectRevision,
    pageOrientation: plan.pageOrientation,
    cardOrientation,
    flipMode: plan.flipMode,
    frontPdf: { filename: "front.pdf", sha256: digest(frontPdfBytes), pageCount: plan.pagePairs.length },
    backPdf: { filename: "back.pdf", sha256: digest(backPdfBytes), pageCount: plan.pagePairs.length },
    pagePairs: plan.pagePairs.map((pair) => ({
      frontPageNumber: pair.frontPageNumber,
      backPageNumber: pair.backPageNumber,
      physicalSlotReflectionAxis: pair.backPageTransform.physicalSlotReflectionAxis,
      registrationReflectionAxis: pair.backPageTransform.registrationReflectionAxis,
      backArtworkRotationDegrees: pair.backPageTransform.artworkOrientation.rotationDegrees,
      slots: pair.slots.map((slot) => ({
        physicalCardIndex: slot.physicalCardIndex ?? null,
        frontSlotIndex: slot.frontSlotIndex,
        backSlotIndex: slot.backSlotIndex,
        skipped: slot.skippedByUser,
        reserved: slot.reserved,
      })),
    })),
    ...(calibration ? { calibration } : {}),
    ...(calibrationBoundsWarnings.length ? { calibrationBoundsWarnings } : {}),
  };
}

async function interleavePdfPages(
  frontPdfBytes: Uint8Array,
  backPdfBytes: Uint8Array,
  plan: DuplexPagePairingPlan,
): Promise<Uint8Array> {
  try {
    const front = await PDFDocument.load(frontPdfBytes);
    const back = await PDFDocument.load(backPdfBytes);
    if (front.getPageCount() !== plan.pagePairs.length || back.getPageCount() !== plan.pagePairs.length) {
      throw new CardExportServiceError("DUPLEX_PAIRING_FAILED", "Front and back page counts do not match the shared physical pairing plan.");
    }
    const interleaved = await PDFDocument.create();
    for (const pair of plan.pagePairs) {
      const [frontPage] = await interleaved.copyPages(front, [pair.frontPageIndex]);
      const [backPage] = await interleaved.copyPages(back, [pair.backPageIndex]);
      interleaved.addPage(frontPage!);
      interleaved.addPage(backPage!);
    }
    return new Uint8Array(await interleaved.save());
  } catch (error) {
    if (error instanceof CardExportServiceError) throw error;
    throw new CardExportServiceError("DUPLEX_PAIRING_FAILED", "Duplex front/back pages could not be interleaved by their explicit page pairing.", { cause: error });
  }
}

/** Resolves backs once per logical card and renders every mode from one shared physical placement plan. */
export async function exportWorkingCardsByContentMode(
  catalog: Pick<CardWorkbench, "getArtworkCandidate" | "getArtworkOriginal">,
  backLibrary: BackLibraryOriginalSource | undefined,
  cards: readonly WorkingCard[],
  options: CardExportContentOptions,
  signal?: AbortSignal,
): Promise<CardExportModeResult> {
  const contentMode = options.exportContentMode ?? "front-only";
  if (contentMode !== "front-only" && contentMode !== "back-only" && contentMode !== "front-back-separated" && contentMode !== "duplex") {
    throw new CardExportServiceError("INVALID_BACK_MODE", "Export content mode is invalid.");
  }
  const physical = orderedPhysicalCopies(cards);
  const totalPhysicalCards = physical.length;
  if (totalPhysicalCards < 1) throw new CardExportServiceError("ARTWORK_REQUIRED", "Add at least one card to export.");
  if (totalPhysicalCards > MAX_PHYSICAL_CARDS_PER_EXPORT) throw new CardExportServiceError("EXPORT_TOO_LARGE", `The first export is limited to ${MAX_PHYSICAL_CARDS_PER_EXPORT} physical cards per PDF.`);
  const dfcPhysicalCards = physical.filter(({ card }) => isDoubleFacedIdentity(card.identity)).length;
  const commonPreflight = {
    projectRevision: options.projectRevision ?? null,
    totalPhysicalCards,
    dfcPhysicalCards,
    simplePhysicalCards: totalPhysicalCards - dfcPhysicalCards,
  };
  const emptyBackCounts = { auto: 0, projectDefault: 0, manual: 0, noneOrMissing: 0 };
  if (contentMode === "front-only") {
    const front = await exportWorkingCardsWithDiagnostics(catalog, cards, optionsForSide(options, "front"), signal);
    return {
      contentMode,
      pdfBytes: front.pdfBytes,
      bleedDiagnostics: front.bleedDiagnostics,
      preflight: { ...commonPreflight, backs: emptyBackCounts, missing: [], warnings: [] },
      ...(calibrationDiagnostic(options, ["front"]) ? { calibration: calibrationDiagnostic(options, ["front"]) } : {}),
      ...(front.calibrationBoundsWarnings.length ? { calibrationBoundsWarnings: front.calibrationBoundsWarnings } : {}),
    };
  }
  if (options.duplexFlipMode !== undefined && options.duplexFlipMode !== "long-edge" && options.duplexFlipMode !== "short-edge") {
    throw new CardExportServiceError("INVALID_DUPLEX_FLIP", "Duplex flip mode must be long-edge or short-edge.");
  }
  const flipMode = options.duplexFlipMode ?? "long-edge";
  const missingBackPolicy = options.missingBackPolicy ?? "use-project-default";
  if (!(["use-project-default", "blank", "warn-and-continue", "block"] as const).includes(missingBackPolicy)) {
    throw new CardExportServiceError("INVALID_BACK_MODE", "Missing-back policy is invalid.");
  }
  const { pages, pageOrientation } = sharedPagePlacements(totalPhysicalCards, options);
  let pairingPlan: DuplexPagePairingPlan;
  try { pairingPlan = createDuplexPagePairing(pages, { pageOrientation, flipMode }); }
  catch (error) {
    if (error instanceof DuplexPairingError) throw new CardExportServiceError(error.code, error.message, { cause: error });
    throw error;
  }

  const missing: BackExportPreflightItem[] = [];
  const warnings: BackExportPreflightItem[] = [];
  const backCounts = { auto: 0, projectDefault: 0, manual: 0, noneOrMissing: 0 };
  const resolvedByCard = new Map<string, ResolvedBack>();
  const directCandidates = new Map<string, ArtworkCandidate>();
  const directOriginals = new Map<string, ArtworkOriginal>();
  const originalByBackHash = new Map<string, ArtworkOriginal>();
  const physicalBackSelections = new Map<number, SelectedArtwork>();

  for (const copy of physical) {
    if (signal?.aborted) throw new CardExportServiceError("EXPORT_FAILED", "PDF export was cancelled.");
    let resolved = resolvedByCard.get(copy.card.id);
    if (!resolved) {
      const effective = resolveEffectiveCardBack(copy.card, options.projectDefaultBack);
      const resolvedBack = missingBackPolicy === "use-project-default"
        ? fallbackToProjectDefaultBack(copy.card, effective, options.projectDefaultBack)
        : effective;
      if (resolvedBack.status === "available") {
        resolved = {
          mode: resolvedBack.mode,
          ...(resolvedBack.artwork ? { selection: resolvedBack.artwork } : {}),
          ...(resolvedBack.asset ? { libraryReference: resolvedBack.asset } : {}),
        };
      } else {
        resolved = {
          mode: resolvedBack.mode,
          missingReason: resolvedBack.status === "intentional-none"
            ? "This card is explicitly configured without a back."
            : isDoubleFacedIdentity(copy.card.identity) && resolvedBack.mode === "auto"
              ? "This double-faced card's provider-backed back face is unresolved; a generic Project back cannot replace it."
              : "No reproducible back artwork is available.",
        };
      }
      resolvedByCard.set(copy.card.id, resolved);
      if (resolved.libraryReference) {
        if (!backLibrary) throw new CardExportServiceError("BACK_ORIGINAL_UNAVAILABLE", "Back Library is unavailable for a referenced Project back.");
        const key = `${resolved.libraryReference.assetId}\0${resolved.libraryReference.sha256}`;
        let original = originalByBackHash.get(key);
        if (!original) {
          try { original = await backLibrary.resolveOriginal(resolved.libraryReference); }
          catch (error) {
            throw new CardExportServiceError("BACK_ORIGINAL_UNAVAILABLE", "The referenced Back Library original is missing or failed SHA-256 validation.", { cause: error });
          }
          if (!(original.bytes instanceof Uint8Array) || digest(original.bytes) !== resolved.libraryReference.sha256 || original.contentHash !== resolved.libraryReference.sha256) {
            throw new CardExportServiceError("BACK_ORIGINAL_UNAVAILABLE", "The referenced Back Library bytes do not match the Project SHA-256.");
          }
          if (original.format !== "jpeg" && original.format !== "png") {
            throw new CardExportServiceError("UNSUPPORTED_FORMAT", `Back Library ${original.format.toUpperCase()} is not supported by the PDF engine.`);
          }
          originalByBackHash.set(key, original);
        }
        const candidateId = `back:${resolved.libraryReference.sha256}`;
        directCandidates.set(candidateId, {
          id: candidateId,
          source: "custom",
          identityId: copy.card.identity?.id ?? null,
          faceId: "back",
          originalAvailable: true,
          widthPx: original.widthPx,
          heightPx: original.heightPx,
          metadata: { contentHash: resolved.libraryReference.sha256, backLibrary: true },
        });
        directOriginals.set(candidateId, original);
        resolvedByCard.set(copy.card.id, { ...resolved, selection: {
          candidateId,
          source: "custom",
          identityId: copy.card.identity?.id ?? null,
          faceId: "back",
        } });
        resolved = resolvedByCard.get(copy.card.id)!;
      }
    }
    if (resolved.selection) physicalBackSelections.set(copy.physicalCardIndex, resolved.selection);
    if (resolved.missingReason) {
      const item = {
        cardId: copy.card.id,
        cardName: backName(copy.card),
        physicalCardIndex: copy.physicalCardIndex,
        copyNumber: copy.copyNumber,
        backMode: resolved.mode,
        reason: resolved.missingReason,
      } satisfies BackExportPreflightItem;
      missing.push(item);
      if (missingBackPolicy === "warn-and-continue" || missingBackPolicy === "use-project-default") warnings.push(item);
    }
    if (resolved.mode === "auto") backCounts.auto += 1;
    else if (resolved.mode === "project-default") backCounts.projectDefault += 1;
    else if (resolved.mode === "manual") backCounts.manual += 1;
    else backCounts.noneOrMissing += 1;
  }
  const preflight: BackExportPreflight = { ...commonPreflight, backs: backCounts, missing, warnings };
  if (missingBackPolicy === "block" && missing.length) {
    const identities = missing.map(({ cardName, copyNumber }) => `${cardName} copy ${copyNumber}`).join(", ");
    throw new CardExportServiceError("BACK_REQUIRED", `Backs are required for: ${identities}.`, { cause: preflight });
  }

  const memoCatalog = memoizedArtworkCatalog(catalog, directCandidates, directOriginals);
  const backCards: WorkingCard[] = physical.map((copy) => {
    const selection = physicalBackSelections.get(copy.physicalCardIndex);
    return {
      ...copy.card,
      quantity: 1,
      order: copy.physicalCardIndex,
      selectedArtworkByFace: selection ? { front: selection } : {},
    };
  });
  const blankIndexes = new Set(missing.map(({ physicalCardIndex }) => physicalCardIndex));
  const backPlacements = pairingPlan.pagePairs.map(({ backPlacement }) => backPlacement);
  const duplexBackPageTransform = pairingPlan.pagePairs[0]!.backPageTransform;
  const renderOptions: CardExportOptions = {
    ...optionsForSide(options, "back"),
    pagePlacements: backPlacements,
    duplexBackPageTransform,
    skipImageIndexes: blankIndexes,
  };

  try {
    if (contentMode === "back-only") {
      const back = await exportWorkingCardsWithDiagnostics(memoCatalog, backCards, renderOptions, signal);
      return {
        contentMode, pdfBytes: back.pdfBytes, bleedDiagnostics: back.bleedDiagnostics, pagePairingPlan: pairingPlan, preflight,
        ...(calibrationDiagnostic(options, ["back"]) ? { calibration: calibrationDiagnostic(options, ["back"]) } : {}),
        ...(back.calibrationBoundsWarnings.length ? { calibrationBoundsWarnings: back.calibrationBoundsWarnings } : {}),
      };
    }
    const front = await exportWorkingCardsWithDiagnostics(memoCatalog, cards, { ...optionsForSide(options, "front"), pagePlacements: pages }, signal);
    const back = await exportWorkingCardsWithDiagnostics(memoCatalog, backCards, renderOptions, signal);
    const calibration = calibrationDiagnostic(options, ["front", "back"]);
    const calibrationBoundsWarnings = [...front.calibrationBoundsWarnings, ...back.calibrationBoundsWarnings].slice(0, MAX_CALIBRATION_BOUNDS_WARNINGS);
    if (contentMode === "front-back-separated") {
      const effectiveCardOrientation = options.cardOrientation
        ?? ((options.cardFormat ?? MAGIC_STANDARD_CARD).widthMm > (options.cardFormat ?? MAGIC_STANDARD_CARD).heightMm ? "landscape" : "portrait");
      const manifest = separateManifest(pairingPlan, front.pdfBytes, back.pdfBytes, options.projectRevision ?? null, effectiveCardOrientation, calibration, calibrationBoundsWarnings);
      return { contentMode, frontPdfBytes: front.pdfBytes, backPdfBytes: back.pdfBytes, bleedDiagnostics: [...front.bleedDiagnostics, ...back.bleedDiagnostics], manifest, pagePairingPlan: pairingPlan, preflight, ...(calibration ? { calibration } : {}), ...(calibrationBoundsWarnings.length ? { calibrationBoundsWarnings } : {}) };
    }
    const pdfBytes = await interleavePdfPages(front.pdfBytes, back.pdfBytes, pairingPlan);
    return {
      contentMode,
      pdfBytes,
      bleedDiagnostics: [...front.bleedDiagnostics, ...back.bleedDiagnostics],
      pagePairingPlan: pairingPlan,
      pageOrder: pairingPlan.pagePairs.flatMap(({ frontPageNumber, backPageNumber }) => [`front:${frontPageNumber}`, `back:${backPageNumber}`]),
      preflight,
      ...(calibration ? { calibration } : {}),
      ...(calibrationBoundsWarnings.length ? { calibrationBoundsWarnings } : {}),
    };
  } catch (error) {
    if (error instanceof CardExportServiceError) throw error;
    if (error instanceof BackLibraryError) throw new CardExportServiceError("BACK_ORIGINAL_UNAVAILABLE", error.message, { cause: error });
    if (error instanceof Error && /original|artwork candidate/i.test(error.message)) {
      throw new CardExportServiceError("BACK_ORIGINAL_UNAVAILABLE", "A back artwork original could not be loaded for PDF export.", { cause: error });
    }
    throw error;
  }
}
