import { describe, expect, it, vi } from "vitest";
import { importFiles } from "../../../import-engine";
import type { UniversalImportOptions } from "../../../import-engine/types";

const publicResolver = async () => ["93.184.216.34"];

describe("Scryfall card URL adapter", () => {
  it("turns an explicit set/collector URL into one card hint without a network request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const url = "https://scryfall.com/card/war/235/the-war-in-the-spark";
    const result = await importFiles({ text: url }, { fetchImpl, resolveHost: publicResolver });

    expect(result.report.errors).toEqual([]);
    expect(result.report.selectedImporters).toMatchObject([{ kind: "url" }]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      kind: "deck-card",
      quantity: 1,
      cardHint: { setCode: "war", collectorNumber: "235" },
      nameSuggestion: "The War in the Spark",
    });
    expect(result.sources[0]).toMatchObject({ adapterId: "scryfall", sourceUrl: url });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "https://scryfall.com/search?q=sol+ring",
    "https://scryfall.com/card/war/not-a-collector/name",
    "https://scryfall.com/card/war/235/name/extra",
  ])("returns a clear unsupported result for %s", async (url) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await importFiles({ text: url }, { fetchImpl, resolveHost: publicResolver });

    expect(result.report.errors).toMatchObject([{ code: "URL_UNSUPPORTED" }]);
    expect(result.entries).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
