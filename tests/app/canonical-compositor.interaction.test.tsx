// @vitest-environment jsdom
import { useState } from "react";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkingCard } from "../../core/cards/types";
import { createIdentitySideCalibration, type PrinterProfileSnapshot } from "../../core/calibration";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import RegistrationLayoutPreview from "../../src/app/registration-layout-preview";
import WorkspaceShell, { WORKSPACE_SECTIONS, type WorkspaceSection } from "../../src/app/workspace-shell";

afterEach(cleanup);

const artworkFront = { candidateId: `upload:${"a".repeat(64)}`, source: "upload" as const, identityId: null, faceId: "front" };
const artworkFrontNext = { candidateId: `upload:${"c".repeat(64)}`, source: "upload" as const, identityId: null, faceId: "front" };
const artworkBack = { candidateId: `upload:${"b".repeat(64)}`, source: "upload" as const, identityId: null, faceId: "back", selectionPolicy: "user-selected" };

function card(): WorkingCard {
  return {
    id: "compositor-card",
    quantity: 10,
    order: 0,
    section: "Mainboard",
    importSource: { sourceId: "deck:compositor", importKind: "text", entryKind: "deck-card" },
    identityHints: { name: "Island" },
    identity: null,
    identityResolution: { status: "unresolved", candidates: [], confirmed: false },
    faces: [{ id: "front", side: "front", name: "Island" }],
    selectedArtworkByFace: { front: artworkFront },
    manualBackArtwork: artworkBack,
    backMode: "manual",
    backModeSelectionPolicy: "explicit",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  };
}

const calibrationProfile: PrinterProfileSnapshot = {
  id: "compositor-printer",
  name: "Impressora de teste",
  front: createIdentitySideCalibration(),
  back: createIdentitySideCalibration(),
  paperSize: "A4",
  paperWidthMm: 210,
  paperHeightMm: 297,
  pageOrientation: "portrait",
  duplexMode: "single-sided",
  physicalValidationStatus: "software-only",
  version: 1,
  profileHash: "f".repeat(64),
};

function compositorWorkspace() {
  function Harness() {
    const [settings, setSettings] = useState({ ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } });
    const [cards, setCards] = useState([card()]);
    const [projectRevision, setProjectRevision] = useState(1);
    const [pageNumber, setPageNumber] = useState(1);
    const changeSettings = (update: (current: typeof settings) => typeof settings) => {
      setSettings(update);
      setProjectRevision((revision) => revision + 1);
    };
    const sections = Object.fromEntries(WORKSPACE_SECTIONS.map(({ id }) => [id, id === "layout"
      ? <label>Margem esquerda<input aria-label="Margem esquerda" type="number" value={settings.marginsMm.left} onChange={(event) => { const value = Number(event.currentTarget.value); changeSettings((current) => ({ ...current, marginsMm: { ...current.marginsMm, left: value } })); }} /></label>
      : id === "pdf"
        ? <label>Bleed do Project<input aria-label="Bleed do Project" type="number" step="0.125" value={settings.bleedMm} onChange={(event) => { const value = Number(event.currentTarget.value); changeSettings((current) => ({ ...current, bleedMm: value })); }} /></label>
        : id === "artwork"
          ? <button type="button" onClick={() => setCards((current) => current.map((entry) => ({ ...entry, selectedArtworkByFace: { ...entry.selectedArtworkByFace, front: artworkFrontNext } })))}>Selecionar artwork alternativa</button>
          : id === "calibration"
            ? <label>Offset de calibração<input aria-label="Offset de calibração" type="number" value={settings.printerProfileSelection?.front.offsetXUm ?? 0} onChange={(event) => { const value = Number(event.currentTarget.value); changeSettings((current) => ({ ...current, printerProfileSelection: { ...calibrationProfile, front: { ...calibrationProfile.front, offsetXUm: value } } })); }} /></label>
            : <p key={id}>{id}</p>])) as Record<WorkspaceSection, ReactNode>;
    return <>
      <output data-testid="project-revision">{projectRevision}</output>
      <WorkspaceShell
        hasCards
        sections={sections}
        preview={<RegistrationLayoutPreview
          settings={settings}
          cardCount={cards.reduce((sum, entry) => sum + entry.quantity, 0)}
          cards={cards}
          selectedPageNumber={pageNumber}
          onSelectPage={setPageNumber}
          onToggleSkippedSlot={() => undefined}
        />}
      />
    </>;
  }
  return <Harness />;
}

