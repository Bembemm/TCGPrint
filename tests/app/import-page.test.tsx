import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "../../src/app/page";
import CardIdentityWorkbench from "../../src/app/card-identity-workbench";

describe("import workbench page", () => {
  it("exposes paste, file, folder, report and local PDF controls", () => {
    const markup = renderToStaticMarkup(createElement(HomePage));
    expect(markup).toContain("Cole uma decklist ou URL");
    expect(markup).toContain("URLs de sites suportados e arquivos diretos");
    expect(markup).toContain("Selecionar arquivos");
    expect(markup).toContain("Selecionar pasta");
    expect(markup).toContain("Arraste arquivos aqui");
    expect(markup).toContain("Analisar importação");
    expect(markup).not.toContain("Criar preview");
    expect(markup).toMatch(/type=\"file\" multiple=\"\"[^>]*>/);
    expect(markup).toContain("webkitdirectory=\"\"");
    expect(markup).toContain('aria-label="Seções de trabalho"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('id="workspace-tab-settings"');
    expect(markup).toContain('id="workspace-tab-export"');
    expect(markup).not.toContain('id="workspace-tab-artwork"');
    expect(markup).toContain("Adicionar cartas");
    expect(markup).toContain("Adicionar cartas");
    expect(markup).not.toContain("Resolver identidades");
    expect(markup).not.toContain("Universal Import → Working Set");
    expect(markup).toContain("Scryfall · verificando");
  });

  it("renders the Project session in the workspace header", () => {
    const markup = renderToStaticMarkup(createElement(CardIdentityWorkbench, { files: [], text: "", choices: {} }));
    expect(markup).toContain('aria-label="Project ativo"');
    expect(markup).toContain("Projeto não salvo");
    expect(markup).toContain("Salvar como projeto");
    expect(markup).toContain("Abrir menu do Project");
    expect(markup).not.toContain("Criar Project vazio");
    expect(markup).not.toContain("Dirty");
    expect(markup).toContain("Adicionar cartas");
    expect(markup).not.toContain("Resolver identidades");
  });
});
