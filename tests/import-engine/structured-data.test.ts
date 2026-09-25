import { describe, expect, it } from "vitest";
import { parseCsvImport } from "../../import-engine/importers/csv";
import { parseJsonImport } from "../../import-engine/importers/json";
import type { ImportSource } from "../../import-engine/types";

function source(filename: string, text: string): ImportSource {
  return {
    id: filename,
    kind: "file",
    filename,
    order: 0,
    sizeBytes: Buffer.byteLength(text),
    originalBytes: new TextEncoder().encode(text),
  };
}

describe("CSV and TSV importers", () => {
  it("respects quoted commas, escaped quotes, aliases and unknown columns", () => {
    const input = source("cards.csv", 'Card Name,Count,Set Code,Collector Number,Language,Note\n"Foo, the \"\"Bar\"\"",2,CMM,396,en,keep me\n');
    const result = parseCsvImport(input);
    expect(result.entries[0]).toMatchObject({
      quantity: 2,
      cardHint: { name: 'Foo, the "Bar"', setCode: "CMM", collectorNumber: "396", language: "en" },
      metadata: { rawRecord: { Note: "keep me" } },
    });
    expect(result.mappings?.[0].unknownFields).toEqual(["Note"]);
  });

  it("supports explicit column overrides and TSV", () => {
    const input = source("cards.tsv", "Display\tCopies\tScryfall ID\nSol Ring\t3\tabc-123\n");
    const result = parseCsvImport(input, { name: "Display", quantity: "Copies", scryfallId: "Scryfall ID" }, "\t");
    expect(result.entries[0]).toMatchObject({ quantity: 3, cardHint: { name: "Sol Ring", scryfallId: "abc-123" } });
    expect(result.mappings?.[0].format).toBe("tsv");
  });

  it("reports malformed quoting and rows without a name", () => {
    expect(() => parseCsvImport(source("bad.csv", 'name,quantity\n"unfinished,1')))
      .toThrowError(expect.objectContaining({ code: "INVALID_CSV" }));
    const result = parseCsvImport(source("blank.csv", "name,quantity\n,2\n"));
    expect(result.entries).toHaveLength(0);
    expect(result.warnings[0]).toMatchObject({ code: "MISSING_NAME", line: 2 });
  });
});

describe("JSON importers", () => {
  it("recognizes common cards arrays and aliases", () => {
    const input = source("deck.json", JSON.stringify({ cards: [{ name: "Sol Ring", count: 2, set_code: "CMM" }] }));
    const result = parseJsonImport(input);
    expect(result.entries[0]).toMatchObject({ quantity: 2, cardHint: { name: "Sol Ring", setCode: "CMM" } });
  });

  it("supports explicit cards[].name and nested field paths", () => {
    const input = source("custom.json", JSON.stringify({ cards: [{ print: { label: "Island", id: "s1" }, copies: 4, image: "local.png" }] }));
    const result = parseJsonImport(input, {
      name: "cards[].print.label",
      quantity: "cards[].copies",
      scryfallId: "cards[].print.id",
      imageUrl: "cards[].image",
    });
    expect(result.entries[0]).toMatchObject({
      quantity: 4,
      cardHint: { name: "Island", scryfallId: "s1", imageUrl: "local.png" },
    });
    expect(result.mappings?.[0]).toMatchObject({ format: "json", fields: { name: "cards[].print.label" } });
  });

  it("returns typed errors for invalid, oversized, deeply nested and non-card JSON", () => {
    expect(() => parseJsonImport(source("bad.json", "{")))
      .toThrowError(expect.objectContaining({ code: "INVALID_JSON" }));
    const nested = JSON.stringify({ cards: [{ name: "Sol Ring", extra: { a: { b: 1 } } }] });
    expect(() => parseJsonImport(source("deep.json", nested), undefined, { maxJsonDepth: 3 }))
      .toThrowError(expect.objectContaining({ code: "INVALID_JSON" }));
    const result = parseJsonImport(source("empty.json", JSON.stringify({ unrelated: true })));
    expect(result.entries).toHaveLength(0);
    expect(result.warnings[0].code).toBe("NO_CARD_COLLECTION");
  });
});
