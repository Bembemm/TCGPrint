import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { importFiles } from "../../../import-engine";
import type { UniversalImportOptions } from "../../../import-engine/types";
import { makeSyntheticZip } from "../../helpers/zip";

const PUBLIC_DNS = async () => ["93.184.216.34"];

function urlOptions(fetchImpl: typeof fetch, overrides: Partial<UniversalImportOptions> = {}): UniversalImportOptions {
  return { fetchImpl, resolveHost: PUBLIC_DNS, ...overrides };
}

function fakeFetch(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

async function importUrl(url: string, response: Response, options: Partial<UniversalImportOptions> = {}) {
  const fetchImpl = fakeFetch(response);
  const result = await importFiles({ text: url }, urlOptions(fetchImpl, options));
  return { result, fetchImpl };
}

describe("direct URL file imports", () => {
  it.each([
    ["https://files.example.invalid/deck.txt", "text/plain", "1 Sol Ring\n", "Sol Ring"],
    ["https://files.example.invalid/deck.csv", "text/csv", "name,quantity\nSol Ring,2\n", "Sol Ring"],
    ["https://files.example.invalid/deck.xml", "application/xml", "<deck><card><name>Sol Ring</name></card></deck>", undefined],
    ["https://files.example.invalid/deck.json", "application/json", '{"cards":[{"name":"Sol Ring","quantity":2}]}', "Sol Ring"],
  ])("routes %s through the existing importer", async (url, mediaType, body, cardName) => {
    const { result } = await importUrl(url, new Response(body, { headers: { "content-type": mediaType } }));
    expect(result.report.errors).toEqual([]);
    expect(result.sources[0]).toMatchObject({ sourceUrl: url, mediaType });
    if (cardName) expect(result.entries[0]?.cardHint?.name).toBe(cardName);
    else expect(result.entries[0]?.kind).toBe("document");
  });

  it("detects a PNG from bytes when its URL extension and Content-Type disagree", async () => {
    const png = new Uint8Array(readFileSync(new URL("../../fixtures/pdf/synthetic-rgb.png", import.meta.url)));
    const { result } = await importUrl(
      "https://files.example.invalid/card.csv",
      new Response(png, { headers: { "content-type": "text/csv" } }),
    );

    expect(result.report.errors).toEqual([]);
    expect(result.entries[0]).toMatchObject({ kind: "custom-card", asset: { originalFormat: "png", mediaType: "image/png" } });
    expect(result.report.warnings.map(({ code }) => code)).toContain("URL_CONTENT_TYPE_MISMATCH");
    expect(result.sources[0]).toMatchObject({ originalFormat: "png", sourceUrl: "https://files.example.invalid/card.csv" });
  });

  it.each(["application/zip", "application/octet-stream"])("imports ZIP bytes returned with Content-Type %s exactly once", async (mediaType) => {
    const url = "https://files.example.invalid/archive.bin";
    const zip = makeSyntheticZip([{ name: "deck.txt", bytes: new TextEncoder().encode("1 Sol Ring") }]);
    const { result } = await importUrl(url, new Response(Buffer.from(zip), { headers: { "content-type": mediaType } }));
    const urlSource = result.sources.find((source) => source.kind === "url");
    const child = result.sources.find((source) => source.kind === "zip-entry");

    expect(result.report.errors).toEqual([]);
    expect(urlSource).toMatchObject({ sourceUrl: url, mediaType, originalFormat: "zip" });
    expect(child).toMatchObject({ kind: "zip-entry", filename: "deck.txt", sourcePath: "deck.txt", parentSourceId: urlSource?.id });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ kind: "deck-card", sourceId: child?.id, sourcePath: "deck.txt", cardHint: { name: "Sol Ring" } });
    expect(result.detections.filter((detection) => detection.sourceId === child?.id)).toHaveLength(1);
    expect(result.report.selectedImporters.filter((item) => item.sourceId === child?.id)).toHaveLength(1);
  });

  it("keeps valid ZIP siblings when one extracted entry fails", async () => {
    const zip = makeSyntheticZip([
      { name: "broken.json", bytes: new TextEncoder().encode("{") },
      { name: "deck.txt", bytes: new TextEncoder().encode("1 Sol Ring") },
    ]);
    const { result } = await importUrl(
      "https://files.example.invalid/archive.zip",
      new Response(Buffer.from(zip), { headers: { "content-type": "application/zip" } }),
    );

    expect(result.report.errors).toMatchObject([{ code: "INVALID_JSON" }]);
    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Sol Ring"]);
  });

  it("imports nested ZIP descendants from a URL and enforces the ZIP tree entry limit", async () => {
    const nested = makeSyntheticZip([{ name: "inside.txt", bytes: new TextEncoder().encode("2 Island") }]);
    const zip = makeSyntheticZip([
      { name: "nested/cards.zip", bytes: nested },
      { name: "outer.txt", bytes: new TextEncoder().encode("1 Sol Ring") },
    ]);
    const url = "https://files.example.invalid/archive.zip";
    const { result } = await importUrl(
      url,
      new Response(Buffer.from(zip), { headers: { "content-type": "application/zip" } }),
    );
    const nestedSource = result.sources.find((source) => source.kind === "zip-entry" && source.filename === "cards.zip");
    const leaf = result.sources.find((source) => source.kind === "zip-entry" && source.filename === "inside.txt");

    expect(result.report.errors).toEqual([]);
    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Island", "Sol Ring"]);
    expect(leaf?.parentSourceId).toBe(nestedSource?.id);
    expect(result.detections.filter((detection) => detection.sourceId === leaf?.id)).toHaveLength(1);

    const limited = await importUrl(
      url,
      new Response(Buffer.from(zip), { headers: { "content-type": "application/zip" } }),
      { limits: { maxZipEntries: 1 } },
    );
    expect(limited.result.report.errors.some((error) => error.code === "ZIP_ENTRY_LIMIT")).toBe(true);
  });

  it("rejects HTML even when the URL looks like a text deck file", async () => {
    const { result } = await importUrl(
      "https://files.example.invalid/deck.txt",
      new Response("<!doctype html><html><body>Cloudflare</body></html>", { headers: { "content-type": "text/html" } }),
    );
    expect(result.report.errors).toMatchObject([{ code: "URL_CONTENT_TYPE" }]);
    expect(result.entries).toEqual([]);
  });

  it("reports a remote 404 without importing the response body", async () => {
    const { result } = await importUrl(
      "https://files.example.invalid/missing.csv",
      new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }),
    );
    expect(result.report.errors).toMatchObject([{ code: "URL_HTTP_ERROR", message: "Remote server returned HTTP 404." }]);
    expect(result.entries).toEqual([]);
  });

  it.each([
    ["https://", "URL_INVALID"],
    ["ftp://files.example.invalid/deck.txt", "URL_UNSUPPORTED"],
    ["https://scryfall.com/search?q=sol+ring", "URL_UNSUPPORTED"],
  ])("reports unsupported URL input %s clearly", async (url, code) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await importFiles({ text: url }, urlOptions(fetchImpl));
    expect(result.report.errors).toMatchObject([{ code }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses Content-Type as a format hint and redacts URL secrets from the report", async () => {
    const url = "https://files.example.invalid/list?token=top-secret&download=1";
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      expect(String(input)).toContain("token=top-secret");
      return new Response("not valid JSON", { headers: { "content-type": "application/json" } });
    });
    const result = await importFiles({ text: url }, urlOptions(fetchImpl));

    expect(result.report.errors).toMatchObject([{ code: "INVALID_JSON" }]);
    expect(result.report.selectedImporters).toMatchObject([{ kind: "json" }]);
    expect(result.sources[0]?.sourceUrl).toBe("https://files.example.invalid/list?token=%5Bredacted%5D&download=1");
    expect(JSON.stringify(result.sources)).not.toContain("top-secret");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends an application-identifying User-Agent for public file hosts", async () => {
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get("User-Agent")).toBe("TCGPrint/0.1.0 (+https://github.com/Bembemm/TCGPrint)");
      return new Response("1 Sol Ring", { headers: { "content-type": "text/plain" } });
    });
    const result = await importFiles({ text: "https://files.example.invalid/deck.txt" }, urlOptions(fetchImpl));

    expect(result.report.errors).toEqual([]);
    expect(result.entries[0]?.cardHint?.name).toBe("Sol Ring");
  });

  it("reports HTTP failures and keeps sibling file imports available", async () => {
    const fetchImpl = fakeFetch(new Response("blocked", { status: 403, headers: { "content-type": "text/plain" } }));
    const result = await importFiles({
      files: [{ filename: "deck.txt", bytes: new TextEncoder().encode("1 Sol Ring") }],
      text: "https://files.example.invalid/deck.txt",
    }, urlOptions(fetchImpl));

    expect(result.report.errors).toMatchObject([{ code: "URL_HTTP_ERROR" }]);
    expect(result.entries.map((entry) => entry.cardHint?.name)).toContain("Sol Ring");
  });

  it("aborts a request that exceeds the configured response byte limit", async () => {
    const { result } = await importUrl(
      "https://files.example.invalid/deck.txt",
      new Response("1 Sol Ring"),
      { maxUrlResponseBytes: 4 },
    );
    expect(result.report.errors).toMatchObject([{ code: "URL_RESPONSE_LIMIT" }]);
  });

  it("times out a remote request", async () => {
    const fetchImpl: typeof fetch = vi.fn((_input, init = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const { result } = await importUrl("https://files.example.invalid/deck.txt", new Response(), {
      fetchImpl,
      urlTimeoutMs: 5,
    });
    expect(result.report.errors).toMatchObject([{ code: "URL_TIMEOUT" }]);
  });

  it("blocks redirects to loopback before making the redirected request", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    })) as unknown as typeof fetch;
    const { result } = await importUrl("https://files.example.invalid/deck.txt", new Response(), { fetchImpl });

    expect(result.report.errors).toMatchObject([{ code: "URL_REDIRECT_BLOCKED" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("blocks direct requests to the reserved 192.0.2.0/24 range before fetching", async () => {
    const { result, fetchImpl } = await importUrl(
      "http://192.0.2.1/deck.txt",
      new Response("1 Sol Ring", { headers: { "content-type": "text/plain" } }),
    );

    expect(result.report.errors).toMatchObject([{ code: "URL_HOST_BLOCKED" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks redirects to the reserved 192.0.2.0/24 range before following them", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://192.0.2.1/admin" },
    })) as unknown as typeof fetch;
    const { result } = await importUrl("https://files.example.invalid/deck.txt", new Response(), { fetchImpl });

    expect(result.report.errors).toMatchObject([{ code: "URL_REDIRECT_BLOCKED" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows a direct-file request to a public IPv4 address", async () => {
    const { result, fetchImpl } = await importUrl(
      "http://93.184.216.34/deck.txt",
      new Response("1 Sol Ring", { headers: { "content-type": "text/plain" } }),
    );

    expect(result.report.errors).toEqual([]);
    expect(result.entries[0]?.cardHint?.name).toBe("Sol Ring");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("blocks private DNS answers for direct-file hosts", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await importFiles({ text: "https://files.example.invalid/deck.txt" }, {
      fetchImpl,
      resolveHost: async () => ["10.0.0.4"],
    });
    expect(result.report.errors).toMatchObject([{ code: "URL_HOST_BLOCKED" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
