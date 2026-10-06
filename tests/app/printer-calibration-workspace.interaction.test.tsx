// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentitySideCalibration } from "../../core/calibration";
import type { PrinterProfileSnapshot } from "../../core/calibration";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import PrinterCalibrationPanel from "../../src/app/printer-calibration-panel";
import WorkspaceShell, { WORKSPACE_SECTIONS } from "../../src/app/workspace-shell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const profile: PrinterProfileSnapshot = {
  id: "printer-test",
  name: "Impressora de teste",
  front: createIdentitySideCalibration(),
  back: createIdentitySideCalibration(),
  paperSize: "A4",
  paperWidthMm: 210,
  paperHeightMm: 297,
  pageOrientation: "portrait",
  duplexMode: "single-sided",
  physicalValidationStatus: "software-only",
  version: 2,
  profileHash: "a".repeat(64),
};

function calibrationWorkspace() {
  const calibrationPanel = <PrinterCalibrationPanel
        paperFormat={DEFAULT_PROJECT_SETTINGS.paperFormat}
        pageOrientation="portrait"
        printerProfileSelection={profile}
        printerDuplexMode="single-sided"
        exportContentMode="duplex"
        duplexFlipMode="long-edge"
        disabled={false}
        onProjectSelectionChange={vi.fn()}
      />;
  return <WorkspaceShell
    sections={{ cards: <p>cards</p>, settings: <p>settings</p>, export: <p>export</p> }}
    preview={<div />}
    hasCards
    sharedPanel={{
      id: "workspace-settings-export-panel",
      sections: ["settings", "export"],
      content: (activeSection: (typeof WORKSPACE_SECTIONS)[number]["id"]) => <>
        <div hidden={activeSection !== "settings"}>{calibrationPanel}</div>
        <div hidden={activeSection !== "export"}><p>PDF export surface</p></div>
      </>,
    }}
  />;
}

