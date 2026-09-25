import { ImportFailureError } from "../errors";
import { resolveImportLimits } from "../limits";
import type { ImportKind, ImportLimits, ImportMapping, ImportSource, ImportedEntry, ImportWarning, JsonImportMapping } from "../types";
import type { ImporterOutput } from "./types";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type TargetField = Exclude<keyof JsonImportMapping, "collectionPath">;

const FIELD_ALIASES: Readonly<Record<TargetField, readonly string[]>> = Object.freeze({
  name: ["name", "card_name", "cardname"],
  quantity: ["quantity", "count", "qty", "copies"],
  setCode: ["set", "set_code", "setcode"],
  collectorNumber: ["collector_number", "collectornumber", "collector"],
  scryfallId: ["scryfall_id", "scryfallid"],
  imageUrl: ["image_url", "image", "image_uri"],
  language: ["language", "lang"],
  section: ["section", "board", "zone"],
});

function decodeText(source: ImportSource): string {
  if (source.originalText !== undefined) return source.originalText;
  if (!source.originalBytes) {
    throw new ImportFailureError("JSON import requires original text or bytes.", "UNSUPPORTED_INPUT", source.id, source.sourcePath);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes);
  } catch (error) {
    throw new ImportFailureError("JSON must be valid UTF-8.", "INVALID_JSON", source.id, source.sourcePath, { cause: error });
  }
}

