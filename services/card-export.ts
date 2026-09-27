import { createHash } from "node:crypto";
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
import { MAGIC_STANDARD_CARD, PAPER_FORMATS, type CutGuideConfig } from "../core/geometry";
import { LosslessPdfEngine, PdfExportError } from "../pdf-engine/document";
import { mpcArtworkCandidateId } from "../core/cards/ids";
import type { ArtworkCandidate, CardFaceSide, SelectedArtwork, WorkingCard, WorkingCardMpcReference } from "../core/cards/types";
import type { CardWorkbench } from "./card-workbench";

export interface CardExportOptions {
  readonly bleedMm: number;
  readonly cutGuides: CutGuideConfig;
  readonly roundedCorners?: boolean;
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
}

export class CardExportServiceError extends Error {
  constructor(readonly code: "ARTWORK_REQUIRED" | "ARTWORK_ORIGINAL_UNAVAILABLE" | "UNSUPPORTED_FORMAT" | "INVALID_BLEED" | "INVALID_ROUNDED_CORNERS" | "EXPORT_FAILED" | "EXPORT_TOO_LARGE", message: string, options?: ErrorOptions) {
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
  if (total > 500) throw new CardExportServiceError("EXPORT_TOO_LARGE", "The first export is limited to 500 physical cards per PDF.");

  const uniqueImages = new Map<string, Uint8Array>();
  const uniqueBleeds = new Map<string, BleedResult>();
  const composedImages: Uint8Array[] = [];
  const composedBleeds: Array<BleedResult | undefined> = [];
  const bleedDiagnostics: CardExportBleedDiagnostic[] = [];
  const bleedEngine = new BleedEngine();
  const pdfEngine = new LosslessPdfEngine();

  for (const card of [...cards].sort((a, b) => a.order - b.order)) {
    if (signal?.aborted) throw new CardExportServiceError("EXPORT_FAILED", "PDF export was cancelled.");
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
      const trimSizeMm = { widthMm: MAGIC_STANDARD_CARD.widthMm, heightMm: MAGIC_STANDARD_CARD.heightMm };
      const cornerRadiusMm = MAGIC_STANDARD_CARD.cornerRadiusMm;
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
    for (let copy = 0; copy < card.quantity; copy += 1) {
      composedImages.push(image);
      composedBleeds.push(bleed);
    }
  }

  try {
    const pdfBytes = await pdfEngine.generate({
      images: composedImages,
      bleedResults: composedBleeds,
      cutGuides: options.cutGuides,
      paperFormat: PAPER_FORMATS.A4,
      cardFormat: MAGIC_STANDARD_CARD,
    });
    return { pdfBytes, bleedDiagnostics };
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
