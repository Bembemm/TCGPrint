import { ImportFailureError } from "../../errors";
import type { UrlAdapter } from "../types";
import { DEFAULT_MAX_URL_RESPONSE_BYTES, fetchUrlPayload, sanitizeUrlForReport } from "../transport";
import { normalizedJsonSource, optionalText, parseJsonPayload, positiveQuantity, record, textValue, type NormalizedUrlCard } from "./json-export";

const MAX_CARDS = 100_000;

function deckIdFromPath(url: URL): string | undefined {
  const match = /^\/decks\/(\d{1,12})\/?$/.exec(url.pathname);
  return match?.[1];
}

function normalizeDeck(data: unknown, sourceId?: string): { readonly cards: readonly NormalizedUrlCard[]; readonly name?: string } {
  const root = record(data);
  if (!root || !Array.isArray(root.cards) || root.cards.length > MAX_CARDS) {
    throw new ImportFailureError("Archidekt API schema changed: expected a bounded cards array.", "URL_ADAPTER_PAYLOAD", sourceId);
  }
  const name = optionalText(root, "name", sourceId);
  const cards = root.cards.map((item, index): NormalizedUrlCard => {
    const row = record(item);
    const card = record(row?.card);
    const oracle = record(card?.oracleCard);
    const cardName = textValue(oracle?.name);
    if (!row || !card || !oracle || !cardName) {
      throw new ImportFailureError(`Archidekt API card ${index + 1} has no oracle card name.`, "URL_ADAPTER_PAYLOAD", sourceId);
    }
    const quantity = positiveQuantity(row.quantity, sourceId);
    const categories = row.categories;
    if (categories !== undefined && (!Array.isArray(categories) || categories.some((category) => typeof category !== "string"))) {
      throw new ImportFailureError(`Archidekt API card ${index + 1} has invalid categories.`, "URL_ADAPTER_PAYLOAD", sourceId);
    }
    const edition = record(card.edition);
    const set = edition ? optionalText(edition, "editioncode", sourceId) : undefined;
    const collectorNumber = optionalText(card, "collectorNumber", sourceId);
    const section = Array.isArray(categories)
      ? categories.map((category) => (category as string).trim()).filter(Boolean).join(", ") || undefined
      : undefined;
    return {
      name: cardName,
      quantity,
      ...(set ? { set } : {}),
      ...(collectorNumber ? { collectorNumber } : {}),
      ...(section ? { section } : {}),
    };
  });
  return { cards, ...(name ? { name } : {}) };
}

export const archidektUrlAdapter: UrlAdapter = Object.freeze<UrlAdapter>({
  id: "archidekt",
  hosts: ["archidekt.com", "www.archidekt.com"],
  matches(url) {
    return url.protocol === "https:" && deckIdFromPath(url) !== undefined;
  },
  async import(url, context) {
    const id = deckIdFromPath(url);
    if (!id) throw new ImportFailureError("Archidekt URL must point to a public /decks/{numeric-id} page.", "URL_UNSUPPORTED", context.sourceId);
    const apiUrl = new URL(`/api/decks/${id}/`, "https://archidekt.com");
    const payload = await fetchUrlPayload(apiUrl, {
      ...context,
      maxResponseBytes: context.maxResponseBytes ?? DEFAULT_MAX_URL_RESPONSE_BYTES,
    });
    const normalized = normalizeDeck(parseJsonPayload(payload, "Archidekt", context.sourceId), context.sourceId);
    return normalizedJsonSource({
      payload,
      sourceUrl: url.href,
      adapterId: "archidekt",
      filename: `archidekt-${id}.json`,
      cards: normalized.cards,
      metadata: Object.freeze({ deckName: normalized.name, apiUrl: sanitizeUrlForReport(apiUrl.href) }),
    });
  },
});
