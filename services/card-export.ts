import { createHash } from "node:crypto";
import {
  BLEED_ALGORITHM_VERSION,
  BleedEngine,
  BleedGenerationError,
  createBleedCacheKey,
  resolveBleedSourcePolicy,
  resolveSmartBorderFillConfig,
  SMART_BORDER_FILL_CONFIG,
  type BleedModePreference,
  type BleedDerivativeResult,
  type BleedResult,
  type SmartBorderFillConfigOverrides,
} from "../image-engine/bleed";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS, type CutGuideConfig } from "../core/geometry";
import { LosslessPdfEngine, PdfExportError } from "../pdf-engine/document";
import type { ArtworkCandidate, WorkingCard } from "../core/cards/types";
import type { CardWorkbench } from "./card-workbench";

export interface CardExportOptions {
  readonly bleedMm: number;
  readonly cutGuides: "full" | "none";
  readonly bleedMode?: BleedModePreference;
  readonly smartBorderFillConfig?: SmartBorderFillConfigOverrides;
}

export interface CardExportBleedDiagnostic {
  readonly workingCardId: string;
  readonly identityId: string | null;
  readonly cardName: string;
  readonly source: ArtworkCandidate["source"];
  readonly requestedMode: BleedModePreference;
  readonly resolvedMode: "smart-border-fill" | "subtle-edge-stretch";
  readonly effectiveMode: BleedResult["effectiveMode"];
  readonly algorithmVersion: typeof BLEED_ALGORITHM_VERSION;
  readonly smartBorderFillConfigVersion: string;
  readonly policyId: string;
  readonly policyNotice?: string;
  readonly bleedMm: number;
  readonly trimSizeMm: BleedResult["trimSizeMm"];
  readonly sideDiagnostics: BleedDerivativeResult["sideDiagnostics"];
  readonly previewSha256: string;
}

export interface CardExportResult {
  readonly pdfBytes: Uint8Array;
  readonly bleedDiagnostics: readonly CardExportBleedDiagnostic[];
}

export class CardExportServiceError extends Error {
  constructor(readonly code: "ARTWORK_REQUIRED" | "ARTWORK_ORIGINAL_UNAVAILABLE" | "UNSUPPORTED_FORMAT" | "INVALID_BLEED" | "EXPORT_FAILED" | "EXPORT_TOO_LARGE", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CardExportServiceError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}

function guides(mode: CardExportOptions["cutGuides"]): CutGuideConfig {
  const style = { color: "#000000", strokeWidthMm: 0.2, opacity: 1, lineStyle: "solid" as const };
  return mode === "none" ? { mode: "none", style } : { mode: "full", style };
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
  const bleedMode = options.bleedMode ?? "auto";
  if (bleedMode !== "auto" && bleedMode !== "smart-border-fill" && bleedMode !== "subtle-edge-stretch") {
    throw new CardExportServiceError("INVALID_BLEED", "Bleed mode must be auto, smart-border-fill, or subtle-edge-stretch.");
  }
  const total = cards.reduce((sum, card) => sum + card.quantity, 0);
  if (total < 1) throw new CardExportServiceError("ARTWORK_REQUIRED", "Add at least one card to export.");
  if (total > 500) throw new CardExportServiceError("EXPORT_TOO_LARGE", "The first export is limited to 500 physical cards per PDF.");

  const uniqueImages = new Map<string, Uint8Array>();
  const uniqueBleeds = new Map<string, BleedResult>();
  const composedImages: Uint8Array[] = [];
  const composedBleeds: Array<BleedResult | undefined> = [];
  const bleedDiagnostics: CardExportBleedDiagnostic[] = [];
  const smartBorderFillConfig = resolveSmartBorderFillConfig(options.smartBorderFillConfig ?? SMART_BORDER_FILL_CONFIG);
  const bleedEngine = new BleedEngine({ smartBorderFillConfig });
  const pdfEngine = new LosslessPdfEngine();

  for (const card of [...cards].sort((a, b) => a.order - b.order)) {
    if (signal?.aborted) throw new CardExportServiceError("EXPORT_FAILED", "PDF export was cancelled.");
    const selection = card.selectedArtworkByFace.front;
    if (!selection) throw new CardExportServiceError("ARTWORK_REQUIRED", `${card.identity?.name ?? card.identityHints.name ?? "Custom card"} needs a selected front artwork.`);
    const candidate = await catalog.getArtworkCandidate(selection.candidateId);
    if (!candidate || candidate.source !== selection.source || !candidate.originalAvailable) {
      throw new CardExportServiceError("ARTWORK_ORIGINAL_UNAVAILABLE", "The selected artwork has no locally available, validated original. MPC references need local bytes before PDF export.");
    }
    const original = await catalog.getArtworkOriginal(candidate.id, signal);
    if (!(original.bytes instanceof Uint8Array) || original.bytes.byteLength !== original.byteLength) {
      throw new CardExportServiceError("ARTWORK_ORIGINAL_UNAVAILABLE", "The selected original failed local byte validation.");
    }
    if (!["jpeg", "png", "svg"].includes(original.format)) {
      throw new CardExportServiceError("UNSUPPORTED_FORMAT", `The PDF engine does not currently support ${original.format.toUpperCase()} artwork.`);
    }
    const hash = original.contentHash || digest(original.bytes);
    let image = uniqueImages.get(hash);
    if (!image) {
      image = original.bytes;
      uniqueImages.set(hash, image);
    }
    let bleed: BleedResult | undefined;
    if (options.bleedMm > 0) {
      if (original.format === "svg") throw new CardExportServiceError("UNSUPPORTED_FORMAT", "SVG artwork stays vector at zero bleed; the current BleedEngine does not generate SVG bleed.");
      const policy = resolveBleedSourcePolicy({ source: candidate.source, format: original.format, override: bleedMode, metadata: candidate.metadata });
      const trimSizeMm = { widthMm: MAGIC_STANDARD_CARD.widthMm, heightMm: MAGIC_STANDARD_CARD.heightMm };
      const sourceStrip = { mode: "auto" as const };
      const key = createBleedCacheKey({
        originalSha256: hash,
        bleedMm: options.bleedMm,
        mode: policy.mode,
        policyId: policy.policyId,
        sourceStrip,
        trimWidthMm: trimSizeMm.widthMm,
        trimHeightMm: trimSizeMm.heightMm,
        smartBorderFillConfig,
      });
      bleed = uniqueBleeds.get(key);
      if (!bleed) {
        try {
          bleed = await bleedEngine.generate({
            imageBytes: image,
            bleedMm: options.bleedMm,
            trimSizeMm,
            sourceStrip,
            mode: policy.mode,
            policyId: policy.policyId,
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
        smartBorderFillConfigVersion: smartBorderFillConfig.version,
        policyId: policy.policyId,
        ...(policy.notice ? { policyNotice: policy.notice } : {}),
        bleedMm: options.bleedMm,
        trimSizeMm: bleed.trimSizeMm,
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
      cutGuides: guides(options.cutGuides),
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
