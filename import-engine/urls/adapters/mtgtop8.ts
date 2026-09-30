import { ImportFailureError } from "../../errors";
import type { UrlAdapter } from "../types";
import { DEFAULT_MAX_URL_RESPONSE_BYTES, DEFAULT_URL_TIMEOUT_MS, fetchUrlPayload, sanitizeUrlForReport } from "../transport";
import { decodeTextPayload, parseDeckExport, safeDownloadFilename } from "./deck-export";

function deckId(value: string | null): string | undefined {
  return value && /^\d{1,12}$/.test(value) ? value : undefined;
}

function formatName(value: string | null): string | undefined {
  return value && /^[a-z0-9_-]{1,100}$/i.test(value) ? value : undefined;
}

function isSupportedUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const id = deckId(url.searchParams.get("d"));
  if (!id) return false;
  if (url.pathname === "/event") return true;
  return url.pathname === "/dec" && formatName(url.searchParams.get("f")) !== undefined;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([\da-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)));
}

function exportUrlFromPage(html: string, pageUrl: URL): URL | undefined {
  const expectedId = deckId(pageUrl.searchParams.get("d"));
  if (!expectedId) return undefined;
  const links = html.match(/<a\b[^>]*>/gi) ?? [];
  const exports: URL[] = [];
  for (const link of links) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(link);
    const raw = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!raw) continue;
    let target: URL;
    try { target = new URL(decodeHtmlAttribute(raw), pageUrl); }
    catch { continue; }
    if (target.protocol !== "https:" || !["mtgtop8.com", "www.mtgtop8.com"].includes(target.hostname) || target.pathname !== "/dec") continue;
    if (deckId(target.searchParams.get("d")) !== expectedId || !formatName(target.searchParams.get("f"))) continue;
    exports.push(target);
  }
  const unique = [...new Map(exports.map((url) => [url.href, url])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

export const mtgTop8UrlAdapter: UrlAdapter = Object.freeze<UrlAdapter>({
  id: "mtgtop8",
  hosts: ["mtgtop8.com", "www.mtgtop8.com"],
  matches: (url) => isSupportedUrl(url),
  async import(url, context) {
    const id = deckId(url.searchParams.get("d"));
    if (!id || !isSupportedUrl(url)) {
      throw new ImportFailureError("MTGTop8 URL must be an event page or explicit .mwDeck export URL.", "URL_UNSUPPORTED", context.sourceId);
    }

    const deadline = Date.now() + (context.timeoutMs ?? DEFAULT_URL_TIMEOUT_MS);
    const boundedContext = (maxResponseBytes: number) => {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw new ImportFailureError("MTGTop8 import exceeded its total request timeout.", "URL_TIMEOUT", context.sourceId);
      return { ...context, timeoutMs, maxResponseBytes };
    };

    let exportUrl: URL;
    if (url.pathname === "/dec") exportUrl = new URL(url.href);
    else {
      const page = await fetchUrlPayload(url, boundedContext(Math.min(context.maxResponseBytes ?? 5 * 1024 * 1024, 5 * 1024 * 1024)));
      if (page.mediaType !== "text/html") {
        throw new ImportFailureError("MTGTop8 event page did not return HTML containing an export link.", "URL_ADAPTER_PAYLOAD", context.sourceId);
      }
      const html = decodeTextPayload(page);
      const finalPageUrl = new URL(page.finalUrl);
      if (!["mtgtop8.com", "www.mtgtop8.com"].includes(finalPageUrl.hostname) || deckId(finalPageUrl.searchParams.get("d")) !== id) {
        throw new ImportFailureError("MTGTop8 redirected to an unexpected deck page.", "URL_ADAPTER_PAYLOAD", context.sourceId);
      }
      const found = exportUrlFromPage(html, finalPageUrl);
      if (!found) {
        throw new ImportFailureError("MTGTop8 event page no longer exposes one unambiguous .mwDeck download link for this deck.", "URL_ADAPTER_PAYLOAD", context.sourceId);
      }
      exportUrl = found;
    }

    const payload = await fetchUrlPayload(exportUrl, boundedContext(context.maxResponseBytes ?? DEFAULT_MAX_URL_RESPONSE_BYTES));
    if (payload.mediaType !== "text/plain") {
      throw new ImportFailureError("MTGTop8 export did not return the expected .mwDeck plain-text file.", "URL_ADAPTER_PAYLOAD", context.sourceId);
    }
    const text = decodeTextPayload(payload);
    if (/^\s*</.test(text) || !/(?:Deck file created with mtgtop8\.com|Deck file for Magic Workstation|Magic Workstation|^\s*\d+\s+\[[a-z0-9]{2,8}\])/im.test(text)) {
      throw new ImportFailureError("MTGTop8 response is not a recognizable Magic Workstation deck export.", "URL_ADAPTER_PAYLOAD", context.sourceId);
    }
    const filename = safeDownloadFilename(payload.response.headers.get("content-disposition"), `mtgtop8-${id}.mwDeck`);
    const sourceId = context.sourceId ?? `url:${encodeURIComponent(url.href)}`;
    const parsed = parseDeckExport(payload, {
      sourceId,
      sourceUrl: url.href,
      adapterId: "mtgtop8",
      importer: "mwdeck-like",
      filename,
      text,
    });
    return {
      kind: "entries",
      entries: parsed.entries,
      warnings: parsed.warnings,
      sourceUrl: sanitizeUrlForReport(url.href),
      metadata: Object.freeze({
        adapterId: "mtgtop8",
        importer: "mwdeck-like",
        responseMediaType: parsed.mediaType,
        responseBytes: parsed.responseBytes,
        sha256: parsed.sha256,
        downloadedUrl: sanitizeUrlForReport(parsed.finalUrl),
        sourceFilename: parsed.filename,
      }),
    };
  },
});
