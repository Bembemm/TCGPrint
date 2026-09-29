import type { CardIdentity } from "./types";

type IdentityMetadata = NonNullable<CardIdentity["metadata"]>;
type MetadataRecord = Record<string, unknown>;

const METADATA_SCALAR_FIELDS = ["layout", "digital", "promo", "fullArt", "imageStatus"] as const;
const METADATA_FIELDS = new Set<string>([...METADATA_SCALAR_FIELDS, "faces", "relatedCards"]);

function record(value: unknown): MetadataRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as MetadataRecord : undefined;
}

function plainRecord(value: unknown, label: string, allowedKeys: readonly string[], requiredKeys: readonly string[] = []): MetadataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const source = value as MetadataRecord;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      throw new TypeError(`${label} contains unsupported property ${String(key)}.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) throw new TypeError(`${label} is missing required property ${key}.`);
  }
  return source;
}

function safeString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

/** Applies the existing API boundary's lossy allowlist/truncation for identity metadata. */
export function sanitizeCardIdentityMetadata(value: unknown): IdentityMetadata | undefined {
  const source = record(value) ?? {};
  const metadata: MetadataRecord = {};
  for (const key of METADATA_SCALAR_FIELDS) {
    const item = source[key];
    if (typeof item === "string" || typeof item === "boolean") metadata[key] = item;
  }
  if (Array.isArray(source.faces)) {
    metadata.faces = source.faces.slice(0, 2).flatMap((face) => {
      const item = record(face);
      return item && typeof item.name === "string" ? [{ name: item.name.slice(0, 200) }] : [];
    });
  }
  if (Array.isArray(source.relatedCards)) {
    metadata.relatedCards = source.relatedCards.slice(0, 50).flatMap((related) => {
      const item = record(related);
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.component !== "string") return [];
      return [{
        id: item.id.slice(0, 80),
        name: item.name.slice(0, 200),
        component: item.component.slice(0, 40),
        ...(typeof item.typeLine === "string" ? { typeLine: item.typeLine.slice(0, 200) } : {}),
      }];
    });
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Strict, non-sanitizing validation for durable Project snapshots. */
export function validateCardIdentityMetadata(value: unknown): IdentityMetadata | undefined {
  if (value === undefined) return undefined;
  const source = plainRecord(value, "CardIdentity metadata", [...METADATA_FIELDS]);
  const metadata: MetadataRecord = {};
  for (const key of METADATA_SCALAR_FIELDS) {
    const item = source[key];
    if (item === undefined) continue;
    if (typeof item !== "string" && typeof item !== "boolean") {
      throw new TypeError(`CardIdentity metadata.${key} must be a string or boolean.`);
    }
    metadata[key] = item;
  }
  if (source.faces !== undefined) {
    if (!Array.isArray(source.faces) || source.faces.length > 2) {
      throw new TypeError("CardIdentity metadata.faces must contain at most 2 items.");
    }
    metadata.faces = source.faces.map((face, index) => {
      const faceRecord = plainRecord(face, `CardIdentity metadata.faces[${index}]`, ["name"], ["name"]);
      return { name: safeString(faceRecord.name, `CardIdentity metadata.faces[${index}].name`, 200) };
    });
  }
  if (source.relatedCards !== undefined) {
    if (!Array.isArray(source.relatedCards) || source.relatedCards.length > 50) {
      throw new TypeError("CardIdentity metadata.relatedCards must contain at most 50 items.");
    }
    metadata.relatedCards = source.relatedCards.map((related, index) => {
      const label = `CardIdentity metadata.relatedCards[${index}]`;
      const relatedRecord = plainRecord(related, label, ["id", "name", "component", "typeLine"], ["id", "name", "component"]);
      return {
        id: safeString(relatedRecord.id, `${label}.id`, 80),
        name: safeString(relatedRecord.name, `${label}.name`, 200),
        component: safeString(relatedRecord.component, `${label}.component`, 40),
        ...(relatedRecord.typeLine !== undefined ? { typeLine: safeString(relatedRecord.typeLine, `${label}.typeLine`, 200) } : {}),
      };
    });
  }
  return metadata;
}