function sheet() {
  return screen.getByRole("img", { name: /Compositor live/ });
}

describe("canonical live compositor interactions", () => {
  it("renders permanently and updates margin, bleed, artwork, face, page, and calibration without an update action", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace());

    const main = screen.getByRole("main", { name: "Preview e compositor atual" });
    expect(within(main).getByRole("img", { name: /Compositor live frente/ })).toBeInTheDocument();
    expect(main.querySelectorAll("image[data-compositor-source='preview-thumbnail']")).toHaveLength(9);
    expect(main.querySelector("image[data-compositor-artwork]")).toHaveAttribute("data-compositor-artwork", artworkFront.candidateId);
    expect(screen.queryByRole("button", { name: /Atualizar preview/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/PDF final/)).not.toBeInTheDocument();

    const slot = () => main.querySelector("g[data-slot-x-mm]");
    const startingX = Number(slot()?.getAttribute("data-slot-x-mm"));
    const revisionAfterInitialRender = screen.getByTestId("project-revision").textContent;
    await user.click(screen.getByRole("tab", { name: "Layout" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Margem esquerda" }));
    await user.type(screen.getByRole("spinbutton", { name: "Margem esquerda" }), "10");
    expect(Number(slot()?.getAttribute("data-slot-x-mm"))).not.toBe(startingX);
    expect(Number(screen.getByTestId("project-revision").textContent)).toBeGreaterThan(Number(revisionAfterInitialRender));

    await user.click(screen.getByRole("tab", { name: "PDF" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Bleed do Project" }));
    await user.type(screen.getByRole("spinbutton", { name: "Bleed do Project" }), "1.25");
    expect(sheet()).toHaveAttribute("data-compositor-bleed-mm", "1.25");
    expect(main.querySelector("image[data-compositor-artwork]")?.getAttribute("href")).toContain("bleedMm=1.25");

    await user.click(screen.getByRole("tab", { name: "Artwork" }));
    await user.click(screen.getByRole("button", { name: "Selecionar artwork alternativa" }));
    expect(main.querySelector("image[data-compositor-artwork]")).toHaveAttribute("data-compositor-artwork", artworkFrontNext.candidateId);
    await user.click(screen.getByRole("button", { name: "Verso" }));
    expect(main.querySelector("image[data-compositor-artwork]")).toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);

    expect(sheet()).toHaveAttribute("data-compositor-page", "1");
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(sheet()).toHaveAttribute("data-compositor-page", "2");

    await user.click(screen.getByRole("tab", { name: "Calibração" }));
    await user.click(screen.getByRole("button", { name: "Frente" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Offset de calibração" }));
    await user.type(screen.getByRole("spinbutton", { name: "Offset de calibração" }), "500");
    expect(sheet()).not.toHaveAttribute("data-compositor-calibration-matrix", "identity");
    expect(sheet().querySelector("[data-compositor-layer='reserved']"))
      .toHaveAttribute("transform", sheet().getAttribute("data-compositor-calibration-matrix"));
  });

  it("keeps Layers and zoom in viewer UI state instead of Project state", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace());
    const revision = screen.getByTestId("project-revision").textContent;
    await user.click(screen.getByText("Layers"));
    await user.click(screen.getByRole("checkbox", { name: "Artwork" }));
    await user.click(screen.getByRole("checkbox", { name: "Bleed" }));
    await user.click(screen.getByRole("checkbox", { name: "Trim" }));
    await user.click(screen.getByRole("checkbox", { name: "Cut guides" }));
    await user.click(screen.getByRole("checkbox", { name: "Silhouette / SVG-DXF" }));
    await user.click(screen.getByRole("checkbox", { name: "Registration" }));
    await user.click(screen.getByRole("checkbox", { name: "Reserved zones" }));
    await user.click(screen.getByRole("checkbox", { name: "Margins" }));
    await user.click(screen.getByRole("checkbox", { name: "Calibration" }));
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
    const compositor = screen.getByRole("img", { name: /Compositor live/ });
    expect(compositor.querySelector("image[data-compositor-artwork]")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='bleed']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='cut']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='silhouette']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='margins']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='registration']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-calibrated-print-content]")).toHaveAttribute("data-calibrated-print-content", "false");

    await user.click(screen.getByRole("button", { name: "Aumentar zoom" }));
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
    expect(screen.getByRole("button", { name: "Fit Page" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryAllByTitle(/PDF/)).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: "Conferir PDF final" })).not.toBeInTheDocument();
  });
});
