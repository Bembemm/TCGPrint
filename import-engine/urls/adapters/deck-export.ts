import { createHash } from "node:crypto";
import { ImportFailureError } from "../../errors";
import { parseTextImport } from "../../importers/text";
import type { ImportKind, ImportSource, ImportedEntry, ImportWarning } from "../../types";
import type { UrlPayload } from "../transport";
import { sanitizeUrlForReport } from "../transport";

export interface ParsedDeckExport {
  readonly filename: string;
  readonly entries: readonly ImportedEntry[];
  readonly warnings: readonly ImportWarning[];
  readonly responseBytes: number;
  readonly mediaType: string;
  readonly sha256: string;
  readonly finalUrl: string;
}

function declaredCharset(payload: UrlPayload): string | undefined {
  return /;\s*charset\s*=\s*"?([^;"\s]+)"?/i.exec(payload.response.headers.get("content-type") ?? "")?.[1];
}

export function decodeTextPayload(payload: UrlPayload): string {
  const encoding = declaredCharset(payload) ?? "utf-8";
  try { return new TextDecoder(encoding, { fatal: true }).decode(payload.bytes); }
  catch (error) {
    throw new ImportFailureError("Adapter download is not valid text in its declared charset.", "URL_ADAPTER_PAYLOAD", undefined, undefined, { cause: error });
  }
}

export function safeDownloadFilename(value: string | null, fallback: string): string {
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value ?? "")?.[1]?.trim();
  const regular = /filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(value ?? "");
  let selected = extended ?? regular?.[1] ?? regular?.[2] ?? fallback;
  try { selected = decodeURIComponent(selected.replace(/^"|"$/g, "")); }
  catch { /* invalid extended encoding falls back to the provided label */ }
  const basename = selected.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
  return basename && basename !== "." && basename !== ".." ? basename : fallback;
}

export function parseDeckExport(
  payload: UrlPayload,
  options: {
    readonly sourceId: string;
    readonly sourceUrl: string;
    readonly adapterId: string;
    readonly importer: Extract<ImportKind, "simple-decklist" | "mwdeck-like">;
    readonly filename: string;
    readonly text: string;
  },
): ParsedDeckExport {
  const cleanText = options.text;
  const bytes = new TextEncoder().encode(cleanText);
  const source: ImportSource = {
    id: options.sourceId,
    kind: "url",
    filename: options.filename,
    order: 0,
    originalFormat: options.importer,
    mediaType: payload.mediaType,
    sourceUrl: sanitizeUrlForReport(options.sourceUrl),
    adapterId: options.adapterId,
    sizeBytes: bytes.byteLength,
    originalBytes: bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    metadata: Object.freeze({ adapterId: options.adapterId, downloadedUrl: sanitizeUrlForReport(payload.finalUrl) }),
  };
  const output = parseTextImport(cleanText, options.importer, source);
  if (output.entries.length === 0) {
    throw new ImportFailureError("Adapter export contained no recognizable deck entries.", "URL_ADAPTER_PAYLOAD", options.sourceId);
  }
  return {
    filename: options.filename,
    entries: output.entries,
    warnings: output.warnings,
    responseBytes: payload.bytes.byteLength,
    mediaType: payload.mediaType,
    sha256: createHash("sha256").update(payload.bytes).digest("hex"),
    finalUrl: payload.finalUrl,
  };
}
