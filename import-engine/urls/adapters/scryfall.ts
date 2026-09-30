import { ImportFailureError } from "../../errors";
import type { ImportedEntry } from "../../types";
import type { UrlAdapter } from "../types";
import { sanitizeUrlForReport } from "../transport";

function cardPath(url: URL): { readonly setCode: string; readonly collectorNumber: string; readonly slug?: string } | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "card" || (parts.length !== 3 && parts.length !== 4)) return undefined;
  let setCode: string;
  let collectorNumber: string;
  let slug: string | undefined;
  try {
    setCode = decodeURIComponent(parts[1]);
    collectorNumber = decodeURIComponent(parts[2]);
    slug = parts[3] ? decodeURIComponent(parts[3]) : undefined;
  } catch {
    return undefined;
  }
  if (!/^[a-z0-9]{1,8}$/i.test(setCode) || !/^[a-z0-9*]+$/i.test(collectorNumber)) return undefined;
  if (slug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug)) return undefined;
  return { setCode, collectorNumber, ...(slug ? { slug } : {}) };
}

export const scryfallUrlAdapter: UrlAdapter = Object.freeze<UrlAdapter>({
  id: "scryfall",
  hosts: ["scryfall.com", "www.scryfall.com"],
  matches(url) {
    return url.protocol === "https:" && cardPath(url) !== undefined;
  },
  async import(url, context) {
    const card = cardPath(url);
    if (!card) throw new ImportFailureError("Scryfall URL must be a card URL with an explicit set code and collector number.", "URL_UNSUPPORTED", context.sourceId);
    const sourceId = context.sourceId ?? `url:${encodeURIComponent(url.href)}`;
    const nameSuggestion = card.slug?.split("-").map((word, index) => {
      const normalized = word.toLowerCase();
      return index > 0 && ["a", "an", "and", "for", "in", "of", "the", "to"].includes(normalized)
        ? normalized
        : `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
    }).join(" ");
    const entry: ImportedEntry = {
      id: `${sourceId}:scryfall-card`,
      kind: "deck-card",
      order: 0,
      quantity: 1,
      sourceId,
      cardHint: { setCode: card.setCode.toLowerCase(), collectorNumber: card.collectorNumber },
      ...(nameSuggestion ? { nameSuggestion } : {}),
      metadata: Object.freeze({ adapterId: "scryfall", source: "card-url" }),
    };
    return {
      kind: "entries",
      entries: [entry],
      sourceUrl: sanitizeUrlForReport(url.href),
      metadata: Object.freeze({ adapterId: "scryfall", referenceType: "card-url" }),
    };
  },
});
