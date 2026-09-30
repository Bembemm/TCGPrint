import { describe, expect, it, vi } from "vitest";
import { importFiles } from "../../../import-engine";

const publicResolver = async () => ["93.184.216.34"];

describe("mtg.wtf deck URL adapter", () => {
  it("uses the explicit download endpoint and imports the plain-text deck", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      requests.push(url);
      return new Response("// NAME: Red-White Deck\n// URL: https://mtg.wtf/deck/m19/red-white-deck\n// DATE: 2019-01-01\n4 Lightning Strike\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    });
    const url = "https://mtg.wtf/deck/m19/red-white-deck";
    const result = await importFiles({ text: url }, { fetchImpl, resolveHost: publicResolver });

    expect(requests).toEqual(["https://mtg.wtf/deck/m19/red-white-deck/download"]);
    expect(result.report.errors).toEqual([]);
    expect(result.entries).toMatchObject([{ cardHint: { name: "Lightning Strike" }, quantity: 4 }]);
    expect(result.sources[0]).toMatchObject({ adapterId: "mtg-wtf", sourceUrl: url, mediaType: "text/plain" });
  });

  it("does not fetch unsupported paths", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await importFiles({ text: "https://mtg.wtf/card/m19/123" }, { fetchImpl, resolveHost: publicResolver });
    expect(result.report.errors).toMatchObject([{ code: "URL_UNSUPPORTED" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts the explicit /download export URL itself", async () => {
    const downloadUrl = "https://mtg.wtf/deck/m19/red-white-deck/download";
    const fetchImpl: typeof fetch = vi.fn(async () => new Response("4 Lightning Strike\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }));
    const result = await importFiles({ text: downloadUrl }, { fetchImpl, resolveHost: publicResolver });
    expect(result.report.errors).toEqual([]);
    expect(result.entries[0]?.cardHint?.name).toBe("Lightning Strike");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reports remote and malformed export failures per URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("blocked", { status: 503 })) as unknown as typeof fetch;
    const result = await importFiles({ text: "https://mtg.wtf/deck/m19/red-white-deck" }, { fetchImpl, resolveHost: publicResolver });
    expect(result.report.errors).toMatchObject([{ code: "URL_HTTP_ERROR" }]);
    expect(result.entries).toEqual([]);

    const malformed = await importFiles({ text: "https://mtg.wtf/deck/m19/red-white-deck" }, {
      fetchImpl: vi.fn(async () => new Response("<html>not a deck</html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      resolveHost: publicResolver,
    });
    expect(malformed.report.errors).toMatchObject([{ code: "URL_ADAPTER_PAYLOAD" }]);
  });
});
