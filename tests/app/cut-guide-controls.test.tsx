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
      externalEnabled: false,
      externalStrokeWidthPt: "0.3",
      onTrimEnabledChange: inert,
      onTrimExtentMmChange: inert,
      onExternalEnabledChange: inert,
      onExternalStrokeWidthPtChange: inert,
    }));

    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup).toContain("Trim Guide");
    expect(markup).toContain("External Cut Guide");
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).toMatch(/type="number"[^>]*disabled=""/);
    expect(markup).toContain("value=\"1\" selected=\"\">1 mm</option>");
    expect(markup).toContain("value=\"full\">full</option>");
    expect(markup).toContain("stroke width (pt)");
  });

  it("enables only the selected system's value control", () => {
    const markup = renderToStaticMarkup(createElement(CutGuideControls, {
      trimEnabled: true,
      trimExtentMm: "5",
      externalEnabled: false,
      externalStrokeWidthPt: "0.3",
      onTrimEnabledChange: inert,
      onTrimExtentMmChange: inert,
      onExternalEnabledChange: inert,
      onExternalStrokeWidthPtChange: inert,
    }));

    expect(markup).toContain("value=\"5\" selected=\"\">5 mm</option>");
    expect(markup).not.toMatch(/<select[^>]*disabled=""/);
    expect(markup).toMatch(/type="number"[^>]*disabled=""/);
  });
});
