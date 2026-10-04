// @vitest-environment jsdom
import { useState } from "react";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkingCard } from "../../core/cards/types";
import { selectManualBackArtwork } from "../../core/cards/back-selection";
import { createIdentitySideCalibration, type PrinterProfileSnapshot } from "../../core/calibration";
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettingsV2 } from "../../persistence/projects/serializer";
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

function compositorWorkspace(
  initialCards: readonly WorkingCard[] = [card()],
  initialSettings: ProjectSettingsV2 = { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } },
  enableSkippedSlotChanges = false,
) {
  function Harness() {
    const [settings, setSettings] = useState(initialSettings);
    const [cards, setCards] = useState([...initialCards]);
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
          onToggleSkippedSlot={(index) => {
            if (!enableSkippedSlotChanges) return;
            changeSettings((current) => ({
              ...current,
              layout: {
                ...current.layout,
                skippedSlotIndices: current.layout.skippedSlotIndices.includes(index)
                  ? current.layout.skippedSlotIndices.filter((slotIndex) => slotIndex !== index)
                  : [...current.layout.skippedSlotIndices, index],
              },
            }));
          }}
        />}
      />
    </>;
  }
  return <Harness />;
}

function simpleCardWithBackMode(mode: "auto" | "manual" | "project-default" | "none"): WorkingCard {
  const base = card();
  const { manualBackArtwork: _manualBackArtwork, ...withoutManualBack } = base;
  return {
    ...withoutManualBack,
    quantity: 1,
    backMode: mode,
    backModeSelectionPolicy: "explicit",
    selectedArtworkByFace: { front: artworkFront },
    ...(mode === "manual" ? { manualBackArtwork: artworkBack } : {}),
  };
}

function slotForPhysicalIndex(index: number) {
  const slot = sheet().querySelector(`g[data-physical-card-index="${index}"]`);
  if (!(slot instanceof SVGGElement)) throw new Error(`Physical card ${index} is not rendered in the current page.`);
  return slot;
}

function artworkForPhysicalIndex(index: number) {
  const artwork = slotForPhysicalIndex(index).querySelector("image[data-compositor-artwork]");
  if (!artwork) throw new Error("Physical card " + index + " has no preview artwork on this side.");
  return artwork;
}

