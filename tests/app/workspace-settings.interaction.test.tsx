// @vitest-environment jsdom
import { useState } from "react";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultRegistrationConfig, type RegistrationConfig } from "../../core/registration";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import ProjectSettingsControls from "../../src/app/project-settings-controls";
import WorkspaceShell, { WORKSPACE_SECTIONS, type WorkspaceSection } from "../../src/app/workspace-shell";

afterEach(cleanup);

function SettingsControls() {
  const [pageOrientation, setPageOrientation] = useState<"portrait" | "landscape">("portrait");
  const [bleedMm, setBleedMm] = useState("0.625");
  const [roundedCorners, setRoundedCorners] = useState(false);
  const [exportContentMode, setExportContentMode] = useState(DEFAULT_PROJECT_SETTINGS.exportContentMode);
  const [registration, setRegistration] = useState<RegistrationConfig>(() => createDefaultRegistrationConfig("none", "portrait"));
  const props = {
    section: "all" as const,
    paperFormat: DEFAULT_PROJECT_SETTINGS.paperFormat,
    cardFormat: DEFAULT_PROJECT_SETTINGS.cardFormat,
    bleedMm,
    roundedCorners,
    trimGuideEnabled: false,
    trimGuideExtentMm: "1",
    trimGuideColor: "blue" as const,
    externalGuideEnabled: false,
    externalGuideStrokeWidthPt: "0.3",
    externalGuideColor: "black" as const,
    pageOrientation,
    cardOrientation: "portrait" as const,
    marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
    horizontalGapMm: 0,
    verticalGapMm: 0,
    registration,
    layoutRows: "2",
    layoutColumns: "3",
    templateGeometryActive: false,
    skippedSlotIndices: [],
    exportContentMode,
    missingBackPolicy: DEFAULT_PROJECT_SETTINGS.missingBackPolicy,
    duplexFlipMode: DEFAULT_PROJECT_SETTINGS.duplexFlipMode,
    disabled: false,
    onBleedMmChange: setBleedMm,
    onRoundedCornersChange: setRoundedCorners,
    onTrimGuideEnabledChange: () => undefined,
    onTrimGuideExtentMmChange: () => undefined,
    onTrimGuideColorChange: () => undefined,
    onExternalGuideEnabledChange: () => undefined,
    onExternalGuideStrokeWidthPtChange: () => undefined,
    onExternalGuideColorChange: () => undefined,
    onPageOrientationChange: setPageOrientation,
    onCardOrientationChange: () => undefined,
    onMarginChange: () => undefined,
    onHorizontalGapChange: () => undefined,
    onVerticalGapChange: () => undefined,
    onRegistrationChange: setRegistration,
    onLayoutRowsChange: () => undefined,
    onLayoutColumnsChange: () => undefined,
    onExportContentModeChange: setExportContentMode,
    onMissingBackPolicyChange: () => undefined,
    onDuplexFlipModeChange: () => undefined,
  } as unknown as Parameters<typeof ProjectSettingsControls>[0];
  return <ProjectSettingsControls {...props} />;
}

function settingsWorkspace() {
  const sections = Object.fromEntries(WORKSPACE_SECTIONS.map(({ id }) => [id, <p key={id}>{id}</p>])) as Record<WorkspaceSection, ReactNode>;
  return <WorkspaceShell
    sections={sections}
    preview={<div />}
    hasCards
    sharedPanel={{
      id: "workspace-settings-export-panel",
      sections: ["settings", "export"],
      content: (activeSection: WorkspaceSection) => <>
        <div hidden={activeSection !== "settings"}><SettingsControls /></div>
        <div hidden={activeSection !== "export"}><p>PDF e conferência final</p></div>
      </>,
    }}
  />;
}

describe("workspace settings sections", () => {
  it("keeps Layout, PDF, and cut settings together and preserves their drafts across Exportar", async () => {
    const user = userEvent.setup();
    render(settingsWorkspace());

    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(screen.getByText("Posicionamento, slots e margens"));
    expect(screen.getByRole("spinbutton", { name: "Linhas da grade (opcional)" })).toBeInTheDocument();
    const orientation = screen.getByRole("combobox", { name: "Orientação da página" });
    await user.selectOptions(orientation, "landscape");
    expect(orientation).toHaveValue("landscape");
    const mode = screen.getByRole("combobox", { name: "Modo de exportação" });
    await user.selectOptions(mode, "duplex");
    expect(mode).toHaveValue("duplex");
    const bleed = screen.getByRole("spinbutton", { name: "Bleed externo (mm)" });
    await user.clear(bleed);
    await user.type(bleed, "1.25");
    await user.click(screen.getByRole("checkbox", { name: /Cantos arredondados/ }));

    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    expect(screen.getByText("PDF e conferência final")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    expect(screen.getByRole("combobox", { name: "Orientação da página" })).toHaveValue("landscape");
    expect(screen.getByRole("combobox", { name: "Modo de exportação" })).toHaveValue("duplex");
    expect(screen.getByRole("spinbutton", { name: "Bleed externo (mm)" })).toHaveValue(1.25);
    expect(screen.getByRole("checkbox", { name: /Cantos arredondados/ })).toBeChecked();
  });

  it("keeps custom registration geometry draft when navigating Configurações, Exportar, and Cartas", async () => {
    const user = userEvent.setup();
    render(settingsWorkspace());
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(screen.getByText("Marcas de registro"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Registration type" }), "custom");
    await user.click(screen.getByText("Registration e geometria custom"));
    const geometry = screen.getByRole("textbox", { name: /Custom geometry JSON/ });
    await user.clear(geometry);
    fireEvent.change(geometry, { target: { value: "{bad draft" } });
    expect(geometry).toHaveValue("{bad draft");

    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    expect(screen.getByRole("textbox", { name: /Custom geometry JSON/ })).toHaveValue("{bad draft");
  });
});
