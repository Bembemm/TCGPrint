import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ImportFailureError } from "../../import-engine";
import { importGenericXml, importMpcAutofillXml } from "../../import-engine/importers/xml";
import type { ImportSource } from "../../import-engine/types";

const fixture = new Uint8Array(readFileSync(new URL("../fixtures/import-engine/mpc-order-synthetic.xml", import.meta.url)));

function source(filename: string, bytes: Uint8Array): ImportSource {
  return { id: filename, kind: "file", filename, order: 7, sizeBytes: bytes.byteLength, originalBytes: bytes };
}

describe("XML document importers", () => {
  it("retains a valid generic XML document as an import entry", () => {
    const result = importGenericXml(source("deck.xml", new TextEncoder().encode("<deck><entry>Example</entry></deck>")));
    expect(result.entries[0]).toMatchObject({ kind: "document", metadata: { rootName: "deck" } });
  });

  it("preserves MPC front/back order, slots, quantities and selected artwork IDs", () => {
    const result = importMpcAutofillXml(source("order.xml", fixture));
    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual([
      "Example Front", "Repeated Example Front", "Optional ID Example",
    ]);
    expect(result.entries.map((entry) => entry.quantity)).toEqual([2, 1, 1]);
    expect(result.entries[0]).toMatchObject({
      kind: "mpc-order-card",
      slots: ["2", "1"],
      front: { selectedArtworkId: "synthetic-front-art-a", name: "Example Front", query: "synthetic:front-a" },
      faces: [{ side: "front" }, { side: "back", selectedArtworkId: "synthetic-back-art-a" }],
      faceAssociations: [
        { slot: "2", backAssetId: expect.any(String) },
        { slot: "1", backAssetId: expect.any(String) },
      ],
    });
    expect(result.entries[1].back?.selectedArtworkId).toBe("synthetic-back-art-b");
    expect(result.entries[2].front?.selectedArtworkId).toBeUndefined();
    expect(result.entries[2].metadata).toMatchObject({ cardback: "synthetic-cardback-artwork" });
    expect(result.metadata).toMatchObject({ cardbackAsset: { selectedArtworkId: "synthetic-cardback-artwork" } });
    expect(result.warnings.some((warning) => warning.code === "MPC_QUANTITY_DIFFERS_FROM_SLOTS")).toBe(true);
  });

  it("keeps details and cardback when there are no card records", () => {
    const xml = new TextEncoder().encode("<order><details><quantity>1</quantity></details><cardback>synthetic-back</cardback></order>");
    const result = importMpcAutofillXml(source("empty-order.xml", xml));
    expect(result.entries[0]).toMatchObject({ kind: "document", metadata: { cardback: "synthetic-back" } });
    expect(result.metadata).toMatchObject({ cardbackAsset: { selectedArtworkId: "synthetic-back" } });
  });

  it("emits a typed error for malformed MPC XML", () => {
    expect(() => importMpcAutofillXml(source("bad-order.xml", new TextEncoder().encode("<order><fronts>"))))
      .toThrowError(expect.objectContaining({ code: "INVALID_XML" } satisfies Partial<ImportFailureError>));
  });
});
