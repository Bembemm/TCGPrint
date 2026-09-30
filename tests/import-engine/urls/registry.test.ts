import { describe, expect, it } from "vitest";
import { resolveUrlAdapter } from "../../../import-engine/urls/registry";
import { ImportFailureError } from "../../../import-engine/errors";
import type { UrlAdapter } from "../../../import-engine/urls/types";

const knownSites = [
  ["https://scryfall.com/card/war/235", "scryfall"],
  ["https://www.moxfield.com/decks/abc", "moxfield"],
  ["https://archidekt.com/decks/7031486", "archidekt"],
  ["https://cubecobra.com/cube/overview/obc", "cubecobra"],
  ["https://deckstats.net/decks/1/0", "deckstats"],
  ["https://www.mtggoldfish.com/deck/844544", "mtggoldfish"],
  ["https://www.mtgtop8.com/event?d=298009", "mtgtop8"],
  ["https://tappedout.net/mtg-decks/example/", "tappedout"],
  ["https://mtg.wtf/deck/m19/red-white-deck", "mtg-wtf"],
] as const;

describe("URL adapter registry", () => {
  it.each(knownSites)("recognizes the known site %s", (value, siteId) => {
    expect(resolveUrlAdapter(value)).toMatchObject({ kind: "known-unsupported", siteId });
  });

  it("matches a supported adapter only on its explicit hostname and path", () => {
    const adapter: UrlAdapter = {
      id: "test-site",
      hosts: ["example.com"],
      matches: (url) => url.pathname.startsWith("/deck/"),
      import: async () => ({ kind: "entries", entries: [], sourceUrl: "https://example.com/deck/1" }),
    };

    expect(resolveUrlAdapter("https://example.com/deck/1", [adapter])).toMatchObject({
      kind: "adapter",
      adapter: { id: "test-site" },
    });
    expect(resolveUrlAdapter("https://example.com/profile/1", [adapter])).toMatchObject({
      kind: "known-unsupported",
      siteId: "test-site",
    });
    expect(resolveUrlAdapter("https://sub.example.com/deck/1", [adapter]).kind).toBe("direct-file");
    expect(resolveUrlAdapter("https://example.com.attacker.invalid/deck/1", [adapter]).kind).toBe("direct-file");
  });

  it("treats unknown HTTP hosts as possible direct files", () => {
    expect(resolveUrlAdapter("https://files.example.invalid/cards.csv")).toEqual({ kind: "direct-file" });
  });

  it.each(["https://", "https://[::1", "not a URL"])("rejects malformed URL %s with a typed failure", (value) => {
    expect(() => resolveUrlAdapter(value)).toThrowError(ImportFailureError);
    try {
      resolveUrlAdapter(value);
    } catch (error) {
      expect(error).toMatchObject({ code: "URL_INVALID" });
    }
  });

  it.each(["ftp://files.example.invalid/cards.csv", "file:///tmp/cards.csv"])("rejects non-HTTP scheme %s", (value) => {
    expect(() => resolveUrlAdapter(value)).toThrowError(ImportFailureError);
    try {
      resolveUrlAdapter(value);
    } catch (error) {
      expect(error).toMatchObject({ code: "URL_UNSUPPORTED" });
    }
  });
});
