import { describe, expect, it } from "vitest";
import normal from "../../fixtures/scryfall/normal-card.json";
import dmf from "../../fixtures/scryfall/dmf-card.json";
import malformed from "../../fixtures/scryfall/malformed-card.json";
import { mapScryfallCard } from "../../../providers/scryfall/mapper";
import { ScryfallError } from "../../../providers/scryfall/errors";

describe("Scryfall card mapper", () => {
  it("normalizes root image URIs and related token metadata", () => {
    const card = mapScryfallCard(normal);
    expect(card).toMatchObject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", oracleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Sol Ring", layout: "normal", setCode: "cmm", collectorNumber: "396", lang: "en", releasedAt: "2023-08-04", digital: false, promo: false, fullArt: false, borderColor: "black", imageStatus: "highres_scan" });
    expect(card.imageUris?.png).toContain("/png/");
    expect(card.relatedUris?.edhrec).toContain("https://edhrec.com/");
    expect(card.relatedCards).toEqual([{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", component: "token", name: "Powerstone", typeLine: "Token Artifact" }]);
  });

  it("keeps root images and maps each multiface image in face order", () => {
    const card = mapScryfallCard(dmf);
    expect(card.imageUris?.normal).toContain("/normal/front/");
    expect(card.faces.map((face) => [face.name, face.imageUris?.png])).toEqual([
      ["Delver of Secrets", expect.stringContaining("/png/front/")],
      ["Insectile Aberration", expect.stringContaining("/png/back/")],
    ]);
  });

  it("maps DFC data that only has card_faces.image_uris", () => {
    const faceOnly = { ...dmf, image_uris: undefined };
    const card = mapScryfallCard(faceOnly);
    expect(card.imageUris).toBeUndefined();
    expect(card.faces).toHaveLength(2);
    expect(card.faces[1].imageUris?.normal).toContain("/back/");
  });

  it("validates required and optional provider fields without exposing raw payload", () => {
    expect(() => mapScryfallCard(malformed)).toThrow(ScryfallError);
    const mapped = mapScryfallCard({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Island", layout: "normal", set: "m21", collector_number: "265", lang: "en" });
    expect(mapped.oracleId).toBeUndefined();
    expect(mapped).not.toHaveProperty("raw");
  });
});
