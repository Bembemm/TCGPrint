import { parse } from "csv-parse/sync";
import { ImportFailureError } from "../errors";
import { resolveImportLimits } from "../limits";
import type { CsvImportMapping, ImportKind, ImportLimits, ImportMapping, ImportSource, ImportedEntry, ImportWarning } from "../types";
import type { ImporterOutput } from "./types";

type TargetField = keyof CsvImportMapping;
type ParsedRecord = { readonly record: string[]; readonly info: { readonly lines: number } };

const ALIASES: Readonly<Record<TargetField, readonly string[]>> = Object.freeze({
  name: ["name", "cardname"],
  quantity: ["quantity", "count", "qty", "copies"],
  setCode: ["set", "setcode"],
  collectorNumber: ["collectornumber", "collector", "number"],
  scryfallId: ["scryfallid"],
  imageUrl: ["imageurl", "image", "imageuri"],
  language: ["language", "lang"],
});

function normalizedHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function decodeText(source: ImportSource): string {
  if (source.originalText !== undefined) return source.originalText;
  if (!source.originalBytes) {
    throw new ImportFailureError("CSV/TSV import requires original text or bytes.", "UNSUPPORTED_INPUT", source.id, source.sourcePath);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes);
  } catch (error) {
    throw new ImportFailureError("CSV/TSV must be valid UTF-8.", "INVALID_CSV", source.id, source.sourcePath, { cause: error });
  }
}

function resolveColumns(headers: readonly string[], override?: CsvImportMapping): Partial<Record<TargetField, number>> {
  const resolved: Partial<Record<TargetField, number>> = {};
  for (const field of Object.keys(ALIASES) as TargetField[]) {
    const requested = override?.[field];
    if (typeof requested === "number") {
      if (!Number.isInteger(requested) || requested < 0 || requested >= headers.length) {
        throw new ImportFailureError(`CSV mapping for ${field} refers to missing column ${requested}.`, "MAPPING_INVALID");
      }
      resolved[field] = requested;
    } else if (typeof requested === "string") {
      const index = headers.indexOf(requested);
      if (index < 0) throw new ImportFailureError(`CSV mapping for ${field} refers to missing header "${requested}".`, "MAPPING_INVALID");
      resolved[field] = index;
    } else {
      const aliases = ALIASES[field];
      const index = headers.findIndex((header) => aliases.includes(normalizedHeader(header)));
      if (index >= 0) resolved[field] = index;
    }
  }
  return resolved;
}

function selectedValue(record: readonly string[], index: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  const value = record[index]?.trim();
  return value ? value : undefined;
}

export function parseCsvImport(
  source: ImportSource,
  mapping?: CsvImportMapping,
  delimiter?: "," | "\t",
  limitOverrides?: Partial<ImportLimits>,
): ImporterOutput {
  const limits = resolveImportLimits(limitOverrides);
  const text = decodeText(source).replace(/^\uFEFF/, "");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > limits.maxCsvBytes) {
    throw new ImportFailureError(`CSV/TSV is ${byteLength} bytes; the configured limit is ${limits.maxCsvBytes}.`, "INPUT_TOO_LARGE", source.id, source.sourcePath);
  }
  const selectedDelimiter = delimiter ?? (source.filename?.toLowerCase().endsWith(".tsv") ? "\t" : ",");

  let records: ParsedRecord[];
  try {
    records = parse(text, {
      bom: true,
      delimiter: selectedDelimiter,
      columns: false,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: limits.maxCsvBytes,
      info: true,
    }) as unknown as ParsedRecord[];
  } catch (error) {
    throw new ImportFailureError(
      `CSV/TSV parser rejected the input. ${error instanceof Error ? error.message : "Invalid records."}`,
      "INVALID_CSV",
      source.id,
      source.sourcePath,
      { cause: error },
    );
  }

  const headerRecord = records.shift();
  if (!headerRecord?.record.length) {
    return { entries: [], warnings: [{ code: "MISSING_HEADER", message: "CSV/TSV has no header row.", sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath }] };
  }
  const headers = headerRecord.record.map((header) => header.trim());
  const columns = resolveColumns(headers, mapping);
  const mappedIndexes = new Set(Object.values(columns).filter((value): value is number => value !== undefined));
  const mappingFields: Record<string, string | number | undefined> = {};
  for (const field of Object.keys(ALIASES) as TargetField[]) {
    const index = columns[field];
    if (index !== undefined) mappingFields[field] = headers[index];
  }
  const importMapping: ImportMapping = {
    sourceId: source.id,
    format: selectedDelimiter === "\t" ? "tsv" : "csv",
    fields: Object.freeze(mappingFields),
    unknownFields: headers.filter((_, index) => !mappedIndexes.has(index)),
  };

  const entries: ImportedEntry[] = [];
  const warnings: ImportWarning[] = [];
  if (columns.name === undefined) {
    warnings.push({ code: "MISSING_NAME_COLUMN", message: "No card name column was recognized; rows are retained only in mapping metadata.", sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath });
  }
  if (records.length > limits.maxCsvRows) {
    throw new ImportFailureError(`CSV/TSV exceeds the ${limits.maxCsvRows} row limit.`, "INPUT_TOO_LARGE", source.id, source.sourcePath);
  }

  records.forEach(({ record, info }, index) => {
    const line = info.lines || index + 2;
    if (record.length !== headers.length) {
      warnings.push({ code: "ROW_WIDTH_MISMATCH", message: `Row has ${record.length} columns; expected ${headers.length}.`, sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath, line });
      return;
    }
    const name = selectedValue(record, columns.name);
    if (!name) {
      warnings.push({ code: "MISSING_NAME", message: "CSV/TSV row has no mapped card name and was not emitted as an entry.", sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath, line });
      return;
    }
    const rawQuantity = selectedValue(record, columns.quantity);
    const quantity = rawQuantity === undefined ? 1 : Number(rawQuantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      warnings.push({ code: "INVALID_QUANTITY", message: `Quantity "${rawQuantity}" is not a positive safe integer; row was skipped.`, sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath, line, field: "quantity" });
      return;
    }
    const rawRecord = Object.fromEntries(headers.map((header, column) => [header, record[column] ?? ""]));
    entries.push({
      id: `${source.id}:row:${index + 2}`,
      kind: "deck-card",
      order: source.order + entries.length,
      quantity,
      sourceId: source.id,
      sourceFilename: source.filename,
      sourcePath: source.sourcePath,
      cardHint: {
        name,
        ...(selectedValue(record, columns.setCode) ? { setCode: selectedValue(record, columns.setCode) } : {}),
        ...(selectedValue(record, columns.collectorNumber) ? { collectorNumber: selectedValue(record, columns.collectorNumber) } : {}),
        ...(selectedValue(record, columns.scryfallId) ? { scryfallId: selectedValue(record, columns.scryfallId) } : {}),
        ...(selectedValue(record, columns.imageUrl) ? { imageUrl: selectedValue(record, columns.imageUrl) } : {}),
        ...(selectedValue(record, columns.language) ? { language: selectedValue(record, columns.language) } : {}),
      },
      metadata: Object.freeze({ rawRecord: Object.freeze(rawRecord), row: index + 2 }),
    });
  });

  return { entries, warnings, mappings: [importMapping] };
}
