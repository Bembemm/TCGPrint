import { createHash } from "node:crypto";
import { ImportFailureError } from "../../errors";
import type { UrlAdapterResult } from "../types";
import type { UrlPayload } from "../transport";
import { sanitizeUrlForReport } from "../transport";

export interface NormalizedUrlCard {
  readonly name: string;
  readonly quantity: number;
  readonly set?: string;
  readonly collectorNumber?: string;
  readonly scryfallId?: string;
  readonly section?: string;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function optionalText(recordValue: Record<string, unknown>, key: string, sourceId?: string): string | undefined {
  const raw = recordValue[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = textValue(raw);
  if (!value) throw new ImportFailureError(`URL adapter payload has an invalid ${key} field.`, "URL_ADAPTER_PAYLOAD", sourceId);
  return value;
}

export function positiveQuantity(value: unknown, sourceId?: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ImportFailureError("URL adapter payload has a missing or invalid card quantity.", "URL_ADAPTER_PAYLOAD", sourceId);
  }
  return value;
}

export function parseJsonPayload(payload: UrlPayload, site: string, sourceId?: string): unknown {
  if (payload.mediaType !== "application/json" && !payload.mediaType.endsWith("+json")) {
    throw new ImportFailureError(`${site} API did not return JSON Content-Type.`, "URL_ADAPTER_PAYLOAD", sourceId);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(payload.bytes); }
  catch (error) { throw new ImportFailureError(`${site} API response is not valid UTF-8 JSON.`, "URL_ADAPTER_PAYLOAD", sourceId, undefined, { cause: error }); }
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new ImportFailureError(`${site} API returned malformed JSON.`, "URL_ADAPTER_PAYLOAD", sourceId, undefined, { cause: error }); }
}

export function normalizedJsonSource(options: {
  readonly payload: UrlPayload;
  readonly sourceUrl: string;
  readonly adapterId: string;
  readonly filename: string;
  readonly cards: readonly NormalizedUrlCard[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}): UrlAdapterResult {
  const bytes = new TextEncoder().encode(JSON.stringify({ cards: options.cards }));
  const sha256 = createHash("sha256").update(options.payload.bytes).digest("hex");
  return {
    kind: "source",
    filename: options.filename,
    mediaType: "application/json",
    bytes,
    sourceUrl: sanitizeUrlForReport(options.sourceUrl),
    metadata: Object.freeze({
      adapterId: options.adapterId,
      responseMediaType: options.payload.mediaType,
      responseBytes: options.payload.bytes.byteLength,
      sha256,
      downloadedUrl: sanitizeUrlForReport(options.payload.finalUrl),
      ...(options.metadata ?? {}),
    }),
  };
}
