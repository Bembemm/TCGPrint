// @vitest-environment jsdom
import { useState } from "react";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  const sections = Object.fromEntries(WORKSPACE_SECTIONS.map(({ id }) => [id, id === "calibration"
    ? <PrinterCalibrationPanel
        paperFormat={DEFAULT_PROJECT_SETTINGS.paperFormat}
        pageOrientation="portrait"
        printerProfileSelection={profile}
        printerDuplexMode="single-sided"
        exportContentMode="duplex"
        duplexFlipMode="long-edge"
        disabled={false}
        onProjectSelectionChange={vi.fn()}
      />
    : <p>{id}</p>])) as Record<(typeof WORKSPACE_SECTIONS)[number]["id"], ReactNode>;
  return <WorkspaceShell sections={sections} preview={<div />} hasCards />;
}

describe("calibration wizard stages", () => {
  it("shows distinct Profile, Ajuste, Medições, and Verificação content", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ profiles: [profile] }), { status: 200 })));
    render(calibrationWorkspace());
    await user.click(screen.getByRole("tab", { name: "Calibração" }));

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
    await user.click(screen.getByRole("tab", { name: "Calibração" }));
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

    await user.click(screen.getByRole("tab", { name: "Artwork" }));
    await user.click(screen.getByRole("tab", { name: "Calibração" }));
    await user.click(screen.getByRole("tab", { name: "Medições" }));
    expect((screen.getByLabelText("Fixture session ID") as HTMLInputElement).value).toBe(sessionId);
    expect(screen.getAllByLabelText("X (mm)")[0]).toHaveValue("0.125");
  });
});
