// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkingCard } from "../../core/cards/types";
import { createPhysicalOrder, movePhysicalInstance, type PhysicalOrder } from "../../core/cards/physical-instance-order";
import { selectManualBackArtwork } from "../../core/cards/back-selection";
import { createIdentitySideCalibration, type PrinterProfileSnapshot } from "../../core/calibration";
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettingsV2 } from "../../persistence/projects/serializer";
import RegistrationLayoutPreview from "../../src/app/registration-layout-preview";
import WorkspaceShell from "../../src/app/workspace-shell";

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
  onSelectArtwork?: (cardId: string, instanceId: string, physicalCardIndex: number, side: "front" | "back", opener: HTMLElement | SVGElement, copyNumber: number, totalCopies: number) => void,
  enableReorder = false,
  initialPhysicalOrder?: PhysicalOrder,
  onPhysicalAction?: (action: "increase" | "remove-copy" | "duplicate-copy" | "delete-entry" | "open-settings", instanceId: string, cardId: string) => void,
  interactionBusy = false,
  simulateRemoveCopy = false,
  simulateDuplicateCopy = false,
  simulateDeleteEntry = false,
) {
  function Harness() {
    const [settings, setSettings] = useState(initialSettings);
    const [cards, setCards] = useState([...initialCards]);
    const [physicalOrder, setPhysicalOrder] = useState(() => initialPhysicalOrder ?? createPhysicalOrder(initialCards));
    const [projectRevision, setProjectRevision] = useState(1);
    const [pageNumber, setPageNumber] = useState(1);
    const [activePhysicalInstanceId, setActivePhysicalInstanceId] = useState<string | null>(null);
    const [selectedPhysicalInstanceIds, setSelectedPhysicalInstanceIds] = useState<Set<string>>(() => new Set());
    useEffect(() => {
      const existingIds = new Set(physicalOrder.instances.map(({ id }) => id));
      setSelectedPhysicalInstanceIds((current) => {
        const next = new Set([...current].filter((id) => existingIds.has(id)));
        return next.size === current.size ? current : next;
      });
    }, [physicalOrder]);
    const changeSettings = (update: (current: typeof settings) => typeof settings) => {
      setSettings(update);
      setProjectRevision((revision) => revision + 1);
    };
    const sections = {
      cards: <p>cards</p>,
      settings: <>
        <label>Margem esquerda<input aria-label="Margem esquerda" type="number" value={settings.marginsMm.left} onChange={(event) => { const value = Number(event.currentTarget.value); changeSettings((current) => ({ ...current, marginsMm: { ...current.marginsMm, left: value } })); }} /></label>
        <label>Bleed do Project<input aria-label="Bleed do Project" type="number" step="0.125" value={settings.bleedMm} onChange={(event) => { const value = Number(event.currentTarget.value); changeSettings((current) => ({ ...current, bleedMm: value })); }} /></label>
        <button type="button" onClick={() => setCards((current) => current.map((entry) => ({ ...entry, selectedArtworkByFace: { ...entry.selectedArtworkByFace, front: artworkFrontNext } })))}>Selecionar artwork alternativa</button>
        <label>Offset de calibração<input aria-label="Offset de calibração" type="number" value={settings.printerProfileSelection?.front.offsetXUm ?? 0} onChange={(event) => { const value = Number(event.currentTarget.value); changeSettings((current) => ({ ...current, printerProfileSelection: { ...calibrationProfile, front: { ...calibrationProfile.front, offsetXUm: value } } })); }} /></label>
      </>,
      export: <p>export</p>,
    };
    return <>
      <output data-testid="project-revision">{projectRevision}</output>
      <output data-testid="active-physical-instance-id">{activePhysicalInstanceId ?? "none"}</output>
      <output data-testid="physical-order-ids">{physicalOrder.instances.map(({ id }) => id).join(",")}</output>
      {simulateRemoveCopy && <button type="button" onClick={() => { setCards([...initialCards]); setPhysicalOrder(initialPhysicalOrder ?? createPhysicalOrder(initialCards)); }}>Undo test removal</button>}
      <WorkspaceShell
        hasCards
        sections={sections}
        preview={<RegistrationLayoutPreview
          settings={settings}
          cardCount={cards.reduce((sum, entry) => sum + entry.quantity, 0)}
          cards={cards}
          physicalOrder={physicalOrder}
          activePhysicalInstanceId={activePhysicalInstanceId}
          selectedPhysicalInstanceIds={selectedPhysicalInstanceIds}
          interactionBusy={interactionBusy}
          selectedPageNumber={pageNumber}
          onSelectPage={setPageNumber}
          onActivatePhysicalInstance={(instanceId) => setActivePhysicalInstanceId(instanceId)}
          onTogglePhysicalInstanceSelection={(instanceId) => setSelectedPhysicalInstanceIds((current) => {
            const next = new Set(current);
            if (next.has(instanceId)) next.delete(instanceId);
            else next.add(instanceId);
            return next;
          })}
          onSelectAllPhysicalInstances={(instanceIds) => setSelectedPhysicalInstanceIds(new Set(instanceIds))}
          onClearPhysicalInstanceSelection={() => setSelectedPhysicalInstanceIds(new Set())}
          onSelectArtwork={onSelectArtwork}
          onPhysicalAction={onPhysicalAction ? (action, instanceId, cardId) => {
            onPhysicalAction(action, instanceId, cardId);
            if (simulateRemoveCopy && action === "remove-copy") {
              setCards((current) => current.map((entry) => entry.id === cardId ? { ...entry, quantity: entry.quantity - 1 } : entry));
              setPhysicalOrder((current) => ({ ...current, instances: current.instances.filter((reference) => reference.id !== instanceId) }));
            }
            if (simulateDuplicateCopy && action === "duplicate-copy") {
              const nextCardId = `${cardId}-duplicate`;
              setCards((current) => {
                const source = current.find((entry) => entry.id === cardId);
                return source ? [...current, { ...source, id: nextCardId, quantity: 1, order: current.length }] : current;
              });
              setPhysicalOrder((current) => ({
                nextInstanceId: current.nextInstanceId + 1,
                instances: [...current.instances, { id: `instance-${current.nextInstanceId}`, workingCardId: nextCardId }],
              }));
              setActivePhysicalInstanceId(`instance-${physicalOrder.nextInstanceId}`);
            }
            if (simulateDeleteEntry && action === "delete-entry") {
              setCards((current) => current.filter((entry) => entry.id !== cardId));
              setPhysicalOrder((current) => ({ ...current, instances: current.instances.filter((reference) => reference.workingCardId !== cardId) }));
              setActivePhysicalInstanceId(null);
            }
          } : undefined}
          onReorderPhysicalInstance={enableReorder ? (instanceId, targetInstanceId, placement) => setPhysicalOrder((current) => movePhysicalInstance(current, instanceId, targetInstanceId, placement)) : undefined}
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

function bodyButtonForPhysicalIndex(index: number) {
  const button = slotForPhysicalIndex(index).querySelector('[data-compositor-card-body="true"]');
  if (!(button instanceof SVGElement)) throw new Error(`Physical card ${index} has no body activation control.`);
  return button;
}

function checkboxForPhysicalIndex(index: number) {
  const checkbox = slotForPhysicalIndex(index).querySelector('[role="checkbox"]');
  if (!(checkbox instanceof SVGElement)) throw new Error(`Physical card ${index} has no selection checkbox.`);
  return checkbox;
}

function flipButtonForPhysicalIndex(index: number) {
  const button = slotForPhysicalIndex(index).querySelector<HTMLButtonElement>("[data-compositor-local-flip]");
  if (!button) throw new Error(`Physical card ${index} has no local face inspection control.`);
  return button;
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
  return screen.getByRole("group", { name: /Compositor live/ });
}

describe("canonical live compositor interactions", () => {
  it("renders permanently and updates margin, bleed, artwork, face, page, and calibration without an update action", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace());

    const main = screen.getByRole("main", { name: "Preview e compositor atual" });
    expect(within(main).getByRole("group", { name: /Compositor live frente/ })).toBeInTheDocument();
    expect(within(sheet()).getByRole("button", { name: /Slot 1 · carta física 1/ })).toBeInTheDocument();
    expect(main.querySelectorAll("image[data-compositor-source='preview-thumbnail']")).toHaveLength(9);
    expect(main.querySelector("image[data-compositor-artwork]")).toHaveAttribute("data-compositor-artwork", artworkFront.candidateId);
    expect(screen.queryByRole("button", { name: /Atualizar preview/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/PDF final/)).not.toBeInTheDocument();

    const slot = () => main.querySelector("g[data-slot-x-mm]");
    const startingX = Number(slot()?.getAttribute("data-slot-x-mm"));
    const revisionAfterInitialRender = screen.getByTestId("project-revision").textContent;
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Margem esquerda" }));
    await user.type(screen.getByRole("spinbutton", { name: "Margem esquerda" }), "10");
    expect(Number(slot()?.getAttribute("data-slot-x-mm"))).not.toBe(startingX);
    expect(Number(screen.getByTestId("project-revision").textContent)).toBeGreaterThan(Number(revisionAfterInitialRender));

    await user.clear(screen.getByRole("spinbutton", { name: "Bleed do Project" }));
    await user.type(screen.getByRole("spinbutton", { name: "Bleed do Project" }), "1.25");
    expect(sheet()).toHaveAttribute("data-compositor-bleed-mm", "1.25");
    expect(main.querySelector("image[data-compositor-artwork]")?.getAttribute("href")).toContain("bleedMm=1.25");

    await user.click(screen.getByRole("button", { name: "Selecionar artwork alternativa" }));
    expect(main.querySelector("image[data-compositor-artwork]")).toHaveAttribute("data-compositor-artwork", artworkFrontNext.candidateId);
    await user.click(screen.getByRole("button", { name: "Verso" }));
    expect(main.querySelector("image[data-compositor-artwork]")).toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);

    expect(sheet()).toHaveAttribute("data-compositor-page", "1");
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(sheet()).toHaveAttribute("data-compositor-page", "2");

    await user.click(screen.getByRole("button", { name: "Frente" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Offset de calibração" }));
    await user.type(screen.getByRole("spinbutton", { name: "Offset de calibração" }), "500");
    expect(sheet()).not.toHaveAttribute("data-compositor-calibration-matrix", "identity");
    expect(sheet().querySelector("[data-compositor-layer='reserved']"))
      .toHaveAttribute("transform", sheet().getAttribute("data-compositor-calibration-matrix"));
  });

  it("activates a physical copy by pointer and keyboard, and keeps that copy paired across Front and Back", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 3 }]));
    const revision = screen.getByTestId("project-revision").textContent;

    const secondCopy = screen.getByRole("button", { name: /carta física 2.*cópia 2 de 3/i });
    const thirdCopy = screen.getByRole("button", { name: /carta física 3.*cópia 3 de 3/i });
    expect(secondCopy).toHaveAttribute("data-physical-card-index", "1");
    expect(thirdCopy).toHaveAttribute("data-physical-card-index", "2");
    await user.click(secondCopy);
    expect(secondCopy).toHaveAttribute("data-physical-card-index", "1");
    expect(slotForPhysicalIndex(1)).toHaveAttribute("data-working-card-id", "compositor-card");
    expect(slotForPhysicalIndex(1)).toHaveAttribute("data-copy-number", "2");
    expect(secondCopy).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("active-physical-card")).toHaveAttribute("data-active-physical-card-index", "1");
    expect(screen.getByTestId("active-physical-card")).toHaveTextContent("Carta física 2 · Island · cópia 2/3");
    expect(slotForPhysicalIndex(1).querySelector("image[data-compositor-artwork]"))
      .toHaveAttribute("aria-label", "Island · frente");
    expect(slotForPhysicalIndex(1).querySelector("image[data-compositor-artwork]"))
      .toHaveAttribute("data-compositor-artwork", artworkFront.candidateId);

    await user.click(screen.getByRole("button", { name: "Verso" }));
    const pairedBackCopy = slotForPhysicalIndex(1);
    expect(pairedBackCopy).toHaveAttribute("data-physical-card-index", "1");
    expect(bodyButtonForPhysicalIndex(1)).toHaveAttribute("aria-current", "true");
    expect(pairedBackCopy).toHaveAttribute("data-working-card-id", "compositor-card");
    expect(pairedBackCopy).toHaveAttribute("data-copy-number", "2");
    expect(pairedBackCopy).toHaveAttribute("data-copy-count", "3");
    expect(screen.getByTestId("active-physical-card")).toHaveTextContent("Carta física 2 · Island · cópia 2/3");
    expect(pairedBackCopy.querySelector("image[data-compositor-artwork]"))
      .toHaveAttribute("aria-label", "Island · verso");
    expect(pairedBackCopy.querySelector("image[data-compositor-artwork]"))
      .toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);

    await user.click(screen.getByRole("button", { name: "Frente" }));
    expect(bodyButtonForPhysicalIndex(1)).toHaveAttribute("aria-current", "true");
    expect(artworkForPhysicalIndex(1)).toHaveAttribute("aria-label", "Island · frente");
    expect(artworkForPhysicalIndex(1)).toHaveAttribute("data-compositor-artwork", artworkFront.candidateId);

    const firstCopy = screen.getByRole("button", { name: /carta física 1.*cópia 1 de 3/i });
    firstCopy.focus();
    expect(document.activeElement).toBe(firstCopy);
    await user.keyboard("{Enter}");
    expect(firstCopy).toHaveAttribute("aria-current", "true");
    secondCopy.focus();
    await user.keyboard(" ");
    expect(secondCopy).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
  });

  it("keeps body activation independent from checkbox multi-selection and clear", async () => {
    const user = userEvent.setup();
    const onSelectArtwork = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 3 }], undefined, false, onSelectArtwork));
    const revision = screen.getByTestId("project-revision").textContent;
    const physicalOrder = screen.getByTestId("physical-order-ids").textContent;

    await user.click(bodyButtonForPhysicalIndex(0));
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-1");
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "false");
    expect(onSelectArtwork).toHaveBeenCalledWith("compositor-card", "instance-1", 0, "front", bodyButtonForPhysicalIndex(0), 1, 3);

    await user.click(checkboxForPhysicalIndex(1));
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-1");
    await user.click(checkboxForPhysicalIndex(2));
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(2)).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-1");

    await user.click(screen.getByRole("button", { name: "Verso" }));
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(2)).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Frente" }));

    await user.click(screen.getByRole("button", { name: "Desmarcar" }));
    expect(screen.queryByRole("group", { name: "Ações de seleção" })).not.toBeInTheDocument();
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "false");
    expect(checkboxForPhysicalIndex(2)).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-1");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent(physicalOrder ?? "");
  });

  it("keeps checkbox clicks out of the context menu and drag path while right click only activates", async () => {
    const user = userEvent.setup();
    const onPhysicalAction = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], undefined, false, undefined, true, undefined, onPhysicalAction));

    await user.click(checkboxForPhysicalIndex(0));
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("none");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const dataTransfer = { effectAllowed: "none", setData: vi.fn(), getData: vi.fn(() => "instance-1") };
    fireEvent.pointerDown(checkboxForPhysicalIndex(0), { pointerType: "mouse" });
    expect(fireEvent.dragStart(slotForPhysicalIndex(0), { dataTransfer })).toBe(false);
    expect(slotForPhysicalIndex(0)).not.toHaveClass("is-drag-source");
    expect(fireEvent.dragStart(checkboxForPhysicalIndex(0), { dataTransfer })).toBe(false);
    expect(slotForPhysicalIndex(0)).not.toHaveClass("is-drag-source");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("none");

    expect(fireEvent.contextMenu(bodyButtonForPhysicalIndex(1))).toBe(false);
    expect(screen.getByRole("menu", { name: /Ações para Island, cópia 2/i })).toBeInTheDocument();
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "false");
    expect(onPhysicalAction).not.toHaveBeenCalled();
  });

  it("selects every physical ID across pages and excludes unassigned slots", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 5 }], {
      ...DEFAULT_PROJECT_SETTINGS,
      layout: { rows: 1, columns: 3, skippedSlotIndices: [1] },
    }));

    expect(sheet().querySelectorAll('[role="checkbox"]')).toHaveLength(2);
    expect(sheet().querySelector('g[aria-label^="Slot 2 desativado"] [role="checkbox"]')).toBeNull();
    await user.click(checkboxForPhysicalIndex(0));
    const actionBar = screen.getByRole("group", { name: "Ações de seleção" });
    expect(within(actionBar).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Selecionar tudo", "Desmarcar"]);
    await user.click(within(actionBar).getByRole("button", { name: "Selecionar tudo" }));

    expect(sheet()).toHaveAttribute("data-compositor-page", "1");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("none");
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2,instance-3,instance-4,instance-5");
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(checkboxForPhysicalIndex(2)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(3)).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(checkboxForPhysicalIndex(4)).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("button", { name: "Desmarcar" }));
    expect(screen.queryByRole("group", { name: "Ações de seleção" })).not.toBeInTheDocument();
    expect(checkboxForPhysicalIndex(4)).toHaveAttribute("aria-checked", "false");
  });

  it("preserves checkbox membership while navigating between pages", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([card()]));

    await user.click(checkboxForPhysicalIndex(0));
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    await user.click(checkboxForPhysicalIndex(9));
    expect(checkboxForPhysicalIndex(9)).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Página anterior" }));
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(checkboxForPhysicalIndex(9)).toHaveAttribute("aria-checked", "true");
  });

  it("prunes a removed physical ID and keeps surviving checkbox IDs", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 3 }], undefined, false, undefined, false, undefined, vi.fn(), false, true));

    await user.click(checkboxForPhysicalIndex(1));
    await user.click(checkboxForPhysicalIndex(2));
    await user.click(bodyButtonForPhysicalIndex(1));
    await user.click(screen.getByRole("button", { name: /mais ações para Island, cópia 2/i }));
    await user.click(screen.getByRole("menuitem", { name: "Remover uma cópia" }));

    await waitFor(() => expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-3"));
    expect(screen.getByRole("checkbox", { name: "Selecionar Island, cópia 2 de 2" })).toHaveAttribute("aria-checked", "true");
  });

  it("does not add a duplicated physical copy to checkbox selection", async () => {
    const user = userEvent.setup();
    const onPhysicalAction = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], undefined, false, undefined, false, undefined, onPhysicalAction, false, false, true));

    await user.click(checkboxForPhysicalIndex(0));
    await user.click(checkboxForPhysicalIndex(1));
    await user.click(bodyButtonForPhysicalIndex(0));
    await user.click(screen.getByRole("button", { name: /mais ações para Island, cópia 1/i }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicar como entrada independente" }));

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2,instance-3");
    expect(screen.getByRole("checkbox", { name: "Selecionar Island, cópia 1 de 2" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "Selecionar Island, cópia 2 de 2" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "Selecionar Island, cópia 1 de 1" })).toHaveAttribute("aria-checked", "false");
    expect(onPhysicalAction).toHaveBeenCalledWith("duplicate-copy", "instance-1", "compositor-card");
  });

  it("prunes deleted WorkingCard IDs while preserving selected surviving IDs", async () => {
    const user = userEvent.setup();
    const onPhysicalAction = vi.fn();
    const cards = [
      { ...card(), id: "island-entry", quantity: 1 },
      { ...card(), id: "mountain-entry", order: 1, quantity: 1, identityHints: { name: "Mountain" }, faces: [{ id: "front", side: "front" as const, name: "Mountain" }] },
    ];
    render(compositorWorkspace(cards, undefined, false, undefined, false, undefined, onPhysicalAction, false, false, false, true));

    await user.click(checkboxForPhysicalIndex(0));
    await user.click(checkboxForPhysicalIndex(1));
    await user.click(bodyButtonForPhysicalIndex(0));
    await user.click(screen.getByRole("button", { name: /mais ações para Island, cópia 1/i }));
    await user.click(screen.getByRole("menuitem", { name: "Remover carta inteira" }));

    await waitFor(() => expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-2"));
    expect(screen.queryByRole("checkbox", { name: "Selecionar Island, cópia 1 de 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Selecionar Mountain, cópia 1 de 1" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("group", { name: "Ações de seleção" })).toBeInTheDocument();
  });

  it("opens the picker immediately from the body for the exact physical copy and displayed side", async () => {
    const user = userEvent.setup();
    const onSelectArtwork = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 3 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, onSelectArtwork));

    await user.click(screen.getByRole("button", { name: "Verso" }));
    const body = bodyButtonForPhysicalIndex(1);
    await user.click(body);

    expect(onSelectArtwork).toHaveBeenCalledTimes(1);
    expect(onSelectArtwork).toHaveBeenCalledWith("compositor-card", "instance-2", 1, "back", body, 2, 3);
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "false");
  });

  it("opens the picker for the stable physical instance at its custom sequence index", async () => {
    const user = userEvent.setup();
    const onSelectArtwork = vi.fn();
    const cards = [{ ...card(), quantity: 3 }];
    const initialOrder = createPhysicalOrder(cards);
    const customOrder = movePhysicalInstance(initialOrder, "instance-2", "instance-3", "after");
    render(compositorWorkspace(cards, { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, onSelectArtwork, false, customOrder));

    const physicalSecond = screen.getByRole("button", { name: /carta física 2.*cópia 2 de 3/i });
    expect(physicalSecond).toHaveAttribute("data-physical-instance-id", "instance-3");
    await user.click(physicalSecond);
    expect(onSelectArtwork).toHaveBeenCalledWith("compositor-card", "instance-3", 1, "front", physicalSecond, 2, 3);
  });

  it("opens the picker from Enter and Space on the body without changing selection", async () => {
    const user = userEvent.setup();
    const onSelectArtwork = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], undefined, false, onSelectArtwork));
    const body = bodyButtonForPhysicalIndex(1);

    body.focus();
    await user.keyboard("{Enter}");
    expect(onSelectArtwork).toHaveBeenCalledTimes(1);
    expect(onSelectArtwork).toHaveBeenLastCalledWith("compositor-card", "instance-2", 1, "front", body, 2, 2);
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "false");

    onSelectArtwork.mockClear();
    body.focus();
    await user.keyboard(" ");
    expect(onSelectArtwork).toHaveBeenCalledTimes(1);
    expect(onSelectArtwork).toHaveBeenLastCalledWith("compositor-card", "instance-2", 1, "front", body, 2, 2);
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "false");
  });

  it("flips only the target physical copy for inspection and resets on global face change", async () => {
    const user = userEvent.setup();
    const onSelectArtwork = vi.fn();
    const onPhysicalAction = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], undefined, false, onSelectArtwork, false, undefined, onPhysicalAction));
    const revision = screen.getByTestId("project-revision").textContent;
    const order = screen.getByTestId("physical-order-ids").textContent;

    const flip = flipButtonForPhysicalIndex(0);
    expect(flip).toHaveAccessibleName("Ver verso de Island, cópia 1");
    expect(flip).toHaveAttribute("aria-pressed", "false");
    await user.click(flip);

    expect(flipButtonForPhysicalIndex(0)).toHaveAttribute("aria-pressed", "true");
    expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);
    expect(artworkForPhysicalIndex(1)).toHaveAttribute("data-compositor-artwork", artworkFront.candidateId);
    expect(sheet()).toHaveAttribute("aria-label", expect.stringContaining("frente"));
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("none");
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent(order ?? "");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
    expect(onSelectArtwork).not.toHaveBeenCalled();
    expect(onPhysicalAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Verso" }));
    expect(flipButtonForPhysicalIndex(0)).toHaveAttribute("aria-pressed", "false");
    expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);
    expect(artworkForPhysicalIndex(1)).toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);
  });

  it("keeps a local flip with its physical ID after legacy reorder and suppresses the residual click", () => {
    const onSelectArtwork = vi.fn();
    const order = createPhysicalOrder([{ ...card(), quantity: 3 }]);
    render(compositorWorkspace([{ ...card(), quantity: 3 }], undefined, false, onSelectArtwork, true, order));
    fireEvent.click(flipButtonForPhysicalIndex(1));

    const dataTransfer = { effectAllowed: "none", setData: vi.fn(), getData: vi.fn(() => "instance-2") };
    fireEvent.dragStart(slotForPhysicalIndex(1), { dataTransfer });
    fireEvent.dragOver(slotForPhysicalIndex(2), { dataTransfer });
    fireEvent.drop(slotForPhysicalIndex(2), { dataTransfer });

    expect(slotForPhysicalIndex(2)).toHaveAttribute("data-physical-instance-id", "instance-2");
    expect(artworkForPhysicalIndex(2)).toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);
    fireEvent.click(bodyButtonForPhysicalIndex(2));
    expect(onSelectArtwork).not.toHaveBeenCalled();
  });

  it("does not offer local flip when no alternate artwork is available", () => {
    render(compositorWorkspace([simpleCardWithBackMode("none")], {
      ...DEFAULT_PROJECT_SETTINGS,
      missingBackPolicy: "block",
      layout: { skippedSlotIndices: [] },
    }));

    expect(slotForPhysicalIndex(0).querySelector("[data-compositor-local-flip]")).not.toBeInTheDocument();
  });

  it("opens the floating context menu on right click and configures semantic Back through the existing picker", async () => {
    const user = userEvent.setup();
    const onSelectArtwork = vi.fn();
    const onPhysicalAction = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, onSelectArtwork, false, undefined, onPhysicalAction));
    const firstSlot = slotForPhysicalIndex(0);

    expect(fireEvent.contextMenu(firstSlot)).toBe(false);
    const menu = screen.getByRole("menu", { name: /Ações para Island, cópia 1/i });
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: "fixed" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Trocar artwork",
      "Configurar verso/face",
      "Aumentar quantidade",
      "Remover uma cópia",
      "Duplicar como entrada independente",
      "Configurações completas",
      "Remover carta inteira",
    ]);
    expect(onSelectArtwork).not.toHaveBeenCalled();
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "false");
    expect(fireEvent.contextMenu(sheet())).toBe(true);

    const configureBack = within(menu).getByRole("menuitem", { name: "Configurar verso/face" });
    await user.click(configureBack);
    expect(onSelectArtwork).toHaveBeenCalledWith("compositor-card", "instance-1", 0, "back", bodyButtonForPhysicalIndex(0), 1, 2);
    expect(onPhysicalAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens one menu for the kebab target and navigates it by keyboard", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, vi.fn(), false, undefined, vi.fn()));

    const secondActions = screen.getByRole("button", { name: "Mais ações para Island, cópia 2 de 2" });
    await user.click(secondActions);
    expect(secondActions).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Trocar artwork" }));
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Configurar verso/face" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Remover carta inteira" }));
    expect(screen.queryByRole("menuitem", { name: /Mover antes|Mover depois|Girar|Disable slot/i })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(secondActions);
    expect(secondActions).toHaveAttribute("aria-expanded", "false");
  });

  it("restores focus to the kebab after a non-destructive menu action", async () => {
    const user = userEvent.setup();
    const onPhysicalAction = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], undefined, false, undefined, false, undefined, onPhysicalAction));

    const actions = screen.getByRole("button", { name: "Mais ações para Island, cópia 1 de 2" });
    await user.click(actions);
    await user.click(screen.getByRole("menuitem", { name: "Aumentar quantidade" }));

    expect(onPhysicalAction).toHaveBeenCalledWith("increase", "instance-1", "compositor-card");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(actions));
  });

  it("replaces the target on another right click without changing multi-selection", async () => {
    const order = createPhysicalOrder([{ ...card(), quantity: 3 }]);
    render(compositorWorkspace([{ ...card(), quantity: 3 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, undefined, true, order, vi.fn()));
    fireEvent.click(checkboxForPhysicalIndex(0));

    expect(fireEvent.contextMenu(bodyButtonForPhysicalIndex(0), { clientX: 20, clientY: 30 })).toBe(false);
    expect(screen.getByRole("menu")).toHaveTextContent("Cópia 1/3");
    expect(fireEvent.contextMenu(bodyButtonForPhysicalIndex(1), { clientX: 40, clientY: 50 })).toBe(false);

    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu")).toHaveTextContent("Cópia 2/3");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "false");
  });

  it("closes the context menu when its physical instance is removed and keeps it closed after undo restores that ID", async () => {
    const user = userEvent.setup();
    const cards = [{ ...card(), quantity: 2 }];
    const order = createPhysicalOrder(cards);
    render(compositorWorkspace(cards, { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, undefined, false, order, vi.fn(), false, true));

    fireEvent.click(flipButtonForPhysicalIndex(1));
    await user.click(bodyButtonForPhysicalIndex(1));
    await user.click(screen.getByRole("button", { name: /mais ações para Island, cópia 2/i }));
    expect(screen.getByRole("menu")).toHaveTextContent("Cópia 2/2");
    await user.click(screen.getByRole("menuitem", { name: "Remover uma cópia" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remover uma cópia" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".compositor-sheet-scroll")));
    await user.click(screen.getByRole("button", { name: "Undo test removal" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(artworkForPhysicalIndex(1)).toHaveAttribute("data-compositor-artwork", artworkFront.candidateId);
  });

  it("closes the context menu on outside pointer, scroll, resize, and page change", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 11 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { rows: 1, columns: 3, skippedSlotIndices: [] } }, false, undefined, false, undefined, vi.fn()));
    const openMenu = async () => user.click(screen.getByRole("button", { name: "Mais ações para Island, cópia 1 de 11" }));
    await openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await openMenu();
    fireEvent.scroll(sheet());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await openMenu();
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await openMenu();
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("clamps the right-click menu inside the viewport after measuring it", async () => {
    const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("compositor-context-menu")) {
        return { x: 0, y: 0, left: 0, top: 0, right: 160, bottom: 180, width: 160, height: 180, toJSON: () => ({}) };
      }
      return originalRect.call(this);
    });
    try {
      render(compositorWorkspace([{ ...card(), quantity: 1 }], undefined, false, undefined, false, undefined, vi.fn()));
      fireEvent.contextMenu(bodyButtonForPhysicalIndex(0), { clientX: 350, clientY: 230 });
      await waitFor(() => expect(screen.getByRole("menu")).toHaveStyle({ left: "192px", top: "52px" }));
    } finally {
      if (innerWidthDescriptor) Object.defineProperty(window, "innerWidth", innerWidthDescriptor);
      if (innerHeightDescriptor) Object.defineProperty(window, "innerHeight", innerHeightDescriptor);
      vi.restoreAllMocks();
    }
  });

  it("blocks context-menu mutations and drag initiation while the compositor is busy", async () => {
    const user = userEvent.setup();
    const onPhysicalAction = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, undefined, true, undefined, onPhysicalAction, true));
    const slot = slotForPhysicalIndex(0);
    expect(slot).toHaveAttribute("draggable", "false");
    await user.click(slot);
    await user.click(screen.getByRole("button", { name: /mais ações para Island, cópia 1/i }));
    expect(screen.getByRole("menuitem", { name: "Aumentar quantidade" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Duplicar como entrada independente" })).toBeDisabled();

    const dataTransfer = { effectAllowed: "none", setData: vi.fn(), getData: vi.fn(() => "instance-1") };
    expect(fireEvent.dragStart(slot, { dataTransfer })).toBe(false);
    expect(onPhysicalAction).not.toHaveBeenCalled();
  });

  it("rejects drops into skipped and registration-reserved slots without changing physical order", () => {
    const dataTransfer = { effectAllowed: "none", setData: vi.fn(), getData: vi.fn(() => "instance-1") };
    const skippedSettings: ProjectSettingsV2 = {
      ...DEFAULT_PROJECT_SETTINGS,
      layout: { rows: 1, columns: 3, skippedSlotIndices: [1] },
    };
    const skipped = render(compositorWorkspace([{ ...card(), quantity: 2 }], skippedSettings, false, undefined, true));
    const firstCard = sheet().querySelector('g[data-physical-card-index="0"]')!;
    const skippedSlot = sheet().querySelector('g[aria-label^="Slot 2 desativado"]')!;
    fireEvent.dragStart(firstCard, { dataTransfer });
    fireEvent.dragOver(skippedSlot, { dataTransfer });
    fireEvent.drop(skippedSlot, { dataTransfer });
    expect(screen.getByText(/Drop rejeitado: slot ignorado não recebe cartas/)).toBeInTheDocument();
    expect(skippedSlot).toHaveClass("is-invalid-drop");
    expect(firstCard).not.toHaveClass("is-invalid-drop");
    expect(sheet().querySelector('g[data-physical-card-index="0"]')).toHaveAttribute("data-physical-instance-id", "instance-1");

    skipped.unmount();
    const geometryProbe = render(compositorWorkspace([{ ...card(), quantity: 2 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { rows: 1, columns: 3, skippedSlotIndices: [] } }));
    const firstSlotGeometry = geometryProbe.container.querySelector('g[data-physical-card-index="0"]')!;
    const reservedX = Number(firstSlotGeometry.getAttribute("data-slot-x-mm")) + 1;
    const reservedY = Number(firstSlotGeometry.getAttribute("data-slot-y-mm")) + 1;
    geometryProbe.unmount();
    const reservedSettings: ProjectSettingsV2 = {
      ...DEFAULT_PROJECT_SETTINGS,
      registration: {
        type: "custom", orientation: "portrait", marks: [[{ type: "line", x1Mm: 1, y1Mm: 1, x2Mm: 2, y2Mm: 2, strokeWidthMm: 0.2 }]],
        reservedZones: [{ xMm: reservedX, yMm: reservedY, widthMm: 4, heightMm: 4 }],
      },
      layout: { rows: 1, columns: 3, skippedSlotIndices: [] },
    };
    render(compositorWorkspace([{ ...card(), quantity: 2 }], reservedSettings, false, undefined, true));
    const layoutAlert = screen.queryByRole("alert");
    if (layoutAlert) throw new Error(layoutAlert.textContent ?? "Compositor layout failed.");
    const reservedSlot = sheet().querySelector('g[aria-label^="Slot 1 reservado"]');
    expect(reservedSlot).not.toBeNull();
    const cardSlot = sheet().querySelector('g[data-physical-card-index="0"]')!;
    fireEvent.dragStart(cardSlot, { dataTransfer });
    fireEvent.dragOver(reservedSlot!, { dataTransfer });
    fireEvent.drop(reservedSlot!, { dataTransfer });
    expect(screen.getByText(/Drop rejeitado: slot reservado permanece vazio/)).toBeInTheDocument();
    expect(reservedSlot).toHaveClass("is-invalid-drop");
    expect(cardSlot).not.toHaveClass("is-invalid-drop");
    expect(sheet().querySelector('g[data-physical-card-index="0"]')).toHaveAttribute("data-physical-instance-id", "instance-1");
  });

  it("uses an accessible checkbox as selection feedback without changing artwork, geometry, or Project state", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 2 }]));
    const revision = screen.getByTestId("project-revision").textContent;
    const firstSlot = slotForPhysicalIndex(0);
    const secondSlot = slotForPhysicalIndex(1);
    const originalViewBox = sheet().getAttribute("viewBox");
    const originalTrim = firstSlot.querySelector('[data-compositor-layer="trim"]');
    const originalTrimGeometry = ["x", "y", "width", "height"].map((attribute) => originalTrim?.getAttribute(attribute));
    const originalSelectedArtwork = secondSlot.querySelector("image[data-compositor-artwork]")?.outerHTML;

    expect(sheet().querySelectorAll("[data-compositor-selection-outline]")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Ações de seleção" })).not.toBeInTheDocument();
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-label", "Selecionar Island, cópia 2 de 2");
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "false");
    await user.click(checkboxForPhysicalIndex(1));

    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("group", { name: "Ações de seleção" })).toBeInTheDocument();
    expect(sheet().querySelectorAll("[data-compositor-selection-outline]")).toHaveLength(0);
    expect(["x", "y", "width", "height"].map((attribute) => firstSlot.querySelector('[data-compositor-layer="trim"]')?.getAttribute(attribute)))
      .toEqual(originalTrimGeometry);
    expect(secondSlot.querySelector("image[data-compositor-artwork]")?.outerHTML).toBe(originalSelectedArtwork);
    expect(sheet()).toHaveAttribute("viewBox", originalViewBox);
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
  });

  it("follows rounded card corners while preserving mobile tap and keyboard focus affordances", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 1 }], {
      ...DEFAULT_PROJECT_SETTINGS,
      roundedCorners: true,
      layout: { skippedSlotIndices: [] },
    }));

    const checkbox = checkboxForPhysicalIndex(0);
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    await user.keyboard(" ");
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "true");
    expect(slotForPhysicalIndex(0).querySelector("[data-compositor-selection-outline]")).toBeNull();
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

  it("keeps the active physical context stable while browsing a different page", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([card()]));

    await user.click(screen.getByRole("button", { name: /carta física 2.*cópia 2 de 10/i }));
    expect(screen.getByTestId("active-physical-card")).toHaveAttribute("data-active-physical-card-index", "1");
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(screen.getByRole("group", { name: /Compositor live frente.*página 2 de 2/ })).toHaveAttribute("data-active-physical-card-index", "none");
    expect(screen.getByTestId("active-physical-card")).toHaveAttribute("data-active-physical-card-index", "1");
    expect(screen.queryByRole("button", { name: /carta física 2.*cópia 2 de 10/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Página anterior" }));
    expect(screen.getByTestId("active-physical-card")).toHaveAttribute("data-active-physical-card-index", "1");
    expect(bodyButtonForPhysicalIndex(1)).toHaveAttribute("aria-current", "true");
  });

  it("keeps checkbox selection keyed to the physical ID after a cross-page reorder", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 10 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, undefined, true));

    await user.click(checkboxForPhysicalIndex(1));
    await user.click(bodyButtonForPhysicalIndex(1));
    const dataTransfer = { effectAllowed: "none", setData: vi.fn(), getData: vi.fn(() => "instance-2") };
    fireEvent.dragStart(slotForPhysicalIndex(1), { dataTransfer });
    fireEvent.dragOver(screen.getByRole("button", { name: "Próxima página" }), { dataTransfer });
    expect(sheet()).toHaveAttribute("data-compositor-page", "2");

    fireEvent.drop(slotForPhysicalIndex(9), { dataTransfer });

    expect(sheet()).toHaveAttribute("data-compositor-page", "2");
    expect(slotForPhysicalIndex(9)).toHaveAttribute("data-physical-instance-id", "instance-2");
    expect(bodyButtonForPhysicalIndex(9)).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("active-physical-card")).toHaveAttribute("data-active-physical-instance-id", "instance-2");
    expect(screen.getByTestId("active-physical-card")).toHaveAttribute("data-active-physical-card-index", "9");
    expect(checkboxForPhysicalIndex(9)).toHaveAttribute("aria-checked", "true");
  });

  it("drops on a final eligible empty slot as insertion at the end of the physical sequence", () => {
    render(compositorWorkspace([{ ...card(), quantity: 2 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { rows: 1, columns: 3, skippedSlotIndices: [] } }, false, undefined, true));
    const dataTransfer = { effectAllowed: "none", setData: vi.fn(), getData: vi.fn(() => "instance-1") };
    const source = sheet().querySelector('g[data-physical-card-index="0"]')!;
    const emptyEnd = sheet().querySelector('g[aria-label^="Slot 3 vazio"]')!;
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(emptyEnd, { dataTransfer });
    fireEvent.drop(emptyEnd, { dataTransfer });

    expect(sheet().querySelector('g[data-physical-card-index="0"]')).toHaveAttribute("data-physical-instance-id", "instance-2");
    expect(sheet().querySelector('g[data-physical-card-index="1"]')).toHaveAttribute("data-physical-instance-id", "instance-1");
    expect(screen.getByTestId("active-physical-card")).toHaveAttribute("data-active-physical-card-index", "1");
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

    await user.click(screen.getByRole("button", { name: "Desativar slot da carta ativa" }));

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
    const compositor = screen.getByRole("group", { name: /Compositor live/ });
    const physicalPlanSignature = Array.from(compositor.querySelectorAll("[data-slot-x-mm]"))
      .map((slot) => [slot.getAttribute("data-slot-x-mm"), slot.getAttribute("data-slot-y-mm")]);
    const physicalViewBox = compositor.getAttribute("viewBox");
    expect(compositor.querySelector("image[data-compositor-artwork]")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='bleed']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='cut']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='silhouette']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='margins']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-compositor-layer='registration']")).not.toBeInTheDocument();
    expect(compositor.querySelector("[data-calibrated-print-content]")).toHaveAttribute("data-calibrated-print-content", "false");

    await user.click(screen.getByRole("button", { name: "Aumentar zoom" }));
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
    expect(Array.from(compositor.querySelectorAll("[data-slot-x-mm]"))
      .map((slot) => [slot.getAttribute("data-slot-x-mm"), slot.getAttribute("data-slot-y-mm")])).toEqual(physicalPlanSignature);
    expect(compositor).toHaveAttribute("viewBox", physicalViewBox);
    await user.click(screen.getByRole("button", { name: "100%" }));
    expect(compositor).toHaveAttribute("data-compositor-zoom-scale", "1");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
    expect(Array.from(compositor.querySelectorAll("[data-slot-x-mm]"))
      .map((slot) => [slot.getAttribute("data-slot-x-mm"), slot.getAttribute("data-slot-y-mm")])).toEqual(physicalPlanSignature);
    expect(screen.getByRole("button", { name: "Fit Page" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryAllByTitle(/PDF/)).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: "Conferir PDF final" })).not.toBeInTheDocument();
  });
});
