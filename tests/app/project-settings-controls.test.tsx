import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProjectSettingsControls from "../../src/app/project-settings-controls";

describe("ProjectSettingsControls", () => {
  it("disables every persisted setting while a Project recovery decision is pending", () => {
    const inert = vi.fn();
    const markup = renderToStaticMarkup(createElement(ProjectSettingsControls, {
      bleedMm: "0.625",
      roundedCorners: false,
      trimGuideEnabled: true,
      trimGuideExtentMm: "2",
      trimGuideColor: "blue",
      externalGuideEnabled: true,
      externalGuideStrokeWidthPt: "0.3",
      externalGuideColor: "black",
      disabled: true,
      onBleedMmChange: inert,
      onRoundedCornersChange: inert,
      onTrimGuideEnabledChange: inert,
      onTrimGuideExtentMmChange: inert,
      onTrimGuideColorChange: inert,
      onExternalGuideEnabledChange: inert,
      onExternalGuideStrokeWidthPtChange: inert,
      onExternalGuideColorChange: inert,
    }));

    const controls = [...markup.matchAll(/<(?:input|select)\b([^>]*)>/g)];
    expect(controls).toHaveLength(8);
    expect(controls.every(([, attributes]) => attributes.includes("disabled=\"\""))).toBe(true);
    expect(markup).toContain("Bleed externo (mm)");
    expect(markup).toContain("Cantos arredondados");
    expect(markup).toContain("Guia de corte no trim");
    expect(markup).toContain("Guia externa de corte");
  });
});