const defaultBackAsset = { assetId: "project-default", sha256: "d".repeat(64), format: "png" as const };
const validatedMpcBack = {
  id: "mpc:validated-physical-back",
  source: "mpc" as const,
  identityId: null,
  faceId: "back",
  providerAssetId: "validated-cardback",
  originalAvailable: true,
  metadata: { cardType: "CARDBACK" },
};
const settingsWithProjectBack = {
  ...DEFAULT_PROJECT_SETTINGS,
  projectDefaultBack: defaultBackAsset,
  missingBackPolicy: "use-project-default" as const,
  layout: { skippedSlotIndices: [] },
};

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

  it("selects a physical copy by pointer and keyboard, and keeps that copy paired across Front and Back", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 3 }]));
    const revision = screen.getByTestId("project-revision").textContent;

    const secondCopy = screen.getByRole("button", { name: /carta física 2.*cópia 2 de 3/i });
    const thirdCopy = screen.getByRole("button", { name: /carta física 3.*cópia 3 de 3/i });
    expect(secondCopy).toHaveAttribute("data-physical-card-index", "1");
    expect(thirdCopy).toHaveAttribute("data-physical-card-index", "2");
    await user.click(secondCopy);
    expect(secondCopy).toHaveAttribute("data-physical-card-index", "1");
    expect(secondCopy).toHaveAttribute("data-working-card-id", "compositor-card");
    expect(secondCopy).toHaveAttribute("data-copy-number", "2");
    expect(secondCopy).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("selected-physical-card")).toHaveAttribute("data-selected-physical-card-index", "1");
    expect(screen.getByTestId("selected-physical-card")).toHaveTextContent("Carta física 2 · Island · cópia 2/3");
    expect(secondCopy.querySelector("image[data-compositor-artwork]"))
      .toHaveAttribute("aria-label", "Island · frente");
    expect(secondCopy.querySelector("image[data-compositor-artwork]"))
      .toHaveAttribute("data-compositor-artwork", artworkFront.candidateId);

    await user.click(screen.getByRole("button", { name: "Verso" }));
    const pairedBackCopy = slotForPhysicalIndex(1);
    expect(pairedBackCopy).toHaveAttribute("data-physical-card-index", "1");
    expect(pairedBackCopy).toHaveAttribute("aria-pressed", "true");
    expect(pairedBackCopy).toHaveAttribute("data-working-card-id", "compositor-card");
    expect(pairedBackCopy).toHaveAttribute("data-copy-number", "2");
    expect(pairedBackCopy).toHaveAttribute("data-copy-count", "3");
    expect(screen.getByTestId("selected-physical-card")).toHaveTextContent("Carta física 2 · Island · cópia 2/3");
    expect(pairedBackCopy.querySelector("image[data-compositor-artwork]"))
      .toHaveAttribute("aria-label", "Island · verso");
    expect(pairedBackCopy.querySelector("image[data-compositor-artwork]"))
      .toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);

    await user.click(screen.getByRole("button", { name: "Frente" }));
    expect(slotForPhysicalIndex(1)).toHaveAttribute("aria-pressed", "true");
    expect(artworkForPhysicalIndex(1)).toHaveAttribute("aria-label", "Island · frente");
    expect(artworkForPhysicalIndex(1)).toHaveAttribute("data-compositor-artwork", artworkFront.candidateId);

    const firstCopy = screen.getByRole("button", { name: /carta física 1.*cópia 1 de 3/i });
    firstCopy.focus();
    expect(document.activeElement).toBe(firstCopy);
    await user.keyboard("{Enter}");
    expect(firstCopy).toHaveAttribute("aria-pressed", "true");
    secondCopy.focus();
    await user.keyboard(" ");
    expect(secondCopy).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
  });

  it("uses DFC faces and each simple card's effective physical back", async () => {
    const user = userEvent.setup();
    const dfcBack = { ...artworkBack, candidateId: `upload:${"e".repeat(64)}` };
    const dfc: WorkingCard = {
      ...simpleCardWithBackMode("auto"),
      id: "dfc-card",
      identity: {
        id: "scryfall:oracle:dfc-compositor", provider: "scryfall", name: "Front // Back",
        resolutionMethod: "manual", confidence: 1,
        metadata: { layout: "transform", faces: [{ name: "Front" }, { name: "Back" }] },
      },
      faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
      selectedArtworkByFace: { front: artworkFront, back: dfcBack },
    };
    const { rerender } = render(compositorWorkspace([dfc], settingsWithProjectBack));
    await user.click(screen.getByRole("button", { name: /Slot 1.*Front \/\/ Back/i }));
    expect(artworkForPhysicalIndex(0)).toHaveAttribute("aria-label", "Front // Back · frente");
    expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-artwork", artworkFront.candidateId);
    await user.click(screen.getByRole("button", { name: "Verso" }));
    const dfcVerso = artworkForPhysicalIndex(0);
    expect(dfcVerso).toHaveAttribute("aria-label", "Front // Back · verso");
    expect(dfcVerso).toHaveAttribute("data-compositor-artwork", dfcBack.candidateId);
    expect(dfcVerso.getAttribute("href")).not.toContain("/api/back-library/project-default/");

    rerender(compositorWorkspace([{
      ...dfc,
      selectedArtworkByFace: { front: artworkFront },
    }], settingsWithProjectBack));
    await user.click(screen.getByRole("button", { name: "Verso" }));
    expect(slotForPhysicalIndex(0).querySelector("image[data-compositor-artwork]")).toBeNull();
    expect(slotForPhysicalIndex(0).textContent).toContain("Verso sem artwork disponível");

    rerender(compositorWorkspace([simpleCardWithBackMode("project-default")], settingsWithProjectBack));
    await user.click(screen.getByRole("button", { name: "Verso" }));
    expect(artworkForPhysicalIndex(0)).toHaveAttribute("aria-label", "Verso padrão do Project");
    expect(artworkForPhysicalIndex(0).getAttribute("data-compositor-artwork"))
      .toContain("/api/back-library/project-default/");

    const manual = selectManualBackArtwork(simpleCardWithBackMode("project-default"), validatedMpcBack);
    rerender(compositorWorkspace([manual], settingsWithProjectBack));
    await user.click(screen.getByRole("button", { name: "Verso" }));
    expect(artworkForPhysicalIndex(0)).toHaveAttribute("aria-label", "Island · verso");
    expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-artwork", validatedMpcBack.id);

    const { manualBackArtwork: _manualBackArtwork, ...manualLibraryBase } = simpleCardWithBackMode("manual");
    rerender(compositorWorkspace([{
      ...manualLibraryBase,
      manualBackAsset: { assetId: "manual-library-back", sha256: "b".repeat(64), format: "jpeg" },
    }], settingsWithProjectBack));
    await user.click(screen.getByRole("button", { name: "Verso" }));
    const manualLibraryPreview = artworkForPhysicalIndex(0);
    expect(manualLibraryPreview).toHaveAttribute("aria-label", "Verso da Back Library");
    expect(manualLibraryPreview.getAttribute("href")).toContain("/api/back-library/manual-library-back/preview");

    rerender(compositorWorkspace([simpleCardWithBackMode("none")], settingsWithProjectBack));
    await user.click(screen.getByRole("button", { name: "Verso" }));
    expect(slotForPhysicalIndex(0).querySelector("image[data-compositor-artwork]")).toBeNull();
    expect(slotForPhysicalIndex(0).textContent).toContain("Verso intencionalmente em branco");

    rerender(compositorWorkspace([simpleCardWithBackMode("auto")], {
      ...settingsWithProjectBack,
      projectDefaultBack: null,
      missingBackPolicy: "block",
    }));
    await user.click(screen.getByRole("button", { name: "Verso" }));
    expect(slotForPhysicalIndex(0).querySelector("image[data-compositor-artwork]")).toBeNull();
    expect(slotForPhysicalIndex(0).textContent).toContain("Verso sem artwork disponível");
  });

  it("clears a physical selection when the destination page does not contain that copy", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([card()]));

    await user.click(screen.getByRole("button", { name: /carta física 2.*cópia 2 de 10/i }));
    expect(screen.getByTestId("selected-physical-card")).toHaveAttribute("data-selected-physical-card-index", "1");
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(screen.getByRole("img", { name: /Compositor live frente.*página 2 de 2/ })).toHaveAttribute("data-selected-physical-card-index", "none");
    expect(screen.getByTestId("selected-physical-card")).toHaveAttribute("data-selected-physical-card-index", "none");
    expect(screen.queryByRole("button", { name: /selecionada/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Página anterior" }));
    expect(screen.getByTestId("selected-physical-card")).toHaveAttribute("data-selected-physical-card-index", "none");
    expect(slotForPhysicalIndex(1)).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps explicit skipped-slot editing available without using selection clicks as Project edits", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace(
      [{ ...card(), quantity: 3 }],
      { ...DEFAULT_PROJECT_SETTINGS, layout: { rows: 1, columns: 3, skippedSlotIndices: [] } },
      true,
    ));
    const revision = Number(screen.getByTestId("project-revision").textContent);
    await user.click(screen.getByRole("button", { name: /carta física 1.*cópia 1 de 3/i }));
    expect(Number(screen.getByTestId("project-revision").textContent)).toBe(revision);
    const startingX = Number(slotForPhysicalIndex(0).getAttribute("data-slot-x-mm"));

    await user.click(screen.getByRole("button", { name: "Desativar slot da carta selecionada" }));

    expect(Number(screen.getByTestId("project-revision").textContent)).toBe(revision + 1);
    expect(Number(slotForPhysicalIndex(0).getAttribute("data-slot-x-mm"))).not.toBe(startingX);
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
