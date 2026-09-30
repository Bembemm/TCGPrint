import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProjectSettingsControls from "../../src/app/project-settings-controls";
import { createDefaultRegistrationConfig } from "../../core/registration";

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
      pageOrientation: "portrait",
      cardOrientation: "portrait",
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      horizontalGapMm: 0,
      verticalGapMm: 0,
      registration: createDefaultRegistrationConfig("none", "portrait"),
      layoutRows: "",
      layoutColumns: "",
      templateGeometryActive: false,
      skippedSlotIndices: [],
      disabled: true,
      onBleedMmChange: inert,
      onRoundedCornersChange: inert,
      onTrimGuideEnabledChange: inert,
      onTrimGuideExtentMmChange: inert,
      onTrimGuideColorChange: inert,
      onExternalGuideEnabledChange: inert,
      onExternalGuideStrokeWidthPtChange: inert,
      onExternalGuideColorChange: inert,
      onPageOrientationChange: inert,
      onCardOrientationChange: inert,
      onMarginChange: inert,
      onHorizontalGapChange: inert,
      onVerticalGapChange: inert,
      onRegistrationChange: inert,
      onLayoutRowsChange: inert,
      onLayoutColumnsChange: inert,
    }));

    const controls = [...markup.matchAll(/<(?:input|select)\b([^>]*)>/g)];
    expect(controls.length).toBeGreaterThanOrEqual(12);
    expect(controls.every(([, attributes]) => attributes.includes("disabled=\"\""))).toBe(true);
    expect(markup).toContain("Bleed externo (mm)");
    expect(markup).toContain("Cantos arredondados");
    expect(markup).toContain("Guia de corte no trim");
    expect(markup).toContain("Guia externa de corte");
    expect(markup).toContain("Orientação da página");
    expect(markup).toContain("Orientação do registration");
  });

  it("locks manual grid dimensions when an immutable template geometry is active", () => {
    const inert = vi.fn();
    const markup = renderToStaticMarkup(createElement(ProjectSettingsControls, {
      bleedMm: "0.625",
      roundedCorners: false,
      trimGuideEnabled: false,
      trimGuideExtentMm: "1",
      trimGuideColor: "blue",
      externalGuideEnabled: false,
      externalGuideStrokeWidthPt: "0.3",
      externalGuideColor: "black",
      pageOrientation: "portrait",
      cardOrientation: "portrait",
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      horizontalGapMm: 0,
      verticalGapMm: 0,
      registration: createDefaultRegistrationConfig("none", "portrait"),
      layoutRows: "2",
      layoutColumns: "3",
      templateGeometryActive: true,
      skippedSlotIndices: [],
      disabled: false,
      onBleedMmChange: inert,
      onRoundedCornersChange: inert,
      onTrimGuideEnabledChange: inert,
      onTrimGuideExtentMmChange: inert,
      onTrimGuideColorChange: inert,
      onExternalGuideEnabledChange: inert,
      onExternalGuideStrokeWidthPtChange: inert,
      onExternalGuideColorChange: inert,
      onPageOrientationChange: inert,
      onCardOrientationChange: inert,
      onMarginChange: inert,
      onHorizontalGapChange: inert,
      onVerticalGapChange: inert,
      onRegistrationChange: inert,
      onLayoutRowsChange: inert,
      onLayoutColumnsChange: inert,
    }));

    expect(markup).toContain("Grade bloqueada pela geometria do template");
    expect(markup).toMatch(/<label>Linhas da grade \(opcional\)<input type="number"[^>]*disabled=""[^>]*value="2"/);
    expect(markup).toMatch(/<label>Colunas da grade \(opcional\)<input type="number"[^>]*disabled=""[^>]*value="3"/);
  });
});
