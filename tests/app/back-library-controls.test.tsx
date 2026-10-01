import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import BackLibraryControls, { backLibraryAssetReference } from "../../src/app/back-library-controls";
import type { WorkingCard } from "../../core/cards/types";

const sha256 = "a".repeat(64);
const asset = { assetId: `back:${sha256}`, sha256, format: "png" as const, name: "Blue cardback.png", widthPx: 600, heightPx: 840, retired: false };
const retired = { ...asset, assetId: `back:${"b".repeat(64)}`, sha256: "b".repeat(64), name: "Archived.png", retired: true };
const card: WorkingCard = {
  id: "working-card", quantity: 1, order: 0,
  importSource: { sourceId: "source", importKind: "fixture", entryKind: "card" },
  identityHints: { name: "Fixture" }, identity: null,
  identityResolution: { status: "unresolved", candidates: [], confirmed: false },
  faces: [{ id: "front", side: "front" }], selectedArtworkByFace: {}, backMode: "project-default",
  backModeSelectionPolicy: "automatic", localArtworkIds: [], mpcReferences: [], faceAssociations: [],
};

describe("Back Library controls", () => {
  it("reduces library DTOs to immutable references before Project persistence", () => {
    const reference = backLibraryAssetReference(asset);
    expect(reference).toEqual({ assetId: asset.assetId, sha256: asset.sha256, format: asset.format });
    expect(Object.keys(reference).sort()).toEqual(["assetId", "format", "sha256"]);
  });

  it("exposes Project default, per-card mode, original upload, and immutable retired IDs accessibly", () => {
    const inert = vi.fn();
    const markup = renderToStaticMarkup(createElement(BackLibraryControls, {
      assets: [asset, retired],
      selectedDefault: { assetId: retired.assetId, sha256: retired.sha256, format: retired.format },
      selectedCard: card,
      disabled: false,
      onAssetsChange: inert,
      onDefaultChange: inert,
      onCardModeChange: inert,
      onManualBackChange: inert,
    }));

    expect(markup).toContain('aria-label="Verso padrão do Project"');
    expect(markup).toContain('aria-label="Modo de verso da carta"');
    expect(markup).toContain('aria-label="Adicionar verso à Back Library"');
    expect(markup).toContain("Blue cardback.png");
    expect(markup).toContain("Archived.png · bbbbbbbbbbbb");
    expect(markup).toContain("mantendo seu ID e bytes resolvíveis por Projects existentes");
  });
});
