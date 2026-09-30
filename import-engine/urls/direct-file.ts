import { createHash } from "node:crypto";
import { ImportFailureError } from "../errors";
import { detectImport } from "../detection";
import type { ImportCandidate, ImportKind } from "../types";
import type { UrlAdapterContext, UrlAdapterResult } from "./types";
import { DEFAULT_MAX_URL_RESPONSE_BYTES, DEFAULT_URL_TIMEOUT_MS, fetchUrlPayload, sanitizeUrlForReport } from "./transport";

const SUPPORTED_MEDIA_TYPES = new Set([
  "application/json",
  "application/octet-stream",
  "application/csv",
  "application/xml",
  "application/zip",
  "application/x-zip-compressed",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
  "text/csv",
  "text/plain",
  "text/tab-separated-values",
  "text/xml",
]);

function expectedKind(mediaType: string): ImportKind | undefined {
  if (mediaType === "application/json") return "json";
  if (mediaType === "application/xml" || mediaType === "text/xml") return "generic-xml";
  if (mediaType === "application/zip" || mediaType === "application/x-zip-compressed") return "zip";
  if (mediaType === "image/svg+xml") return "svg";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "text/csv" || mediaType === "application/csv") return "csv";
  if (mediaType === "text/tab-separated-values") return "tsv";
  return undefined;
}

function mimeMatchesCandidate(mediaType: string, candidate: ImportCandidate): boolean {
  const expected = expectedKind(mediaType);
  if (!expected) return mediaType === "text/plain"
    ? ["simple-decklist", "arena-like", "mtgo-like", "xmage-like", "mwdeck-like", "csv", "tsv", "json", "generic-xml", "mpc-autofill-xml"].includes(candidate.kind)
    : mediaType === "application/octet-stream";
  if (expected === "generic-xml") return ["generic-xml", "mpc-autofill-xml", "svg"].includes(candidate.kind);
  if (expected === "image") {
    if (candidate.kind !== "image") return false;
    const expectedFormat = mediaType.slice("image/".length).replace("jpeg", "jpeg");
    return expectedFormat === "svg+xml" || candidate.originalFormat === expectedFormat;
  }
  return candidate.kind === expected;
}

function filenameFromUrl(url: URL): string | undefined {
  const segment = url.pathname.split("/").filter(Boolean).at(-1);
  if (!segment) return undefined;
  try { return decodeURIComponent(segment); }
  catch { return segment; }
}

function dispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1]?.trim();
  if (extended) {
    try { return decodeURIComponent(extended.replace(/^"|"$/g, "")); }
    catch { /* use the regular filename when extended encoding is malformed */ }
  }
  const regular = /filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(header);
  return regular?.[1] ?? regular?.[2];
}

function safeFilename(candidate: string | undefined): string {
  const basename = candidate?.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
  return basename && basename !== "." && basename !== ".." ? basename : "download";
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 8192)).replace(/^\uFEFF/, "").trimStart();
  return /^<!doctype\s+html\b/i.test(prefix) || /^<html(?:\s|>)/i.test(prefix);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}

export async function importDirectFileUrl(value: string | URL, context: UrlAdapterContext = {}): Promise<UrlAdapterResult> {
  const payload = await fetchUrlPayload(value, {
    ...context,
    timeoutMs: context.timeoutMs ?? DEFAULT_URL_TIMEOUT_MS,
    maxResponseBytes: context.maxResponseBytes ?? DEFAULT_MAX_URL_RESPONSE_BYTES,
  });
  if (payload.mediaType === "text/html" || payload.mediaType === "application/xhtml+xml" || looksLikeHtml(payload.bytes)) {
    throw new ImportFailureError("The URL returned an HTML page. HTML scraping is not supported; provide a direct import file URL.", "URL_CONTENT_TYPE", context.sourceId);
  }
  if (!SUPPORTED_MEDIA_TYPES.has(payload.mediaType)) {
    throw new ImportFailureError(`The URL returned unsupported Content-Type ${payload.mediaType || "(missing)"}.`, "URL_CONTENT_TYPE", context.sourceId);
  }

  const filename = safeFilename(dispositionFilename(payload.response.headers.get("content-disposition")) ?? filenameFromUrl(new URL(payload.finalUrl)));
  const detection = detectImport({ bytes: payload.bytes, fileName: filename, mediaType: payload.mediaType });
  const candidate = detection.selected ?? detection.candidates.find((item) => item.kind !== "unknown");
  if (!candidate) {
    throw new ImportFailureError("The URL response does not contain a supported image, deck text, CSV, JSON, XML, or ZIP file.", "URL_CONTENT_TYPE", context.sourceId);
  }
  const mismatch = !mimeMatchesCandidate(payload.mediaType, candidate);
  return {
    kind: "source",
    filename,
    mediaType: payload.mediaType,
    bytes: payload.bytes,
    sourceUrl: sanitizeUrlForReport(payload.finalUrl),
    metadata: Object.freeze({
      requestedUrl: sanitizeUrlForReport(value instanceof URL ? value.href : value),
      responseMediaType: payload.mediaType,
      responseBytes: payload.bytes.byteLength,
      sha256: hashBytes(payload.bytes),
      ...(mismatch ? { contentTypeMismatch: true } : {}),
    }),
  };
}
