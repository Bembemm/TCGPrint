import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { ImportCancelledError, ImportFailureError } from "../errors";
import type { UrlAdapterContext } from "./types";

export const DEFAULT_URL_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_URL_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface UrlPayload {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly finalUrl: string;
  readonly response: Response;
}

export function sanitizeUrlForReport(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:password|passwd|token|secret|signature|^sig$|auth|api[_-]?key|access[_-]?key|credential|session|bearer)/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.href;
  } catch {
    return "[invalid URL]";
  }
}

function urlFailure(code: ConstructorParameters<typeof ImportFailureError>[1], message: string, cause?: unknown): ImportFailureError {
  return new ImportFailureError(message, code, undefined, undefined, cause instanceof Error ? { cause } : undefined);
}

function ipv4Public(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && c === 0) || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Groups(address: string): number[] | undefined {
  const normalized = address.toLowerCase().split("%", 1)[0];
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (!half) return [];
    const values: number[] = [];
    for (const piece of half.split(":")) {
      if (piece.includes(".")) {
        if (isIP(piece) !== 4) return undefined;
        const bytes = piece.split(".").map(Number);
        values.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else {
        if (!/^[\da-f]{1,4}$/.test(piece)) return undefined;
        values.push(Number.parseInt(piece, 16));
      }
    }
    return values;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (halves.length === 2 && missing < 1) return undefined;
  return [...left, ...Array(Math.max(0, missing)).fill(0), ...right];
}

function ipPublic(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return ipv4Public(address);
  if (version !== 6) return false;
  const groups = ipv6Groups(address);
  if (!groups) return false;
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return ipv4Public(mapped);
  }
  const first = groups[0];
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && groups[1] === 0x0db8) return false;
  if (first === 0x2001 && groups[1] <= 0x01ff) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  return true;
}

function normalizedHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

async function assertPublicHost(url: URL, resolver: UrlAdapterContext["resolveHost"], signal: AbortSignal, isRedirect: boolean): Promise<readonly string[]> {
  const blockedCode = isRedirect ? "URL_REDIRECT_BLOCKED" : "URL_HOST_BLOCKED";
  const hostname = normalizedHost(url);
  if (!hostname || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw urlFailure(blockedCode, "URL points to a local or reserved host, which is blocked.");
  }
  if (isIP(hostname)) {
    if (!ipPublic(hostname)) throw urlFailure(blockedCode, "URL points to a private or reserved IP address, which is blocked.");
    return [hostname];
  }

  let addresses: readonly string[];
  try {
    addresses = resolver
      ? await resolver(hostname)
      : (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
  } catch (error) {
    if (signal.aborted) throw error;
    throw urlFailure("URL_HTTP_ERROR", "The remote host could not be resolved.", error);
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (addresses.length === 0 || addresses.some((address) => !ipPublic(address))) {
    throw urlFailure(blockedCode, "URL resolves to a private or reserved IP address, which is blocked.");
  }
  return addresses;
}

function fetchPinned(url: URL, init: RequestInit, vettedAddresses: readonly string[]): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const addresses = vettedAddresses.map((address) => ({ address, family: isIP(address) }));
    const lookupPinned: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    const requestOptions = {
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      lookup: lookupPinned,
    };
    const receive = (incoming: import("node:http").IncomingMessage) => {
      const status = incoming.statusCode ?? 502;
      if (status === 101) {
        incoming.destroy();
        request.destroy(new Error("Remote server attempted an unsupported protocol upgrade."));
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, statusText: incoming.statusMessage, headers }));
    };
    const request = url.protocol === "https:"
      ? httpsRequest(url, requestOptions, receive)
      : httpRequest(url, requestOptions, receive);
    const abort = () => request.destroy(new DOMException("Aborted", "AbortError"));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => init.signal?.removeEventListener("abort", abort));
    request.end();
  });
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function validateRequestUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw urlFailure("URL_REDIRECT_BLOCKED", "Remote redirects must use HTTP or HTTPS.");
  }
  if (!url.hostname || url.username || url.password) {
    throw urlFailure("URL_REDIRECT_BLOCKED", "Remote URL contains an invalid host or embedded credentials.");
  }
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* the response is discarded regardless */ }
}

