import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkingCardList } from "../../../src/app/card-identity-workbench";
import type { WorkingCard } from "../../../core/cards/types";

const card: WorkingCard = {
  id: "sol-ring-working-card",
  quantity: 2,
  order: 0,
  importSource: { sourceId: "deck", importKind: "text", entryKind: "deck-card" },
  identityHints: { name: "Sol Ring" },
  identity: null,
  identityResolution: { status: "unresolved", candidates: [], confirmed: false },
  faces: [{ id: "front", side: "front", name: "Sol Ring" }],
  selectedArtworkByFace: { front: { candidateId: "scryfall:sol-ring", source: "scryfall", identityId: null, faceId: "front" } },
  localArtworkIds: [],
  mpcReferences: [],
  faceAssociations: [],
};

describe("working card editor list UI", () => {
  it("renders quantity, position, accessible reorder, duplicate, delete and drag controls", () => {
    const markup = renderToStaticMarkup(createElement(WorkingCardList, {
      cards: [card],
      selectedCardId: card.id,
      physicalCardCount: 2,
      disabled: false,
      onSelect: vi.fn(),
      onQuantityCommit: vi.fn(),
      onQuantityAdjust: vi.fn(),
      onMove: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("1/1");
    expect(markup).toContain("Sol Ring");
    expect(markup).toContain("1 entrada · 2 cartas físicas");
    expect(markup).toContain('value="2"');
    expect(markup).toContain('aria-label="Mover Sol Ring para cima"');
    expect(markup).toContain('aria-label="Mover Sol Ring para baixo"');
    expect(markup).toContain('aria-label="Duplicar Sol Ring"');
    expect(markup).toContain('aria-label="Excluir Sol Ring"');
    expect(markup).toContain('draggable="true"');
  });
});
