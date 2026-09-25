import { ScryfallError } from "./errors";
import { mapScryfallCard, mapScryfallCardList } from "./mapper";
import { sharedScryfallRateLimiter, ScryfallRateLimiter } from "./rate-limiter";
import type { ScryfallCard, ScryfallDownloadedAsset, ScryfallLookupMode, ScryfallPrintingPage } from "./types";

const API_BASE_URL = "https://api.scryfall.com";
const DEFAULT_USER_AGENT = "TCGPrint/0.1.0 (https://github.com/tcgprint; card-workbench)";
const JSON_RESPONSE_LIMIT = 8 * 1024 * 1024;

function officialScryfallHost(hostname: string): boolean {
  return ["scryfall.com", "scryfall.io"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export interface ScryfallRequestOptions {
  readonly signal?: AbortSignal;
}

export interface ScryfallClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly minIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly maxAssetBytes?: number;
  readonly rateLimiter?: ScryfallRateLimiter;
}

export interface DownloadAssetOptions extends ScryfallRequestOptions {
  readonly kind: "thumbnail" | "original";
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel();
    throw new ScryfallError("asset-too-large", `Scryfall response exceeds the ${maximumBytes} byte limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new ScryfallError("asset-too-large", `Scryfall response exceeds the ${maximumBytes} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isImageBytes(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return true;
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return true;
  }
  return false;
}

function abortKind(signal?: AbortSignal): ScryfallError {
  return new ScryfallError(signal?.aborted ? "aborted" : "timeout", signal?.aborted ? "The Scryfall request was cancelled." : "The Scryfall request timed out.");
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
}

export class ScryfallClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: URL;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxAssetBytes: number;
  private readonly rateLimiter: ScryfallRateLimiter;
  private readonly jsonLimit: number;

  constructor(options: ScryfallClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    try { this.baseUrl = new URL(options.baseUrl ?? API_BASE_URL); } catch (error) {
      throw new ScryfallError("unsafe-url", "Scryfall API base URL is invalid.", { cause: error });
    }
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
    this.maxAssetBytes = Math.max(1, options.maxAssetBytes ?? 30 * 1024 * 1024);
    this.jsonLimit = JSON_RESPONSE_LIMIT;
    this.rateLimiter = options.rateLimiter ?? (options.minIntervalMs === undefined
      ? sharedScryfallRateLimiter
      : new ScryfallRateLimiter({ minIntervalMs: options.minIntervalMs }));
  }

  async autocomplete(query: string, options: ScryfallRequestOptions = {}): Promise<readonly string[]> {
    const url = this.apiUrl("/cards/autocomplete");
    url.searchParams.set("q", query);
    const payload = await this.getJson(url, options.signal);
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data) || !(payload as { data: unknown[] }).data.every((item) => typeof item === "string")) {
      throw new ScryfallError("invalid-payload", "Scryfall autocomplete response is invalid.");
    }
    return (payload as { data: string[] }).data;
  }

  async lookupById(scryfallId: string, options: ScryfallRequestOptions = {}): Promise<ScryfallCard> {
    return mapScryfallCard(await this.getJson(this.apiUrl(`/cards/${encodeURIComponent(scryfallId)}`), options.signal));
  }

  async lookupBySetCollector(setCode: string, collectorNumber: string, language?: string, options: ScryfallRequestOptions = {}): Promise<ScryfallCard> {
    const parts = [setCode, collectorNumber, ...(language ? [language] : [])].map(encodeURIComponent);
    return mapScryfallCard(await this.getJson(this.apiUrl(`/cards/${parts.join("/")}`), options.signal));
  }

  async lookupByName(name: string, mode: ScryfallLookupMode = "fuzzy", options: ScryfallRequestOptions = {}): Promise<ScryfallCard> {
    const url = this.apiUrl("/cards/named");
    url.searchParams.set(mode, name);
    return mapScryfallCard(await this.getJson(url, options.signal));
  }

  async searchCards(query: string, options: ScryfallRequestOptions = {}): Promise<readonly ScryfallCard[]> {
    const url = this.apiUrl("/cards/search");
    url.searchParams.set("q", query);
    const payload = await this.getJson(url, options.signal);
    return mapScryfallCardList(payload);
  }

  async listPrintings(oracleId: string, options: ScryfallRequestOptions = {}): Promise<readonly ScryfallCard[]> {
    const url = this.apiUrl("/cards/search");
    url.searchParams.set("q", `oracleid:${oracleId}`);
    url.searchParams.set("unique", "prints");
    url.searchParams.set("order", "released");
    const cards: ScryfallCard[] = [];
    let pageUrl: URL | undefined = url;
    let pageCount = 0;
    while (pageUrl && pageCount < 100) {
      const page = await this.getPrintingPage(pageUrl, options.signal);
      cards.push(...page.cards);
      pageUrl = page.hasMore && page.nextPage ? this.validateApiUrl(page.nextPage) : undefined;
      pageCount += 1;
    }
    if (pageUrl) throw new ScryfallError("invalid-payload", "Scryfall returned too many printing pages.");
    return cards;
  }

  async downloadAsset(uri: string, options: DownloadAssetOptions): Promise<ScryfallDownloadedAsset> {
    const url = this.validateAssetUrl(uri);
    const { response, bytes } = await this.request(url, "image/*", options.signal, this.maxAssetBytes);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream";
    if (contentType === "text/html" || contentType === "application/xhtml+xml") throw new ScryfallError("invalid-content-type", "Scryfall artwork endpoint returned HTML instead of an image.");
    if (!isImageBytes(bytes)) throw new ScryfallError("invalid-image", "Scryfall artwork bytes do not have a supported image signature.");
    return { bytes, contentType, sourceUrl: url.href, kind: options.kind };
  }

  private apiUrl(path: string): URL {
    return new URL(path.replace(/^\//, ""), this.baseUrl.href.endsWith("/") ? this.baseUrl : `${this.baseUrl.href}/`);
  }

  private validateApiUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch (error) { throw new ScryfallError("unsafe-url", "Scryfall pagination URL is invalid.", { cause: error }); }
    if (url.protocol !== "https:" || url.hostname !== "api.scryfall.com" || url.username || url.password) throw new ScryfallError("unsafe-url", "Scryfall pagination URL is not an official HTTPS endpoint.");
    return url;
  }

  private validateAssetUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch (error) { throw new ScryfallError("unsafe-url", "Scryfall artwork URL is invalid.", { cause: error }); }
    if (url.protocol !== "https:" || !officialScryfallHost(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) {
      throw new ScryfallError("unsafe-url", "Artwork downloads must use an official Scryfall HTTPS host.");
    }
    return url;
  }

  private async getPrintingPage(url: URL, signal?: AbortSignal): Promise<ScryfallPrintingPage> {
    const payload = await this.getJson(url, signal);
    if (!payload || typeof payload !== "object") throw new ScryfallError("invalid-payload", "Scryfall printing page is invalid.");
    const page = payload as { data?: unknown; has_more?: unknown; next_page?: unknown };
    if (typeof page.has_more !== "boolean" || (page.next_page !== undefined && typeof page.next_page !== "string")) throw new ScryfallError("invalid-payload", "Scryfall printing pagination fields are invalid.");
    return {
      cards: mapScryfallCardList(payload),
      hasMore: page.has_more,
      ...(page.next_page ? { nextPage: page.next_page } : {}),
    };
  }

  private async getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    const { bytes } = await this.request(url, "application/json", signal, this.jsonLimit);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) {
      throw new ScryfallError("invalid-json", "Scryfall returned invalid JSON.", { cause: error });
    }
    return parsed;
  }

  private async request(url: URL, accept: string, signal: AbortSignal | undefined, maximumBytes: number): Promise<{ response: Response; bytes: Uint8Array }> {
    if (signal?.aborted) throw new ScryfallError("aborted", "The Scryfall request was cancelled.");
    return this.rateLimiter.run(async () => {
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: { "User-Agent": this.userAgent, Accept: accept },
          signal: controller.signal,
        });
        if (response.status === 404) throw new ScryfallError("not-found", "Scryfall did not find the requested card.", { status: 404 });
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
          this.rateLimiter.defer(retryAfterMs);
          throw new ScryfallError("rate-limited", "Scryfall rate limited the request.", { status: 429, retryAfterMs });
        }
        if (response.status >= 500) throw new ScryfallError("server", `Scryfall returned HTTP ${response.status}.`, { status: response.status });
        if (!response.ok) throw new ScryfallError("http", `Scryfall returned HTTP ${response.status}.`, { status: response.status });
        const bytes = await readBounded(response, maximumBytes);
        return { response, bytes };
      } catch (error) {
        if (error instanceof ScryfallError) throw error;
        if (timedOut || controller.signal.aborted) throw abortKind(signal);
        throw new ScryfallError("network", "Scryfall request failed before a response was received.", { cause: error });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }, signal);
  }
}
