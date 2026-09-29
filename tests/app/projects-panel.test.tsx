import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import ProjectsPanel from "../../src/app/projects-panel";

describe("Projects panel", () => {
  it("shows the empty Project controls and the initial unsaved session state", () => {
    const markup = renderToStaticMarkup(createElement(ProjectsPanel, {
      cards: [],
      settings: DEFAULT_PROJECT_SETTINGS,
      onProjectOpen: vi.fn(),
      disabled: false,
    }));

    expect(markup).toContain('aria-label="Projects"');
    expect(markup).toContain("Criar Project vazio");
    expect(markup).toContain("Salvar");
    expect(markup).toContain("Dirty");
    expect(markup).toContain("Nenhum Project aberto");
  });
});
