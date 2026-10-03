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
    expect(markup).toContain("Diagnóstico da importação");
    expect(markup).not.toContain("Criar preview");
    expect(markup).toMatch(/type=\"file\" multiple=\"\"[^>]*>/);
    expect(markup).toContain("webkitdirectory=\"\"");
    expect(markup).toContain('aria-label="Seções de trabalho"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("Entradas");
    expect(markup).toContain("Adicionar cartas");
    expect(markup).not.toContain("Resolver identidades");
    expect(markup).not.toContain("Universal Import → Working Set");
    expect(markup).toContain("Scryfall · verificando");
  });

  it("renders the session workbench with automatic Project saves and manual retry controls", () => {
    const markup = renderToStaticMarkup(createElement(CardIdentityWorkbench, { files: [], text: "", choices: {} }));
    expect(markup).toContain("Projects");
    expect(markup).toContain("Criar Project vazio");
    expect(markup).toContain("Salvar agora");
    expect(markup).toMatch(/autosave/i);
    expect(markup).toContain("Adicionar cartas");
    expect(markup).not.toContain("Resolver identidades");
  });
});
