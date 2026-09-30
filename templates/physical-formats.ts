import { MAGIC_STANDARD_CARD, PAPER_FORMATS, type CardFormat, type PaperFormat } from "../core/geometry";
import type { TemplateMetadata } from "./types";

const CARD_FORMATS: Readonly<Record<Exclude<TemplateMetadata["cardFormat"], "custom">, CardFormat>> = Object.freeze({
  standard: MAGIC_STANDARD_CARD,
  poker: Object.freeze({ id: "poker", name: "Poker", widthMm: 63.5, heightMm: 88.9, cornerRadiusMm: 3.175 }),
  bridge: Object.freeze({ id: "bridge", name: "Bridge", widthMm: 57, heightMm: 89 }),
  tarot: Object.freeze({ id: "tarot", name: "Tarot", widthMm: 70, heightMm: 120 }),
});

const PAPER_FORMATS_BY_ID: Readonly<Record<Exclude<TemplateMetadata["paper"], "custom">, PaperFormat>> = Object.freeze({
  a4: PAPER_FORMATS.A4,
  a3: PAPER_FORMATS.A3,
  letter: PAPER_FORMATS.LETTER,
  legal: PAPER_FORMATS.LEGAL,
  tabloid: PAPER_FORMATS.TABLOID,
});

/** Maps versioned template metadata to the existing physical placement engine formats. */
export function templatePhysicalFormats(metadata: TemplateMetadata): { readonly paper: PaperFormat; readonly card: CardFormat } {
  const paperBase = metadata.paper === "custom" ? undefined : PAPER_FORMATS_BY_ID[metadata.paper];
  const cardBase = metadata.cardFormat === "custom" ? undefined : CARD_FORMATS[metadata.cardFormat];
  if (!paperBase && !metadata.templateGeometry) throw new RangeError("A custom paper template requires explicit physical templateGeometry.");
  if (!cardBase && !metadata.templateGeometry) throw new RangeError("A custom card template requires explicit physical templateGeometry.");
  const geometry = metadata.templateGeometry;
  const page = geometry?.pageSizeMm ?? (paperBase
    ? metadata.orientation === "landscape"
      ? { widthMm: paperBase.heightMm, heightMm: paperBase.widthMm }
      : { widthMm: paperBase.widthMm, heightMm: paperBase.heightMm }
    : undefined);
  const card = geometry?.cardSizeMm ?? (cardBase ? { widthMm: cardBase.widthMm, heightMm: cardBase.heightMm } : undefined);
  if (!page || !card) throw new RangeError("Template paper and card formats need explicit physical millimeter dimensions.");
  if (paperBase) {
    const expected = metadata.orientation === "landscape"
      ? { widthMm: paperBase.heightMm, heightMm: paperBase.widthMm }
      : { widthMm: paperBase.widthMm, heightMm: paperBase.heightMm };
    if (page.widthMm !== expected.widthMm || page.heightMm !== expected.heightMm) {
      throw new RangeError("Template page dimensions do not match the selected named paper format and orientation.");
    }
  }
  if (cardBase && geometry) {
    const expectedCard = geometry.cardOrientation === "landscape"
      ? { widthMm: cardBase.heightMm, heightMm: cardBase.widthMm }
      : { widthMm: cardBase.widthMm, heightMm: cardBase.heightMm };
    if (card.widthMm !== expectedCard.widthMm || card.heightMm !== expectedCard.heightMm) {
      throw new RangeError("Template card dimensions do not match the selected named card format and template card orientation.");
    }
  }
  return {
    paper: Object.freeze({ name: paperBase?.name ?? "Custom template paper", widthMm: page.widthMm, heightMm: page.heightMm }),
    card: Object.freeze({ ...(cardBase ?? {}), id: cardBase?.id ?? "custom-template-card", name: cardBase?.name ?? "Custom template card", widthMm: card.widthMm, heightMm: card.heightMm }),
  };
}
