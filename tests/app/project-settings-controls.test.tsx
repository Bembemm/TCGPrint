import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProjectSettingsControls from "../../src/app/project-settings-controls";
import { createDefaultRegistrationConfig } from "../../core/registration";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";

describe("ProjectSettingsControls", () => {
  it("disables every persisted setting while a Project recovery decision is pending", () => {
    const inert = vi.fn();
    const markup = renderToStaticMarkup(createElement(ProjectSettingsControls, {
      paperFormat: DEFAULT_PROJECT_SETTINGS.paperFormat,
      cardFormat: DEFAULT_PROJECT_SETTINGS.cardFormat,
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
      exportContentMode: "duplex",
      missingBackPolicy: "block",
      duplexFlipMode: "short-edge",
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
      onExportContentModeChange: inert,
      onMissingBackPolicyChange: inert,
      onDuplexFlipModeChange: inert,
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
    expect(markup).not.toContain("Modo de exportação");
    expect(markup).toContain("Bleed &amp; Cantos");
    expect(markup).toContain("Guias");
    expect(markup).toContain("Política para cartas sem verso");
    expect(markup).toContain("Short edge");
  });

  it("locks manual grid dimensions when an immutable template geometry is active", () => {
    const inert = vi.fn();
    const markup = renderToStaticMarkup(createElement(ProjectSettingsControls, {
      paperFormat: DEFAULT_PROJECT_SETTINGS.paperFormat,
      cardFormat: DEFAULT_PROJECT_SETTINGS.cardFormat,
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
      activeOccupiedSlotIndex: 1,
      exportContentMode: "front-only",
      missingBackPolicy: "use-project-default",
      duplexFlipMode: "long-edge",
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
      onDeactivateActiveSlot: inert,
      onExportContentModeChange: inert,
      onMissingBackPolicyChange: inert,
      onDuplexFlipModeChange: inert,
    }));

    expect(markup).toContain("Grade bloqueada pela geometria do template");
    expect(markup).toContain("Desativar slot da carta ativa");
    expect(markup).toMatch(/<label>Linhas da grade \(opcional\)<input type="number"[^>]*disabled=""[^>]*value="2"/);
    expect(markup).toMatch(/<label>Colunas da grade \(opcional\)<input type="number"[^>]*disabled=""[^>]*value="3"/);
  });
});
