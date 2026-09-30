import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { importFiles } from "../../../import-engine";

const publicResolver = async () => ["93.184.216.34"];
const fixture = JSON.parse(new TextDecoder().decode(readFileSync(new URL("../../fixtures/import-engine/urls/archidekt-deck.json", import.meta.url)))) as unknown;
const deckUrl = "https://archidekt.com/decks/7031486";
const apiUrl = "https://archidekt.com/api/decks/7031486/";

describe("Archidekt URL adapter", () => {
  it("fetches the public deck API and normalizes cards through the JSON importer", async () => {
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      expect(String(input)).toBe(apiUrl);
      return new Response(JSON.stringify(fixture), { headers: { "content-type": "application/json; charset=utf-8" } });
    });
    const result = await importFiles({ text: deckUrl }, { fetchImpl, resolveHost: publicResolver });

    expect(result.report.errors).toEqual([]);
    expect(result.report.selectedImporters).toMatchObject([{ kind: "json" }]);
    expect(result.entries).toMatchObject([
      { quantity: 2, cardHint: { name: "Gaea's Gift", setCode: "bro", collectorNumber: "182", section: "Creatures, Mainboard" } },
      { quantity: 1, cardHint: { name: "Example Card", setCode: "m21", collectorNumber: "17", section: "Sideboard" } },
    ]);
    expect(result.sources[0]).toMatchObject({ adapterId: "archidekt", sourceUrl: deckUrl, mediaType: "application/json" });
  });

  it("rejects malformed IDs/paths and does not fetch them", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const url of ["https://archidekt.com/decks/not-a-number", "https://archidekt.com/decks/7031486/cards"]) {
      const result = await importFiles({ text: url }, { fetchImpl, resolveHost: publicResolver });
      expect(result.report.errors).toMatchObject([{ code: "URL_UNSUPPORTED" }]);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports HTTP and schema failures without leaking response bodies", async () => {
    const unavailable = await importFiles({ text: deckUrl }, {
      fetchImpl: vi.fn(async () => new Response("private error body", { status: 403 })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(unavailable.report.errors).toMatchObject([{ code: "URL_HTTP_ERROR" }]);
    expect(JSON.stringify(unavailable.report)).not.toContain("private error body");

    const malformed = await importFiles({ text: deckUrl }, {
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: 7031486, cards: [{ quantity: 1 }] }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(malformed.report.errors).toMatchObject([{ code: "URL_ADAPTER_PAYLOAD" }]);
  });

  it("times out its API request", async () => {
    const fetchImpl: typeof fetch = vi.fn((_input, init = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const result = await importFiles({ text: deckUrl }, { fetchImpl, resolveHost: publicResolver, urlTimeoutMs: 5 });
    expect(result.report.errors).toMatchObject([{ code: "URL_TIMEOUT" }]);
  });

  it("keeps a failed deck request isolated from a valid sibling input", async () => {
    const result = await importFiles({
      files: [{ filename: "deck.txt", bytes: new TextEncoder().encode("1 Sol Ring") }],
      text: deckUrl,
    }, {
      fetchImpl: vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(result.report.errors).toMatchObject([{ code: "URL_HTTP_ERROR" }]);
    expect(result.entries.map((entry) => entry.cardHint?.name)).toContain("Sol Ring");
  });
});
