import { ImportFailureError } from "../../errors";
import type { UrlAdapter } from "../types";
import { DEFAULT_MAX_URL_RESPONSE_BYTES, fetchUrlPayload, sanitizeUrlForReport } from "../transport";
import { normalizedJsonSource, optionalText, parseJsonPayload, positiveQuantity, record, type NormalizedUrlCard } from "./json-export";

const MAX_CARDS = 100_000;
const BOARDS = [
  ["mainboard", "Mainboard"],
  ["maybeboard", "Maybeboard"],
  ["basics", "Basics"],
] as const;

function cubeIdFromPath(url: URL): string | undefined {
  const match = /^\/cube\/overview\/([a-z0-9_-]{2,80})\/?$/i.exec(url.pathname);
  return match?.[1];
}

function normalizeCube(data: unknown, sourceId?: string): { readonly cards: readonly NormalizedUrlCard[]; readonly name?: string } {
  const root = record(data);
  const cubeCards = record(root?.cards);
  if (!root || !cubeCards) {
    throw new ImportFailureError("CubeCobra API schema changed: expected a cards object.", "URL_ADAPTER_PAYLOAD", sourceId);
  }
  const name = optionalText(root, "name", sourceId);
  const normalized: NormalizedUrlCard[] = [];
  for (const [boardKey, section] of BOARDS) {
    const rawBoard = cubeCards[boardKey];
    if (rawBoard === undefined && boardKey !== "mainboard") continue;
    if (!Array.isArray(rawBoard)) {
      throw new ImportFailureError(`CubeCobra API board ${boardKey} must be an array.`, "URL_ADAPTER_PAYLOAD", sourceId);
    }
    for (let index = 0; index < rawBoard.length; index += 1) {
      const row = record(rawBoard[index]);
      const details = record(row?.details);
      const cardName = optionalText(details ?? {}, "name", sourceId);
      if (!row || !details || !cardName) {
        throw new ImportFailureError(`CubeCobra API ${boardKey} card ${index + 1} has no details.name.`, "URL_ADAPTER_PAYLOAD", sourceId);
      }
      const quantityValue = row.quantity ?? row.count ?? row.qty;
      const quantity = quantityValue === undefined ? 1 : positiveQuantity(quantityValue, sourceId);
      const set = optionalText(details, "set", sourceId);
      const collectorNumber = optionalText(details, "collector_number", sourceId);
      const scryfallId = optionalText(details, "scryfall_id", sourceId);
      normalized.push({
        name: cardName,
        quantity,
        ...(set ? { set } : {}),
        ...(collectorNumber ? { collectorNumber } : {}),
        ...(scryfallId ? { scryfallId } : {}),
        section,
      });
      if (normalized.length > MAX_CARDS) {
        throw new ImportFailureError("CubeCobra API exceeded the card count limit.", "URL_ADAPTER_PAYLOAD", sourceId);
      }
    }
  }
  return { cards: normalized, ...(name ? { name } : {}) };
}

export const cubeCobraUrlAdapter: UrlAdapter = Object.freeze<UrlAdapter>({
  id: "cubecobra",
  hosts: ["cubecobra.com", "www.cubecobra.com"],
  matches(url) {
    return url.protocol === "https:" && cubeIdFromPath(url) !== undefined;
  },
  async import(url, context) {
    const id = cubeIdFromPath(url);
    if (!id) throw new ImportFailureError("CubeCobra URL must point to /cube/overview/{cube-id}.", "URL_UNSUPPORTED", context.sourceId);
    const apiUrl = new URL(`/cube/api/cubeJSON/${encodeURIComponent(id)}`, "https://cubecobra.com");
    const payload = await fetchUrlPayload(apiUrl, {
      ...context,
      maxResponseBytes: context.maxResponseBytes ?? DEFAULT_MAX_URL_RESPONSE_BYTES,
    });
    const normalized = normalizeCube(parseJsonPayload(payload, "CubeCobra", context.sourceId), context.sourceId);
    if (normalized.cards.length === 0) {
      throw new ImportFailureError("CubeCobra API returned no cards in its supported boards.", "URL_ADAPTER_PAYLOAD", context.sourceId);
    }
    return normalizedJsonSource({
      payload,
      sourceUrl: url.href,
      adapterId: "cubecobra",
      filename: `cubecobra-${id}.json`,
      cards: normalized.cards,
      metadata: Object.freeze({ cubeName: normalized.name, apiUrl: sanitizeUrlForReport(apiUrl.href) }),
    });
  },
});
