import { createHash } from "node:crypto";
import { BleedEngine, BleedGenerationError, type BleedResult } from "../image-engine/bleed";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS, type CutGuideConfig } from "../core/geometry";
import { LosslessPdfEngine, PdfExportError } from "../pdf-engine/document";
import type { WorkingCard } from "../core/cards/types";
import type { CardWorkbench } from "./card-workbench";

export interface CardExportOptions {
  readonly bleedMm: number;
  readonly cutGuides: "full" | "none";
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
export async function exportWorkingCards(
  catalog: Pick<CardWorkbench, "getArtworkCandidate" | "getArtworkOriginal">,
  cards: readonly WorkingCard[],
  options: CardExportOptions,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isFinite(options.bleedMm) || options.bleedMm < 0 || options.bleedMm > 3) {
    throw new CardExportServiceError("INVALID_BLEED", "Bleed must be between 0 and 3 mm.");
  }
  const total = cards.reduce((sum, card) => sum + card.quantity, 0);
  if (total < 1) throw new CardExportServiceError("ARTWORK_REQUIRED", "Add at least one card to export.");
  if (total > 500) throw new CardExportServiceError("EXPORT_TOO_LARGE", "The first export is limited to 500 physical cards per PDF.");

  const uniqueImages = new Map<string, Uint8Array>();
  const uniqueBleeds = new Map<string, BleedResult>();
  const composedImages: Uint8Array[] = [];
  const composedBleeds: Array<BleedResult | undefined> = [];
  const bleedEngine = new BleedEngine();
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
      const key = `${hash}:${options.bleedMm}`;
      bleed = uniqueBleeds.get(key);
      if (!bleed) {
        try {
          bleed = await bleedEngine.generate({
            imageBytes: image,
            bleedMm: options.bleedMm,
            trimSizeMm: { widthMm: MAGIC_STANDARD_CARD.widthMm, heightMm: MAGIC_STANDARD_CARD.heightMm },
          });
          uniqueBleeds.set(key, bleed);
        } catch (error) {
          if (error instanceof BleedGenerationError) throw new CardExportServiceError("EXPORT_FAILED", error.message, { cause: error });
          throw error;
        }
      }
    }
    for (let copy = 0; copy < card.quantity; copy += 1) {
      composedImages.push(image);
      composedBleeds.push(bleed);
    }
  }

  try {
    return await pdfEngine.generate({
      images: composedImages,
      bleedResults: composedBleeds,
      cutGuides: guides(options.cutGuides),
      paperFormat: PAPER_FORMATS.A4,
      cardFormat: MAGIC_STANDARD_CARD,
    });
  } catch (error) {
    if (error instanceof PdfExportError) throw new CardExportServiceError("EXPORT_FAILED", error.message, { cause: error });
    throw error;
  }
}
