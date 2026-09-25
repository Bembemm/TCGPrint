import { describe, expect, it } from "vitest";
import { parseTextImport } from "../../import-engine/importers/text";

describe("text decklist importers", () => {
  it("parses bare names and common quantity prefixes", () => {
    const result = parseTextImport("Sol Ring\n1 Sol Ring\n1x Sol Ring\n10 Island", "simple-decklist");
    expect(result.entries.map((entry) => [entry.quantity, entry.cardHint?.name])).toEqual([
      [1, "Sol Ring"], [1, "Sol Ring"], [1, "Sol Ring"], [10, "Island"],
    ]);
  });

  it("keeps set and collector as import hints only", () => {
    const result = parseTextImport("1 Sol Ring (CMM) 396", "simple-decklist");
    expect(result.entries[0]).toMatchObject({
      kind: "deck-card",
      quantity: 1,
      cardHint: { name: "Sol Ring", setCode: "CMM", collectorNumber: "396" },
    });
    expect(result.entries[0].metadata?.rawLine).toBe("1 Sol Ring (CMM) 396");
  });

  it("preserves recognized sections and warns for unparsed nonblank lines", () => {
    const result = parseTextImport("Commander\n1 Sol Ring\nMainboard\n10 Island\nMaybeboard\n0x ???", "simple-decklist");
    expect(result.entries.map((entry) => entry.section)).toEqual(["Commander", "Mainboard"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: "UNPARSED_LINE", line: 6 });
  });

  it("uses isolated Arena, MTGO, XMage and MWS adapters when structure identifies them", () => {
    const arena = parseTextImport("Deck\n1 Sol Ring (CMM) 396\nSideboard\n2 Island (M21) 265", "arena-like");
    const mtgo = parseTextImport("1 Sol Ring\nSB: 2 Island", "mtgo-like");
    const xmage = parseTextImport("LAYOUT MAIN\n1 Sol Ring\nLAYOUT SIDEBOARD\n2 Island", "xmage-like");
    const xmageMain = parseTextImport("LAYOUT MAIN\n1 Sol Ring", "xmage-like", {
      id: "xmage-main", kind: "file", filename: "main.dck", order: 0, sizeBytes: 22, originalText: "LAYOUT MAIN\n1 Sol Ring",
    });
    const mws = parseTextImport("Deck file for Magic Workstation\n1 [CMM] Sol Ring", "mwdeck-like");
    expect(arena.entries.map((entry) => entry.section)).toEqual(["Mainboard", "Sideboard"]);
    expect(mtgo.entries.map((entry) => entry.section)).toEqual([undefined, "Sideboard"]);
    expect(xmage.entries.map((entry) => entry.section)).toEqual(["Mainboard", "Sideboard"]);
    expect(xmageMain.entries[0]).toMatchObject({ cardHint: { name: "Sol Ring", section: "Mainboard" } });
    expect(mws.entries[0]).toMatchObject({ quantity: 1, cardHint: { name: "Sol Ring", setCode: "CMM" } });
  });

  it("fails clearly when an explicitly selected adapter does not match", () => {
    expect(() => parseTextImport("random words", "arena-like")).toThrowError(
      expect.objectContaining({ code: "FORMAT_MISMATCH" }),
    );
  });
});
