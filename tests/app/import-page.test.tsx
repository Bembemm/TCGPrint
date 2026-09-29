import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "../../src/app/page";
import CardIdentityWorkbench from "../../src/app/card-identity-workbench";

describe("import workbench page", () => {
  it("exposes paste, file, folder, report and local PDF controls", () => {
    const markup = renderToStaticMarkup(createElement(HomePage));
    expect(markup).toContain("Cole uma decklist");
    expect(markup).toContain("Selecionar arquivos");
    expect(markup).toContain("Selecionar pasta");
    expect(markup).toContain("Arraste arquivos aqui");
    expect(markup).toContain("Criar preview");
    expect(markup).toMatch(/type=\"file\" multiple=\"\"[^>]*>/);
    expect(markup).toContain("webkitdirectory=\"\"");
    expect(markup).toContain("Fase 7B · Projects e Working Set");
    expect(markup).toContain("Card Details separa origem/hints importados da identidade aplicada");
    expect(markup).toContain("Universal Import → Working Set");
    expect(markup).toContain("Scryfall online");
  });

  it("renders the session workbench with explicit Project save controls and no autosave", () => {
    const markup = renderToStaticMarkup(createElement(CardIdentityWorkbench, { files: [], text: "", choices: {} }));
    expect(markup).toContain("Projects e Working Set");
    expect(markup).toContain("Criar Project vazio");
    expect(markup).toContain("Salvar");
    expect(markup).toContain("Resolver identidades");
    expect(markup).toContain("Universal Import → Working Set");
    expect(markup).not.toMatch(/autosave|autosaving/i);
  });
});
