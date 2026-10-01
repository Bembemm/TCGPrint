import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import BackLibraryControls, { backLibraryAssetReference } from "../../src/app/back-library-controls";
import type { WorkingCard } from "../../core/cards/types";

const sha256 = "a".repeat(64);
const asset = { assetId: `back:${sha256}`, sha256, format: "png" as const, name: "Blue cardback.png", widthPx: 600, heightPx: 840, retired: false };
const retired = { ...asset, assetId: `back:${"b".repeat(64)}`, sha256: "b".repeat(64), name: "Archived.png", retired: true };
const unrelatedRetired = { ...asset, assetId: `back:${"c".repeat(64)}`, sha256: "c".repeat(64), name: "Old unused.png", retired: true };
const card: WorkingCard = {
  id: "working-card", quantity: 1, order: 0,
  importSource: { sourceId: "source", importKind: "fixture", entryKind: "card" },
  identityHints: { name: "Fixture" }, identity: null,
  identityResolution: { status: "unresolved", candidates: [], confirmed: false },
  faces: [{ id: "front", side: "front" }], selectedArtworkByFace: {}, backMode: "project-default",
  backModeSelectionPolicy: "automatic", localArtworkIds: [], mpcReferences: [], faceAssociations: [],
};

function optionsFor(markup: string, label: string): string {
  const start = markup.indexOf(`<select aria-label="${label}">`);
  if (start < 0) throw new Error(`Missing select ${label}`);
  return markup.slice(start, markup.indexOf("</select>", start) + "</select>".length);
}

describe("Back Library controls", () => {
  it("reduces library DTOs to immutable references before Project persistence", () => {
    const reference = backLibraryAssetReference(asset);
    expect(reference).toEqual({ assetId: asset.assetId, sha256: asset.sha256, format: asset.format });
    expect(Object.keys(reference).sort()).toEqual(["assetId", "format", "sha256"]);
  });

  it("exposes Project default, per-card mode, original upload, and immutable retired IDs accessibly", () => {
    const inert = vi.fn();
    const markup = renderToStaticMarkup(createElement(BackLibraryControls, {
      assets: [asset, retired, unrelatedRetired],
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
    expect(markup).toContain("Archived.png · PNG · bbbbbbbbbbbb");
    expect(markup).toContain("mantendo seu ID e bytes resolvíveis por Projects existentes");
    const projectChoices = optionsFor(markup, "Verso padrão do Project");
    const cardChoices = optionsFor(markup, "Verso manual da Back Library");
    expect(projectChoices).toContain(`value="${retired.assetId}"`);
    expect(projectChoices).not.toContain(`value="${unrelatedRetired.assetId}"`);
    expect(cardChoices).not.toContain(`value="${retired.assetId}"`);
    expect(cardChoices).not.toContain(`value="${unrelatedRetired.assetId}"`);
  });

  it("keeps a retired current card reference visible while excluding it from unrelated choices", () => {
    const markup = renderToStaticMarkup(createElement(BackLibraryControls, {
      assets: [asset, retired, unrelatedRetired],
      selectedDefault: null,
      selectedCard: { ...card, backMode: "manual", manualBackAsset: { assetId: retired.assetId, sha256: retired.sha256, format: retired.format } },
      disabled: false,
      onAssetsChange: vi.fn(), onDefaultChange: vi.fn(), onCardModeChange: vi.fn(), onManualBackChange: vi.fn(),
    }));
    const projectChoices = optionsFor(markup, "Verso padrão do Project");
    const cardChoices = optionsFor(markup, "Verso manual da Back Library");
    expect(projectChoices).not.toContain(`value="${retired.assetId}"`);
    expect(cardChoices).toContain(`value="${retired.assetId}"`);
    expect(projectChoices).not.toContain(`value="${unrelatedRetired.assetId}"`);
    expect(cardChoices).not.toContain(`value="${unrelatedRetired.assetId}"`);
    expect(projectChoices).toContain(`value="${asset.assetId}"`);
    expect(cardChoices).toContain(`value="${asset.assetId}"`);
  });
});