describe("calibration wizard stages", () => {
  it("supports keyboard stage navigation, preserves calibration drafts, and tabs into the active panel", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ profiles: [profile] }), { status: 200 })));
    render(calibrationWorkspace());
    await user.click(screen.getByRole("tab", { name: "Configurações" }));

    const profileStage = screen.getByRole("tab", { name: "Profile" });
    profileStage.focus();
    expect(profileStage).toHaveFocus();
    await user.keyboard("{ArrowRight}");

    const adjustmentStage = screen.getByRole("tab", { name: "Ajuste" });
    expect(adjustmentStage).toHaveFocus();
    expect(adjustmentStage).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Ajuste" })).toHaveAttribute("data-stage", "2");
    expect(within(screen.getByRole("tablist", { name: "Etapas do Calibration Wizard" })).getAllByRole("tab").filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);
    await user.clear(screen.getByLabelText("X offset (mm)"));
    await user.type(screen.getByLabelText("X offset (mm)"), "1.234");

    adjustmentStage.focus();
    await user.keyboard("{ArrowRight}");
    const measurementsStage = screen.getByRole("tab", { name: "Medições" });
    expect(measurementsStage).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Medições" })).toHaveAttribute("data-stage", "3");
    const sessionId = (screen.getByLabelText("Fixture session ID") as HTMLInputElement).value;
    await user.type(screen.getAllByLabelText("X (mm)")[0], "0.125");

    measurementsStage.focus();
    await user.keyboard("{End}");
    const verificationStage = screen.getByRole("tab", { name: "Verificação" });
    expect(verificationStage).toHaveFocus();
    expect(verificationStage).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Verificação" })).toHaveAttribute("data-stage", "4");
    expect(screen.getByRole("button", { name: /Gerar Verification PDF/ })).toBeInTheDocument();

    verificationStage.focus();
    await user.keyboard("{Home}");
    expect(profileStage).toHaveFocus();
    expect(profileStage).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Profile" })).toHaveAttribute("data-stage", "1");
    expect(screen.getByRole("combobox", { name: "Printer profile" })).toHaveValue(profile.id);

    await user.keyboard("{ArrowLeft}");
    expect(verificationStage).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Verificação" })).toHaveAttribute("data-stage", "4");
    expect(within(screen.getByRole("tablist", { name: "Etapas do Calibration Wizard" })).getAllByRole("tab").filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);

    await user.keyboard("{ArrowLeft}");
    await user.keyboard("{ArrowLeft}");
    expect(adjustmentStage).toHaveFocus();
    expect(screen.getByLabelText("X offset (mm)")).toHaveValue("1.234");
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByLabelText("X (mm)")[0]).toHaveValue("0.125");
    expect((screen.getByLabelText("Fixture session ID") as HTMLInputElement).value).toBe(sessionId);

    await user.keyboard("{ArrowLeft}");
    await user.tab();
    expect(screen.getByRole("tabpanel", { name: "Ajuste" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Simple · X/Y/Rotation" })).toHaveFocus();
    expect(document.activeElement).not.toBe(adjustmentStage);
  });

  it("shows distinct Profile, Ajuste, Medições, and Verificação content", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ profiles: [profile] }), { status: 200 })));
    render(calibrationWorkspace());
    await user.click(screen.getByRole("tab", { name: "Configurações" }));

    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox", { name: "Printer profile" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "X offset (mm)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Fixture session ID" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verification PDF/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Ajuste" }));
    expect(screen.getByLabelText("X offset (mm)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simple · X/Y/Rotation" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Opacidade do verso/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Fixture session ID" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Advanced · Scale/Skew" }));
    expect(screen.getByLabelText("Scale X")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Medições" }));
    expect(screen.getByRole("button", { name: /Gerar Calibration PDF/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Fixture session ID")).toBeInTheDocument();
    expect(screen.getAllByLabelText("X (mm)").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Calcular transformação Advanced" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Erro observado por target/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Gerar Verification PDF/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Verificação" }));
    expect(screen.getByRole("button", { name: /Gerar Verification PDF/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Confirmo que medi estes residuals fisicamente/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Gerar Calibration PDF/ })).not.toBeInTheDocument();
  });

  it("preserves calibration draft, mode, face, measurements, opacity, and session across stage and sidebar changes", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ profiles: [profile] }), { status: 200 })));
    render(calibrationWorkspace());
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(screen.getByRole("tab", { name: "Ajuste" }));
    await user.click(screen.getByRole("button", { name: "Advanced · Scale/Skew" }));
    await user.click(screen.getByRole("button", { name: "Front" }));
    await user.clear(screen.getByLabelText("X offset (mm)"));
    await user.type(screen.getByLabelText("X offset (mm)"), "1.234");
    fireEvent.change(screen.getByRole("slider"), { target: { value: "65" } });

    await user.click(screen.getByRole("tab", { name: "Medições" }));
    const sessionId = (screen.getByLabelText("Fixture session ID") as HTMLInputElement).value;
    const measurements = screen.getAllByLabelText("X (mm)");
    await user.type(measurements[0], "0.125");
    await user.click(screen.getByRole("tab", { name: "Verificação" }));
    await user.click(screen.getByRole("tab", { name: "Medições" }));
    expect(screen.getAllByLabelText("X (mm)")[0]).toHaveValue("0.125");

    await user.click(screen.getByRole("tab", { name: "Ajuste" }));
    expect(screen.getByRole("button", { name: "Advanced · Scale/Skew" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Front" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("X offset (mm)")).toHaveValue("1.234");
    expect(screen.getByLabelText(/Opacidade do verso/)).toHaveValue("65");

    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(screen.getByRole("tab", { name: "Medições" }));
    expect((screen.getByLabelText("Fixture session ID") as HTMLInputElement).value).toBe(sessionId);
    expect(screen.getAllByLabelText("X (mm)")[0]).toHaveValue("0.125");
  });
});
