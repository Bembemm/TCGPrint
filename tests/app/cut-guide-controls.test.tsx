import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CutGuideControls from "../../src/app/cut-guide-controls";

const inert = () => undefined;

describe("CutGuideControls", () => {
  it("renders independent OFF checkboxes and disables each guide's settings", () => {
    const markup = renderToStaticMarkup(createElement(CutGuideControls, {
      trimEnabled: false,
      trimExtentMm: "1",
      trimColor: "blue",
      externalEnabled: false,
      externalStrokeWidthPt: "0.3",
      externalColor: "black",
      onTrimEnabledChange: inert,
      onTrimExtentMmChange: inert,
      onTrimColorChange: inert,
      onExternalEnabledChange: inert,
      onExternalStrokeWidthPtChange: inert,
      onExternalColorChange: inert,
    }));

    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup).toContain("Guia de corte no trim");
    expect(markup).toContain("Guia externa de corte");
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).toMatch(/type="number"[^>]*disabled=""/);
    expect(markup).toContain("value=\"1\" selected=\"\">1 mm</option>");
    expect(markup).toContain("value=\"full\">full</option>");
    expect(markup).toContain("Espessura da guia externa (pt)");
  });

  it("enables only the selected system's value control", () => {
    const markup = renderToStaticMarkup(createElement(CutGuideControls, {
      trimEnabled: true,
      trimExtentMm: "5",
      trimColor: "blue",
      externalEnabled: false,
      externalStrokeWidthPt: "0.3",
      externalColor: "black",
      onTrimEnabledChange: inert,
      onTrimExtentMmChange: inert,
      onTrimColorChange: inert,
      onExternalEnabledChange: inert,
      onExternalStrokeWidthPtChange: inert,
      onExternalColorChange: inert,
    }));

    expect(markup).toContain("value=\"5\" selected=\"\">5 mm</option>");
    expect([...markup.matchAll(/<select\b([^>]*)>/g)].filter(([, attributes]) => !attributes.includes("disabled="))).toHaveLength(2);
    expect(markup).toMatch(/type="number"[^>]*disabled=""/);
  });

  it("shows independent Portuguese color selectors with the closed six-color palette", () => {
    const props = {
      trimEnabled: false,
      trimExtentMm: "1",
      trimColor: "blue",
      externalEnabled: true,
      externalStrokeWidthPt: "0.3",
      externalColor: "black",
      onTrimEnabledChange: inert,
      onTrimExtentMmChange: inert,
      onTrimColorChange: inert,
      onExternalEnabledChange: inert,
      onExternalStrokeWidthPtChange: inert,
      onExternalColorChange: inert,
    } as Parameters<typeof CutGuideControls>[0];
    const markup = renderToStaticMarkup(createElement(CutGuideControls, props));

    expect(markup).toContain("Guia de corte no trim");
    expect(markup).toContain("Guia externa de corte");
    expect(markup).toContain("Cor da guia no trim");
    expect(markup).toContain("Cor da guia externa");
    const selects = [...markup.matchAll(/<select\b([^>]*)>(.*?)<\/select>/g)];
    const colorSelects = selects.filter(([, , options]) => options.includes("Vermelho") && options.includes("Branco"));
    expect(colorSelects).toHaveLength(2);
    expect(colorSelects[0][1]).toContain("disabled=");
    expect(colorSelects[1][1]).not.toContain("disabled=");
    for (const [, , options] of colorSelects) {
      expect(options.match(/<option\b/g)).toHaveLength(6);
      expect(options).toContain("value=\"red\"");
      expect(options).toContain("value=\"pink\"");
      expect(options).toContain("value=\"green\"");
      expect(options).toContain("value=\"blue\"");
      expect(options).toContain("value=\"black\"");
      expect(options).toContain("value=\"white\"");
    }
  });

  it("renders a persisted custom trim extent without changing its value", () => {
    const markup = renderToStaticMarkup(createElement(CutGuideControls, {
      trimEnabled: true,
      trimExtentMm: "2.5",
      trimColor: "green",
      externalEnabled: true,
      externalStrokeWidthPt: "0.7",
      externalColor: "white",
      onTrimEnabledChange: inert,
      onTrimExtentMmChange: inert,
      onTrimColorChange: inert,
      onExternalEnabledChange: inert,
      onExternalStrokeWidthPtChange: inert,
      onExternalColorChange: inert,
    }));

    expect(markup).toContain('<option value="2.5" selected="">2.5 mm</option>');
    expect(markup).toContain('<option value="green" selected="">Verde</option>');
    expect(markup).toContain('<option value="white" selected="">Branco</option>');
  });
});
