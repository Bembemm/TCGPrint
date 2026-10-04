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

    expect(markup).toContain("A4 landscape · Magic Standard");
    expect(markup).toContain("registration three-point/landscape");
    expect(markup).toContain("stroke=\"#111827\"");
    expect(markup).toContain("fill=\"#fecaca\"");
    expect(markup).toContain("legend-reserved");
    expect(markup).toContain('aria-label="Face do compositor"');
    expect(markup).toContain('data-duplex-cut-overlay="front" transform="matrix(1 0 0 1 0 0)"');
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
    expect(markup).toContain('aria-label="Slot 1 carta física 1"');
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
      cardCount: 2,
      cards: cards(2),
      selectedPageNumber: 1,
      onSelectPage: vi.fn(),
      onToggleSkippedSlot: vi.fn(),
    }));

    expect(markup).toContain("SKIP 2");
    expect(markup).toContain("x1=\"40\" y1=\"35\"");
    expect(markup).toContain("capacidade 2");
    expect(markup).not.toContain("stroke=\"#111827\"");
  });

  it("keeps automatically sized slots non-interactive until a fixed grid is chosen", () => {
    const markup = renderToStaticMarkup(createElement(RegistrationLayoutPreview, {
      settings: DEFAULT_PROJECT_SETTINGS,
      cardCount: 1,
      cards: cards(1),
      selectedPageNumber: 1,
      onSelectPage: vi.fn(),
      onToggleSkippedSlot: vi.fn(),
    }));

    expect(markup).toContain("Defina linhas e colunas antes de desativar slots");
    expect(markup).not.toContain("role=\"button\"");
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

    expect(markup).toContain("Página 2 de 2");
    expect(markup).toContain('aria-label="Compositor live frente A4 portrait, página 2 de 2"');
    expect(markup).toContain("Página 2 · cartas 10–10");
    expect(markup).toContain('aria-label="Slot 1 carta física 10"');
    expect(markup).toContain("10");
  });
});
