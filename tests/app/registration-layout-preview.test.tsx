import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import { createDefaultRegistrationConfig } from "../../core/registration";
import RegistrationLayoutPreview from "../../src/app/registration-layout-preview";
import type { WorkingCard } from "../../core/cards/types";

function cards(quantity: number, name = "Fixture card"): WorkingCard[] {
  return [{
    id: name,
    quantity,
    order: 0,
    importSource: { sourceId: `source:${name}`, importKind: "fixture", entryKind: "card" },
    identityHints: { name },
    identity: null,
    identityResolution: { status: "unresolved", candidates: [], confirmed: false },
    faces: [{ id: "front", side: "front" }],
    selectedArtworkByFace: {},
    backMode: "project-default",
    backModeSelectionPolicy: "automatic",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  }];
}

describe("registration layout preview", () => {
  it("shows registration marks and reserved zones with independent page, card, and registration orientation", () => {
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      pageOrientation: "landscape" as const,
      cardOrientation: "portrait" as const,
      registration: createDefaultRegistrationConfig("three-point", "landscape"),
      layout: { skippedSlotIndices: [] },
    };
    const markup = renderToStaticMarkup(createElement(RegistrationLayoutPreview, {
      settings,
      cardCount: 1,
      cards: cards(1),
      selectedPageNumber: 1,
      onSelectPage: vi.fn(),
      onToggleSkippedSlot: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Compositor live frente A4 landscape, página 1 de 1"');
    expect(markup).toContain("stroke=\"#111827\"");
    expect(markup).toContain("fill=\"#fecaca\"");
    expect(markup).toContain("data-compositor-layer=\"registration\"");
    expect(markup).toContain("data-compositor-layer=\"reserved\"");
    expect(markup).not.toContain("registration-preview-legend");
    expect(markup).toContain('aria-label="Face do compositor"');
    expect(markup).not.toContain('data-compositor-layer="cut"');
  });

  it("shows semantic DFC labeling and the upright back preview control", () => {
    const dfc = cards(1, "Preview DFC").map((entry) => ({
      ...entry,
      identity: {
        id: "scryfall:oracle:preview-dfc", provider: "scryfall", name: "Front // Back", resolutionMethod: "manual" as const, confidence: 1,
        metadata: { layout: "transform", faces: [{ name: "Front" }, { name: "Back" }] },
      },
      faces: [{ id: "front" as const, side: "front" as const, name: "Front" }, { id: "back" as const, side: "back" as const, name: "Back" }],
      backMode: "auto" as const,
    }));
    const markup = renderToStaticMarkup(createElement(RegistrationLayoutPreview, {
      settings: { ...DEFAULT_PROJECT_SETTINGS, layout: { rows: 1, columns: 1, skippedSlotIndices: [] } },
      cardCount: 1,
      cards: dfc,
      selectedPageNumber: 1,
      onSelectPage: vi.fn(),
      onToggleSkippedSlot: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Compositor live"');
    expect(markup).toContain('aria-label="Face do compositor"');
    expect(markup).toContain("Front // Back · DFC");
    expect(markup).toContain('aria-label="Slot 1 · carta física 1 · Front // Back · cópia 1 de 1"');
  });

  it("renders exact template positions and skipped identities while registration none draws no marks", () => {
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      paperFormat: { name: "Physical test paper", widthMm: 100, heightMm: 100 },
      cardFormat: { id: "physical-test-card", name: "Physical test card", widthMm: 20, heightMm: 30 },
      registration: { type: "none" as const, orientation: "landscape" as const },
      layout: {
        skippedSlotIndices: [1],
        templateGeometry: {
          orientation: "portrait" as const,
          cardOrientation: "portrait" as const,
          pageSizeMm: { widthMm: 100, heightMm: 100 },
          cardSizeMm: { widthMm: 20, heightMm: 30 },
          rows: 1,
          columns: 3,
          slots: [
            { index: 0, row: 0, column: 0, xMm: 10, yMm: 35 },
            { index: 1, row: 0, column: 1, xMm: 40, yMm: 35 },
            { index: 2, row: 0, column: 2, xMm: 70, yMm: 35 },
          ],
        },
      },
    };
    const markup = renderToStaticMarkup(createElement(RegistrationLayoutPreview, {
      settings,
      cardCount: 1,
      cards: cards(1),
      selectedPageNumber: 1,
      onSelectPage: vi.fn(),
      onToggleSkippedSlot: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Slot 2 desativado"');
    expect(markup).not.toContain(">SKIP 2<");
    expect(markup).not.toMatch(/<text[^>]*>\s*2\s*<\/text>/);
    expect(markup).toContain('aria-label="Slot 3 vazio"');
    expect(markup).toContain("x1=\"40\" y1=\"35\"");
    expect(markup).not.toContain("capacidade 2");
    expect(markup).not.toContain("stroke=\"#111827\"");
  });

  it("keeps automatic empty slots non-interactive while assigned physical cards remain selectable", () => {
    const markup = renderToStaticMarkup(createElement(RegistrationLayoutPreview, {
      settings: DEFAULT_PROJECT_SETTINGS,
      cardCount: 1,
      cards: cards(1),
      selectedPageNumber: 1,
      onSelectPage: vi.fn(),
      onToggleSkippedSlot: vi.fn(),
    }));

    expect(markup).not.toContain("Defina linhas e colunas antes de desativar slots");
    expect(markup).toContain('aria-label="Compositor live"');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('data-physical-card-index="0"');
    expect(markup).toContain('data-copy-number="1"');
  });

  it("previews the selected PDF page for a multi-page card list", () => {
    const markup = renderToStaticMarkup(createElement(RegistrationLayoutPreview, {
      settings: { ...DEFAULT_PROJECT_SETTINGS, bleedMm: 0 },
      cardCount: 10,
      cards: cards(10, "Page card"),
      selectedPageNumber: 2,
      onSelectPage: vi.fn(),
      onToggleSkippedSlot: vi.fn(),
    }));

    expect(markup).toContain("2 / 2");
    expect(markup).toContain('aria-label="Compositor live frente A4 portrait, página 2 de 2"');
    expect(markup).toContain("Página 2 · cartas 10–10");
    expect(markup).toContain('aria-label="Slot 1 · carta física 10 · Page card · cópia 10 de 10"');
    expect(markup).toContain("10");
  });
});