async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximum) {
    await discard(response);
    throw urlFailure("URL_RESPONSE_LIMIT", `Remote response exceeds the ${maximum}-byte limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await withSignal(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw urlFailure("URL_RESPONSE_LIMIT", `Remote response exceeds the ${maximum}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchUrlPayload(value: string | URL, context: UrlAdapterContext = {}): Promise<UrlPayload> {
  const timeoutMs = context.timeoutMs ?? DEFAULT_URL_TIMEOUT_MS;
  const maxResponseBytes = context.maxResponseBytes ?? DEFAULT_MAX_URL_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new RangeError("URL timeout and response byte limits must be positive safe integers.");
  }
  const initial = value instanceof URL ? new URL(value.href) : (() => {
    try { return new URL(value); }
    catch (error) { throw urlFailure("URL_INVALID", "The supplied URL is invalid.", error); }
  })();
  validateRequestUrl(initial);
  if (context.signal?.aborted) throw new ImportCancelledError(context.sourceId);

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abortFromCaller = () => controller.abort();
  context.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let current = initial;
  let isRedirect = false;

  try {
    for (let redirects = 0; ; redirects += 1) {
      const vettedAddresses = await withSignal(assertPublicHost(current, context.resolveHost, controller.signal, isRedirect), controller.signal);
      let response: Response;
      try {
        const requestOptions: RequestInit = {
          method: "GET",
          headers: {
            accept: "text/html, application/xhtml+xml, image/*, text/plain, text/csv, text/tab-separated-values, application/json, application/xml, text/xml, application/zip, application/octet-stream;q=0.9",
            "user-agent": "TCGPrint/0.1.0 (+https://github.com/Bembemm/TCGPrint)",
          },
          redirect: "manual",
          signal: controller.signal,
        };
        response = await withSignal(
          context.fetchImpl
            ? context.fetchImpl(current, requestOptions)
            : fetchPinned(current, requestOptions, vettedAddresses),
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw urlFailure("URL_HTTP_ERROR", "The remote server could not be reached.", error);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= MAX_REDIRECTS) {
          await discard(response);
          throw urlFailure("URL_REDIRECT_BLOCKED", `Remote response exceeded the ${MAX_REDIRECTS}-redirect limit.`);
        }
        const location = response.headers.get("location");
        await discard(response);
        if (!location) throw urlFailure("URL_HTTP_ERROR", "Remote server returned a redirect without a location.");
        try { current = new URL(location, current); }
        catch (error) { throw urlFailure("URL_REDIRECT_BLOCKED", "Remote server returned an invalid redirect target.", error); }
        validateRequestUrl(current);
        isRedirect = true;
        continue;
      }

      if (!response.ok) {
        await discard(response);
        throw urlFailure("URL_HTTP_ERROR", `Remote server returned HTTP ${response.status}.`);
      }

      const bytes = await readBounded(response, maxResponseBytes, controller.signal);
      const mediaType = (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
      return { bytes, mediaType, finalUrl: current.href, response };
    }
  } catch (error) {
    if (error instanceof ImportFailureError || error instanceof ImportCancelledError) throw error;
    if (context.signal?.aborted) throw new ImportCancelledError(context.sourceId);
    if (timedOut) throw urlFailure("URL_TIMEOUT", `Remote request exceeded the ${timeoutMs} ms timeout.`, error);
    if (controller.signal.aborted) throw urlFailure("URL_TIMEOUT", `Remote request exceeded the ${timeoutMs} ms timeout.`, error);
    throw urlFailure("URL_HTTP_ERROR", "The remote response could not be read.", error);
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener("abort", abortFromCaller);
  }
}
