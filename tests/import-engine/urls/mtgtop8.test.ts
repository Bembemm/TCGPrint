import { describe, expect, it, vi } from "vitest";
import { importFiles } from "../../../import-engine";

const publicResolver = async () => ["93.184.216.34"];
const eventUrl = "https://www.mtgtop8.com/event?d=298009";
const eventHtml = '<html><a class="download" href="/dec?d=298009&amp;f=Limited_WB_by_captainobv">Download</a></html>';

describe("MTGTop8 deck URL adapter", () => {
  it("follows the page's explicit .mwDeck export and parses its MWS rows", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === eventUrl) return new Response(eventHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("// Deck file created with mtgtop8.com\n6 [AKH] Swamp\n1 [AKH] Cursed Minotaur\n", {
        headers: {
          "content-type": "text/plain; charset=ISO-8859-1",
          "content-disposition": 'attachment; filename="Limited_WB_by_captainobv.mwDeck"',
        },
      });
    });
    const result = await importFiles({ text: eventUrl }, { fetchImpl, resolveHost: publicResolver });

    expect(requests).toEqual([eventUrl, "https://www.mtgtop8.com/dec?d=298009&f=Limited_WB_by_captainobv"]);
    expect(result.report.errors).toEqual([]);
    expect(result.entries).toMatchObject([
      { quantity: 6, cardHint: { name: "Swamp", setCode: "AKH" } },
      { quantity: 1, cardHint: { name: "Cursed Minotaur", setCode: "AKH" } },
    ]);
    expect(result.sources[0]).toMatchObject({ adapterId: "mtgtop8", sourceUrl: eventUrl, mediaType: "text/plain" });
  });

  it("accepts direct .mwDeck export links and decodes the declared legacy charset", async () => {
    const exportUrl = "https://www.mtgtop8.com/dec?d=298009&f=Limited_WB_by_captainobv";
    const legacyBody = Buffer.from("// Deck file created with mtgtop8.com\n1 [AKH] Élan\n", "latin1");
    const result = await importFiles({ text: exportUrl }, {
      fetchImpl: vi.fn(async () => new Response(legacyBody, {
        headers: { "content-type": "text/plain; charset=ISO-8859-1" },
      })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(result.report.errors).toEqual([]);
    expect(result.entries[0]?.cardHint?.name).toBe("Élan");
  });

  it("returns clear failures for unsupported paths, unavailable pages, and missing exports", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const unsupported = await importFiles({ text: "https://www.mtgtop8.com/forum" }, { fetchImpl, resolveHost: publicResolver });
    expect(unsupported.report.errors).toMatchObject([{ code: "URL_UNSUPPORTED" }]);
    expect(fetchImpl).not.toHaveBeenCalled();

    const unavailable = await importFiles({ text: eventUrl }, {
      fetchImpl: vi.fn(async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(unavailable.report.errors).toMatchObject([{ code: "URL_HTTP_ERROR" }]);

    const changedPage = await importFiles({ text: eventUrl }, {
      fetchImpl: vi.fn(async () => new Response("<html>export link changed</html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(changedPage.report.errors).toMatchObject([{ code: "URL_ADAPTER_PAYLOAD" }]);
  });

  it("isolates an export failure from valid sibling file imports", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      callCount += 1;
      return callCount === 1
        ? new Response(eventHtml, { headers: { "content-type": "text/html" } })
        : new Response("unavailable", { status: 503 });
    });
    const result = await importFiles({
      files: [{ filename: "local.txt", bytes: new TextEncoder().encode("1 Sol Ring") }],
      text: eventUrl,
    }, { fetchImpl, resolveHost: publicResolver });

    expect(result.report.errors).toMatchObject([{ code: "URL_HTTP_ERROR" }]);
    expect(result.entries.map((entry) => entry.cardHint?.name)).toContain("Sol Ring");
  });
});
