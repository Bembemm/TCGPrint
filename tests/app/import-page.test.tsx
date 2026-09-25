import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "../../src/app/page";

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
  });
});
