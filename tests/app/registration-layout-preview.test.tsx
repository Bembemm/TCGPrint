import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import { createDefaultRegistrationConfig } from "../../core/registration";
import RegistrationLayoutPreview from "../../src/app/registration-layout-preview";

describe("registration layout preview", () => {
  it("shows registration marks and reserved zones with independent page, card, and registration orientation", () => {
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      pageOrientation: "landscape" as const,
      cardOrientation: "portrait" as const,
      registration: createDefaultRegistrationConfig("three-point", "landscape"),
      layout: { rows: 1, columns: 1, skippedSlotIndices: [] },
    };
    const markup = renderToStaticMarkup(createElement(RegistrationLayoutPreview, {
      settings,
      cardCount: 1,
      selectedPageNumber: 1,
      onSelectPage: vi.fn(),
      onToggleSkippedSlot: vi.fn(),
    }));

    expect(markup).toContain("A4 landscape · Magic Standard");
    expect(markup).toContain("registration three-point/landscape");
    expect(markup).toContain("stroke=\"#111827\"");
    expect(markup).toContain("fill=\"#fecaca\"");
    expect(markup).toContain("legend-reserved");
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
      selectedPageNumber: 2,
      onSelectPage: vi.fn(),
      onToggleSkippedSlot: vi.fn(),
    }));

    expect(markup).toContain("página PDF 2/2 · cartas 10–10");
    expect(markup).toContain("aria-label=\"Página PDF do preview físico\"");
    expect(markup).toContain('aria-label="Slot 1 carta 10"');
    expect(markup).toContain(">10</text>");
  });
});