function checkJsonBounds(value: JsonValue, limits: ImportLimits, source: ImportSource): void {
  const pending: Array<{ readonly value: JsonValue; readonly depth: number }> = [{ value, depth: 1 }];
  let nodeCount = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodeCount += 1;
    if (nodeCount > limits.maxJsonNodes) {
      throw new ImportFailureError(`JSON exceeds the ${limits.maxJsonNodes} node limit.`, "INVALID_JSON", source.id, source.sourcePath);
    }
    if (current.depth > limits.maxJsonDepth) {
      throw new ImportFailureError(`JSON exceeds the depth limit of ${limits.maxJsonDepth}.`, "INVALID_JSON", source.id, source.sourcePath);
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function pathValues(root: JsonValue, path: string): JsonValue[] {
  if (!path.trim()) return [];
  let current: JsonValue[] = [root];
  for (const rawPart of path.split(".")) {
    if (!rawPart) return [];
    const expands = rawPart.endsWith("[]");
    const key = expands ? rawPart.slice(0, -2) : rawPart;
    const next: JsonValue[] = [];
    for (const value of current) {
      if (!key) {
        if (expands && Array.isArray(value)) next.push(...value);
        continue;
      }
      if (!isRecord(value)) continue;
      const child = value[key];
      if (child === undefined) continue;
      if (expands) {
        if (Array.isArray(child)) next.push(...child);
      } else next.push(child);
    }
    current = next;
  }
  return current;
}

function findAlias(record: Record<string, JsonValue>, aliases: readonly string[]): string | undefined {
  const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedAliases = new Set(aliases.map(normalize));
  return Object.keys(record).find((key) => normalizedAliases.has(normalize(key)));
}

function usableText(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function inferredCollection(value: JsonValue): { readonly path: string; readonly rows: readonly JsonValue[] } | undefined {
  if (Array.isArray(value)) return { path: "[]", rows: value };
  if (!isRecord(value)) return undefined;
  for (const key of ["cards", "deck", "items", "entries"]) {
    if (Array.isArray(value[key])) return { path: key, rows: value[key] as JsonValue[] };
  }
  return undefined;
}

function pathInsideCollection(path: string, collectionPath: string): string {
  const prefix = collectionPath.endsWith("[]") ? collectionPath : `${collectionPath}[]`;
  if (path.startsWith(`${prefix}.`)) return path.slice(prefix.length + 1);
  if (path === prefix) return "";
  return path;
}

export function parseJsonImport(
  source: ImportSource,
  mapping?: JsonImportMapping,
  limitOverrides?: Partial<ImportLimits>,
): ImporterOutput {
  const limits = resolveImportLimits(limitOverrides);
  const text = decodeText(source).replace(/^\uFEFF/, "");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > limits.maxJsonBytes) {
    throw new ImportFailureError(`JSON is ${byteLength} bytes; the configured limit is ${limits.maxJsonBytes}.`, "INPUT_TOO_LARGE", source.id, source.sourcePath);
  }
  let root: JsonValue;
  try {
    root = JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new ImportFailureError(`JSON is malformed. ${error instanceof Error ? error.message : "Parser error."}`, "INVALID_JSON", source.id, source.sourcePath, { cause: error });
  }
  checkJsonBounds(root, limits, source);

  const mappedArrayPath = Object.values(mapping ?? {}).find((path): path is string => typeof path === "string" && path.includes("[]"));
  const requestedCollectionPath = mapping?.collectionPath
    ?? (mappedArrayPath ? `${mappedArrayPath.split("[]")[0]}[]` : undefined);
  let collectionPath = requestedCollectionPath
    ? requestedCollectionPath === "[]" || requestedCollectionPath.endsWith("[]")
      ? requestedCollectionPath
      : `${requestedCollectionPath}[]`
    : undefined;
  let rows: readonly JsonValue[] = [];
  if (collectionPath) {
    const resolved = pathValues(root, collectionPath);
    rows = resolved;
  } else {
    const inferred = inferredCollection(root);
    if (inferred) {
      collectionPath = inferred.path === "[]" ? "[]" : `${inferred.path}[]`;
      rows = inferred.rows;
    }
  }

  const warnings: ImportWarning[] = [];
  if (!collectionPath) {
    return {
      entries: [],
      warnings: [{ code: "NO_CARD_COLLECTION", message: "JSON structure has no recognized card array; supply a collection and field mapping.", sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath }],
      mappings: [{ sourceId: source.id, format: "json", fields: Object.freeze({}), unknownFields: [] }],
    };
  }
  if (rows.length > limits.maxCsvRows) {
    throw new ImportFailureError(`JSON collection exceeds the ${limits.maxCsvRows} row limit.`, "INPUT_TOO_LARGE", source.id, source.sourcePath);
  }

  const explicitPaths: Partial<Record<TargetField, string>> = {};
  for (const field of Object.keys(FIELD_ALIASES) as TargetField[]) {
    const value = mapping?.[field];
    if (value !== undefined) explicitPaths[field] = pathInsideCollection(value, collectionPath);
  }
  const mappingFields: Record<string, string | number | undefined> = {};
  for (const field of Object.keys(explicitPaths) as TargetField[]) {
    const configured = mapping?.[field];
    const path = explicitPaths[field];
    if (path !== undefined) mappingFields[field] = configured ?? path;
  }
  const entries: ImportedEntry[] = [];
  const mappedRootKeys = new Set(Object.values(FIELD_ALIASES).flat().map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const unknownFields = new Set<string>();

  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      warnings.push({ code: "INVALID_CARD_ROW", message: "JSON card collection item is not an object and was skipped.", sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath, line: index + 1 });
      return;
    }
    for (const key of Object.keys(row)) if (!mappedRootKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) unknownFields.add(key);

    const valueFor = (field: TargetField): JsonValue | undefined => {
      const explicit = explicitPaths[field];
      if (explicit !== undefined) return explicit ? pathValues(row, explicit)[0] : row;
      const key = findAlias(row, FIELD_ALIASES[field]);
      return key ? row[key] : undefined;
    };
    const name = usableText(valueFor("name"));
    if (!name) {
      warnings.push({ code: "MISSING_NAME", message: "JSON card row has no mapped card name and was not emitted as an entry.", sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath, line: index + 1 });
      return;
    }
    const rawQuantity = usableText(valueFor("quantity"));
    const quantity = rawQuantity === undefined ? 1 : Number(rawQuantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      warnings.push({ code: "INVALID_QUANTITY", message: `Quantity "${rawQuantity}" is not a positive safe integer; row was skipped.`, sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath, line: index + 1, field: "quantity" });
      return;
    }
    const cardHint: NonNullable<ImportedEntry["cardHint"]> = {
      name,
      ...(usableText(valueFor("setCode")) ? { setCode: usableText(valueFor("setCode")) } : {}),
      ...(usableText(valueFor("collectorNumber")) ? { collectorNumber: usableText(valueFor("collectorNumber")) } : {}),
      ...(usableText(valueFor("scryfallId")) ? { scryfallId: usableText(valueFor("scryfallId")) } : {}),
      ...(usableText(valueFor("imageUrl")) ? { imageUrl: usableText(valueFor("imageUrl")) } : {}),
      ...(usableText(valueFor("language")) ? { language: usableText(valueFor("language")) } : {}),
      ...(usableText(valueFor("section")) ? { section: usableText(valueFor("section")) } : {}),
    };
    entries.push({
      id: `${source.id}:json:${index + 1}`,
      kind: "deck-card",
      order: source.order + entries.length,
      quantity,
      sourceId: source.id,
      sourceFilename: source.filename,
      sourcePath: source.sourcePath,
      cardHint,
      section: cardHint.section,
      metadata: Object.freeze({ rawRecord: row, row: index + 1 }),
    });
  });

  const mappings: ImportMapping[] = [{
    sourceId: source.id,
    format: "json",
    fields: Object.freeze(mappingFields),
    unknownFields: [...unknownFields],
  }];
  return { entries, warnings, mappings };
}
