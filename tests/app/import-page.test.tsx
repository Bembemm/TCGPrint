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
    expect(markup).toContain("CardIdentity permanece estável");
    expect(markup).toContain("Universal Import → Working Set");
    expect(markup).toContain("Scryfall online");
  });

  it("renders the compact phase 5 session workbench without an autosave/project affordance", () => {
    const markup = renderToStaticMarkup(createElement(CardIdentityWorkbench, { files: [], text: "", choices: {} }));
    expect(markup).toContain("Working Set da sessão");
    expect(markup).toContain("Resolver identidades");
    expect(markup).toContain("Universal Import → Working Set");
    expect(markup).not.toMatch(/autosave|project save|salvar projeto/i);
  });
});
