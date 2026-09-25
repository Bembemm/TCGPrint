import { describe, expect, it, vi } from "vitest";
import normal from "../../fixtures/scryfall/normal-card.json";
import { ScryfallClient } from "../../../providers/scryfall/client";
import { ScryfallRateLimiter } from "../../../providers/scryfall/rate-limiter";
import { ScryfallError } from "../../../providers/scryfall/errors";

function json(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}
function cardPage(data: unknown[], nextPage?: string) {
  return { object: "list", data, has_more: Boolean(nextPage), ...(nextPage ? { next_page: nextPage } : {}) };
}
function fakeClient(fetchImpl: typeof fetch, extra: ConstructorParameters<typeof ScryfallClient>[0] = {}) {
  return new ScryfallClient({ fetchImpl, minIntervalMs: 0, timeoutMs: 80, ...extra });
}

describe("ScryfallClient", () => {
  it("allows only the official HTTPS API host and an identifiable TCGPrint User-Agent", () => {
    expect(() => new ScryfallClient({ baseUrl: "http://api.scryfall.com" })).toThrow(ScryfallError);
    expect(() => new ScryfallClient({ baseUrl: "https://example.com" })).toThrow(ScryfallError);
    expect(() => new ScryfallClient({ userAgent: "OtherClient/1.0" })).toThrow(ScryfallError);
  });

  it("uses explicit headers and supports autocomplete, exact/fuzzy name, ID, set+collector, search, and paginated printings", async () => {
    const second = "https://api.scryfall.com/cards/search?page=2";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/autocomplete")) return json({ object: "catalog", data: ["Sol Ring"] });
      if (url.pathname.endsWith("/named")) return json(normal);
      if (url.pathname.endsWith("/cards/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")) return json(normal);
      if (url.pathname.endsWith("/cards/cmm/396/en")) return json(normal);
      if (url.pathname.endsWith("/cards/search") && url.searchParams.has("page")) return json(cardPage([normal]));
      if (url.pathname.endsWith("/cards/search") && url.searchParams.has("q")) {
        return json({ ...cardPage([normal], second), next_page: second });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = fakeClient(fetchImpl);

    await expect(client.autocomplete("Sol")).resolves.toEqual(["Sol Ring"]);
    await expect(client.lookupByName("Sol Ring", "exact")).resolves.toMatchObject({ name: "Sol Ring" });
    await expect(client.lookupByName("Sol Rng", "fuzzy")).resolves.toMatchObject({ name: "Sol Ring" });
    await expect(client.lookupById("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).resolves.toMatchObject({ id: normal.id });
    await expect(client.lookupBySetCollector("cmm", "396", "en")).resolves.toMatchObject({ collectorNumber: "396" });
    await expect(client.searchCards("name:sol ring")).resolves.toHaveLength(1);
    await expect(client.listPrintings("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).resolves.toHaveLength(2);

    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = new Headers(init.headers);
      expect(headers.get("user-agent")).toMatch(/TCGPrint\//);
      expect(headers.get("accept")).toBe("application/json;q=0.9,*/*;q=0.8");
    }
    const urls = fetchImpl.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.some((url) => url.pathname.endsWith("/named") && url.searchParams.has("exact"))).toBe(true);
    expect(urls.some((url) => url.pathname.endsWith("/named") && url.searchParams.has("fuzzy"))).toBe(true);
    expect(urls.some((url) => url.pathname.endsWith("/cmm/396/en"))).toBe(true);
    expect(urls.some((url) => url.searchParams.get("q") === "oracleid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" && url.searchParams.get("unique") === "prints")).toBe(true);
  });

  it("maps 404, 429/Retry-After, and 5xx to typed errors and delays subsequent calls", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 404 })).mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "1" } })).mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const client = fakeClient(fetchImpl);

    await expect(client.lookupById("missing")).rejects.toMatchObject({ kind: "not-found", status: 404 });
    await expect(client.lookupById("rate-limited")).rejects.toMatchObject({ kind: "rate-limited", retryAfterMs: 1000 });
    await expect(client.lookupById("server-error")).rejects.toMatchObject({ kind: "server", status: 503 });

    const waits: number[] = [];
    const limiter = new ScryfallRateLimiter({ now: () => 10_000, minIntervalMs: 0, sleep: async (ms) => { waits.push(ms); } });
    const deferredClient = new ScryfallClient({ rateLimiter: limiter, fetchImpl: vi.fn().mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "2" } })).mockResolvedValueOnce(json(normal)) });
    await expect(deferredClient.lookupById("retry-after")).rejects.toMatchObject({ kind: "rate-limited" });
    await deferredClient.lookupById("after-backoff");
    expect(waits.at(-1)).toBe(2000);
  });

  it("rejects invalid JSON and malformed API response payloads", async () => {
    const client = fakeClient(vi.fn().mockResolvedValueOnce(new Response("<html>bad</html>", { status: 200 })).mockResolvedValueOnce(json({ data: [42] })));
    await expect(client.lookupById("x")).rejects.toMatchObject({ kind: "invalid-json" });
    await expect(client.searchCards("x")).rejects.toMatchObject({ kind: "invalid-payload" });
  });

  it("times out, propagates caller AbortSignal, and maps fetch transport failures", async () => {
    const timeoutClient = fakeClient((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }), { timeoutMs: 5 });
    await expect(timeoutClient.lookupById("slow")).rejects.toMatchObject({ kind: "timeout" });

    const controller = new AbortController();
    controller.abort();
    const aborted = fakeClient(vi.fn());
    await expect(aborted.lookupById("x", { signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("validates HTTPS Scryfall asset URLs, content bytes, response type, and size", async () => {
    const validPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const client = fakeClient(vi.fn().mockResolvedValue(new Response(validPng, { headers: { "content-type": "image/png" } })), { maxAssetBytes: 10 });
    await expect(client.downloadAsset("http://cards.scryfall.io/test.png", { kind: "original" })).rejects.toMatchObject({ kind: "unsafe-url" });
    await expect(client.downloadAsset("https://example.com/test.png", { kind: "original" })).rejects.toMatchObject({ kind: "unsafe-url" });

    const html = fakeClient(vi.fn().mockResolvedValue(new Response("<html>no</html>", { headers: { "content-type": "image/jpeg" } })));
    await expect(html.downloadAsset("https://cards.scryfall.io/test.jpg", { kind: "original" })).rejects.toMatchObject({ kind: "invalid-image" });
    await expect(client.downloadAsset("https://cards.scryfall.io/test.png", { kind: "original" })).rejects.toMatchObject({ kind: "asset-too-large" });
  });

  it("uses a shared limiter and keeps concurrently issued requests serialized", async () => {
    const observed: number[] = [];
    const fetchImpl = vi.fn(async () => { observed.push(Date.now()); return json(normal); });
    const client = fakeClient(fetchImpl, { minIntervalMs: 125 });
    await Promise.all([client.lookupById("one"), client.lookupById("two")]);
    expect(observed).toHaveLength(2);
    expect(observed[1] - observed[0]).toBeGreaterThanOrEqual(100);
  });
});
