import { ImportFailureError } from "../../errors";
import type { UrlAdapter } from "../types";
import { DEFAULT_MAX_URL_RESPONSE_BYTES, fetchUrlPayload, sanitizeUrlForReport } from "../transport";
import { decodeTextPayload, parseDeckExport, safeDownloadFilename } from "./deck-export";

function deckPath(url: URL): { readonly set: string; readonly slug: string; readonly isDownload: boolean } | undefined {
  const match = /^\/deck\/([a-z0-9]{2,8})\/([a-z0-9]+(?:-[a-z0-9]+)*)(\/download)?\/?$/i.exec(url.pathname);
  return match ? { set: match[1], slug: match[2], isDownload: Boolean(match[3]) } : undefined;
}

export const mtgWtfUrlAdapter: UrlAdapter = Object.freeze<UrlAdapter>({
  id: "mtg-wtf",
  hosts: ["mtg.wtf", "www.mtg.wtf"],
  matches(url) {
    return url.protocol === "https:" && deckPath(url) !== undefined;
  },
  async import(url, context) {
    const deck = deckPath(url);
    if (!deck) throw new ImportFailureError("mtg.wtf URL must point to a public /deck/{set}/{slug} page.", "URL_UNSUPPORTED", context.sourceId);
    const downloadUrl = deck.isDownload
      ? new URL(url.href)
      : new URL(`/deck/${encodeURIComponent(deck.set)}/${encodeURIComponent(deck.slug)}/download`, url.origin);
    const payload = await fetchUrlPayload(downloadUrl, {
      ...context,
      maxResponseBytes: context.maxResponseBytes ?? DEFAULT_MAX_URL_RESPONSE_BYTES,
    });
    if (payload.mediaType !== "text/plain") {
      throw new ImportFailureError("mtg.wtf download did not return the expected plain-text deck export.", "URL_ADAPTER_PAYLOAD", context.sourceId);
    }
    const text = decodeTextPayload(payload);
    if (/^\s*</.test(text) || /^\s*<!doctype\s+html/i.test(text)) {
      throw new ImportFailureError("mtg.wtf returned an HTML page instead of its deck export.", "URL_ADAPTER_PAYLOAD", context.sourceId);
    }
    const cleanText = text.split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join("\n");
    const fallbackFilename = `${deck.set}-${deck.slug}.txt`;
    const filename = safeDownloadFilename(payload.response.headers.get("content-disposition"), fallbackFilename);
    const sourceId = context.sourceId ?? `url:${encodeURIComponent(url.href)}`;
    const parsed = parseDeckExport(payload, {
      sourceId,
      sourceUrl: url.href,
      adapterId: "mtg-wtf",
      importer: "simple-decklist",
      filename,
      text: cleanText,
    });
    return {
      kind: "entries",
      entries: parsed.entries,
      warnings: parsed.warnings,
      sourceUrl: sanitizeUrlForReport(url.href),
      metadata: Object.freeze({
        adapterId: "mtg-wtf",
        importer: "simple-decklist",
        responseMediaType: parsed.mediaType,
        responseBytes: parsed.responseBytes,
        sha256: parsed.sha256,
        downloadedUrl: sanitizeUrlForReport(parsed.finalUrl),
        sourceFilename: parsed.filename,
      }),
    };
  },
});
