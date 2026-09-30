import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { importFiles } from "../../../import-engine";

const publicResolver = async () => ["93.184.216.34"];
const fixture = JSON.parse(new TextDecoder().decode(readFileSync(new URL("../../fixtures/import-engine/urls/cubecobra-cube.json", import.meta.url)))) as unknown;
const cubeUrl = "https://cubecobra.com/cube/overview/synthetic-cube";
const apiUrl = "https://cubecobra.com/cube/api/cubeJSON/synthetic-cube";

describe("CubeCobra URL adapter", () => {
  it("fetches the public cube JSON endpoint and preserves board labels and printing hints", async () => {
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      expect(String(input)).toBe(apiUrl);
      return new Response(JSON.stringify(fixture), { headers: { "content-type": "application/json; charset=utf-8" } });
    });
    const result = await importFiles({ text: cubeUrl }, { fetchImpl, resolveHost: publicResolver });

    expect(result.report.errors).toEqual([]);
    expect(result.report.selectedImporters).toMatchObject([{ kind: "json" }]);
    expect(result.entries).toMatchObject([
      { cardHint: { name: "Sol Ring", setCode: "cmm", collectorNumber: "396", section: "Mainboard" } },
      { cardHint: { name: "Lightning Bolt", setCode: "lea", collectorNumber: "161", section: "Maybeboard" } },
      { cardHint: { name: "Island", setCode: "m21", collectorNumber: "310", section: "Basics" } },
    ]);
    expect(result.sources[0]).toMatchObject({ adapterId: "cubecobra", sourceUrl: cubeUrl, mediaType: "application/json" });
  });

  it("rejects malformed IDs/paths and does not fetch them", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const url of ["https://cubecobra.com/cube/overview/a", "https://cubecobra.com/cube/list/synthetic-cube"]) {
      const result = await importFiles({ text: url }, { fetchImpl, resolveHost: publicResolver });
      expect(result.report.errors).toMatchObject([{ code: "URL_UNSUPPORTED" }]);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports HTTP and malformed schema failures, isolated from sibling imports", async () => {
    const unavailable = await importFiles({ text: cubeUrl }, {
      fetchImpl: vi.fn(async () => new Response("blocked", { status: 502 })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(unavailable.report.errors).toMatchObject([{ code: "URL_HTTP_ERROR" }]);

    const malformed = await importFiles({ text: cubeUrl }, {
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: "x", cards: { mainboard: "not-an-array" } }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(malformed.report.errors).toMatchObject([{ code: "URL_ADAPTER_PAYLOAD" }]);

    const mixed = await importFiles({
      files: [{ filename: "deck.txt", bytes: new TextEncoder().encode("1 Sol Ring") }],
      text: cubeUrl,
    }, {
      fetchImpl: vi.fn(async () => new Response("blocked", { status: 502 })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(mixed.report.errors).toMatchObject([{ code: "URL_HTTP_ERROR" }]);
    expect(mixed.entries.map((entry) => entry.cardHint?.name)).toContain("Sol Ring");
  });

  it("times out its cube JSON request", async () => {
    const fetchImpl: typeof fetch = vi.fn((_input, init = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const result = await importFiles({ text: cubeUrl }, { fetchImpl, resolveHost: publicResolver, urlTimeoutMs: 5 });
    expect(result.report.errors).toMatchObject([{ code: "URL_TIMEOUT" }]);
  });
});
