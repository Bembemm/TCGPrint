import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importFiles } from "../../import-engine";
import { makeSyntheticZip } from "../helpers/zip";
import type { ImportFileInput, ImportResult, UniversalImportRequest } from "../../import-engine/types";

const bytes = (text: string) => new TextEncoder().encode(text);
const mpcFixture = new Uint8Array(readFileSync(new URL("../fixtures/import-engine/mpc-order-synthetic.xml", import.meta.url)));

function file(filename: string, content: string): ImportFileInput {
  return { filename, bytes: bytes(content) };
}

function expectGlobalOrder(result: ImportResult): void {
  const orders = result.entries.map((entry) => entry.order);
  expect(new Set(orders).size).toBe(result.entries.length);
  expect(orders).toEqual(Array.from({ length: result.entries.length }, (_, index) => index));
}

describe("universal import entry ordering", () => {
  it("assigns global order to MPC records without changing XML order, slots, or artwork IDs", async () => {
    const result = await importFiles({ files: [{ filename: "order.xml", bytes: mpcFixture }] });

    expect(result.entries).toHaveLength(3);
    expectGlobalOrder(result);
    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual([
      "Example Front", "Repeated Example Front", "Optional ID Example",
    ]);
    expect(result.entries.map((entry) => entry.quantity)).toEqual([2, 1, 1]);
    expect(result.entries.map((entry) => entry.slots)).toEqual([["2", "1"], ["3"], ["4"]]);
    expect(result.entries.map((entry) => entry.front?.selectedArtworkId)).toEqual([
      "synthetic-front-art-a", "synthetic-front-art-a", undefined,
    ]);
    expect(result.entries.map((entry) => entry.back?.selectedArtworkId)).toEqual([
      "synthetic-back-art-a", "synthetic-back-art-b", "synthetic-back-art-c",
    ]);
    expect(result.entries[0].faceAssociations?.map((association) => association.slot)).toEqual(["2", "1"]);
  });

  it("assigns increasing unique order to every decklist line", async () => {
    const result = await importFiles({ text: "Sol Ring\n1x Island\n10 Mountain" });

    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Sol Ring", "Island", "Mountain"]);
    expectGlobalOrder(result);
  });

  it("assigns increasing unique order to every CSV row", async () => {
    const result = await importFiles({ files: [file("cards.csv", "name,quantity\nSol Ring,1\nIsland,2\nMountain,3\n")] });

    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Sol Ring", "Island", "Mountain"]);
    expectGlobalOrder(result);
  });

  it("assigns increasing unique order to every JSON entry", async () => {
    const result = await importFiles({
      files: [file("cards.json", JSON.stringify({
        cards: [{ name: "Sol Ring" }, { name: "Island" }, { name: "Mountain" }],
      }))],
      selections: { "input:0:cards.json": "json" },
    });

    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Sol Ring", "Island", "Mountain"]);
    expectGlobalOrder(result);
  });

  it("keeps files in supplied batch order and assigns one global sequence", async () => {
    const result = await importFiles({ files: [file("first.txt", "Sol Ring\nIsland"), file("second.txt", "Mountain\nForest")] });

    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Sol Ring", "Island", "Mountain", "Forest"]);
    expectGlobalOrder(result);
  });

  it("keeps deterministic safe ZIP expansion order and assigns one global sequence", async () => {
    const nested = makeSyntheticZip([{ name: "second.txt", bytes: bytes("Island") }]);
    const archive = makeSyntheticZip([
      { name: "first.txt", bytes: bytes("Sol Ring") },
      { name: "nested.zip", bytes: nested },
      { name: "third.txt", bytes: bytes("Mountain") },
    ]);
    const request: UniversalImportRequest = { files: [{ filename: "cards.zip", bytes: archive }] };
    const result = await importFiles(request);

    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Sol Ring", "Island", "Mountain"]);
    expectGlobalOrder(result);
  });
});
