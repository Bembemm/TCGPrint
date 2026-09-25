import { ScryfallError } from "./errors";
import type { ScryfallCard, ScryfallFace, ScryfallImageUris, ScryfallRelatedCard } from "./types";

type JsonRecord = Record<string, unknown>;

function officialImageHost(hostname: string): boolean {
  return ["scryfall.com", "scryfall.io"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScryfallError("invalid-payload", `Scryfall ${label} must be an object.`);
  return value as JsonRecord;
}

function requiredString(source: JsonRecord, key: string, label = key): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) throw new ScryfallError("invalid-payload", `Scryfall card is missing ${label}.`);
  return value;
}

function optionalString(source: JsonRecord, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ScryfallError("invalid-payload", `Scryfall field ${key} must be a string.`);
  return value;
}

function optionalBoolean(source: JsonRecord, key: string): boolean | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ScryfallError("invalid-payload", `Scryfall field ${key} must be a boolean.`);
  return value;
}

function mapImageUris(value: unknown): ScryfallImageUris | undefined {
  if (value === undefined || value === null) return undefined;
  const image = record(value, "image_uris");
  const result: Record<string, string> = {};
  const keys: readonly [string, keyof ScryfallImageUris][] = [
    ["small", "small"], ["normal", "normal"], ["large", "large"], ["png", "png"], ["art_crop", "artCrop"], ["border_crop", "borderCrop"],
  ];
  for (const [sourceKey, targetKey] of keys) {
    const uri = optionalString(image, sourceKey);
    if (uri !== undefined) {
      let parsed: URL;
      try { parsed = new URL(uri); } catch { throw new ScryfallError("invalid-payload", `Scryfall image URI ${sourceKey} is invalid.`); }
      if (parsed.protocol !== "https:" || !officialImageHost(parsed.hostname)) {
        throw new ScryfallError("invalid-payload", `Scryfall image URI ${sourceKey} is not a secure Scryfall URL.`);
      }
      result[targetKey] = uri;
    }
  }
  return result as ScryfallImageUris;
}

function mapFace(value: unknown, index: number): ScryfallFace {
  const face = record(value, `card_faces[${index}]`);
  return {
    name: requiredString(face, "name", `card_faces[${index}].name`),
    ...(optionalString(face, "mana_cost") !== undefined ? { manaCost: optionalString(face, "mana_cost") } : {}),
    ...(optionalString(face, "type_line") !== undefined ? { typeLine: optionalString(face, "type_line") } : {}),
    ...(optionalString(face, "oracle_text") !== undefined ? { oracleText: optionalString(face, "oracle_text") } : {}),
    ...(face.image_uris !== undefined ? { imageUris: mapImageUris(face.image_uris) } : {}),
  };
}

function mapRelated(value: unknown): readonly ScryfallRelatedCard[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ScryfallError("invalid-payload", "Scryfall all_parts must be an array.");
  return value.map((item, index) => {
    const related = record(item, `all_parts[${index}]`);
    return {
      id: requiredString(related, "id"),
      component: requiredString(related, "component"),
      name: requiredString(related, "name"),
      ...(optionalString(related, "type_line") !== undefined ? { typeLine: optionalString(related, "type_line") } : {}),
    };
  });
}

function mapRelatedUris(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  const uris = record(value, "related_uris");
  const mapped: Record<string, string> = {};
  for (const [key, item] of Object.entries(uris)) {
    if (typeof item !== "string") throw new ScryfallError("invalid-payload", `Scryfall related_uris.${key} must be a string.`);
    let url: URL;
    try { url = new URL(item); } catch { throw new ScryfallError("invalid-payload", `Scryfall related_uris.${key} is invalid.`); }
    if (url.protocol !== "https:") throw new ScryfallError("invalid-payload", `Scryfall related_uris.${key} must use HTTPS.`);
    mapped[key] = item;
  }
  return mapped;
}

export function mapScryfallCard(value: unknown): ScryfallCard {
  const card = record(value, "card");
  const id = requiredString(card, "id");
  const name = requiredString(card, "name");
  const layout = requiredString(card, "layout");
  if (card.card_faces !== undefined && !Array.isArray(card.card_faces)) throw new ScryfallError("invalid-payload", "Scryfall card_faces must be an array.");
  const faces = Array.isArray(card.card_faces) ? card.card_faces.map(mapFace) : [];
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of ["cmc", "mana_cost", "type_line", "oracle_text", "rarity", "artist", "frame", "security_stamp"]) {
    const item = card[key];
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null) metadata[key] = item;
  }
  return {
    id,
    ...(optionalString(card, "oracle_id") ? { oracleId: optionalString(card, "oracle_id") } : {}),
    name,
    layout,
    ...(optionalString(card, "set") ? { setCode: optionalString(card, "set") } : {}),
    ...(optionalString(card, "collector_number") ? { collectorNumber: optionalString(card, "collector_number") } : {}),
    ...(optionalString(card, "lang") ? { lang: optionalString(card, "lang") } : {}),
    ...(optionalString(card, "released_at") ? { releasedAt: optionalString(card, "released_at") } : {}),
    ...(optionalBoolean(card, "digital") !== undefined ? { digital: optionalBoolean(card, "digital") } : {}),
    ...(optionalBoolean(card, "promo") !== undefined ? { promo: optionalBoolean(card, "promo") } : {}),
    ...(optionalBoolean(card, "full_art") !== undefined ? { fullArt: optionalBoolean(card, "full_art") } : {}),
    ...(optionalString(card, "border_color") ? { borderColor: optionalString(card, "border_color") } : {}),
    ...(optionalString(card, "image_status") ? { imageStatus: optionalString(card, "image_status") } : {}),
    ...(card.image_uris !== undefined ? { imageUris: mapImageUris(card.image_uris) } : {}),
    faces,
    ...(card.related_uris !== undefined ? { relatedUris: mapRelatedUris(card.related_uris) } : {}),
    relatedCards: mapRelated(card.all_parts),
    metadata,
  };
}

export function mapScryfallCardList(value: unknown): readonly ScryfallCard[] {
  const payload = record(value, "list");
  if (!Array.isArray(payload.data)) throw new ScryfallError("invalid-payload", "Scryfall list data must be an array.");
  return payload.data.map(mapScryfallCard);
}
