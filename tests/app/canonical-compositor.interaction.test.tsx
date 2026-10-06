// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkingCard } from "../../core/cards/types";
import { createPhysicalOrder, movePhysicalInstance, type PhysicalOrder } from "../../core/cards/physical-instance-order";
import { selectManualBackArtwork } from "../../core/cards/back-selection";
import { createIdentitySideCalibration, type PrinterProfileSnapshot } from "../../core/calibration";
import { createDefaultRegistrationConfig } from "../../core/registration";
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettingsV2 } from "../../persistence/projects/serializer";
import RegistrationLayoutPreview from "../../src/app/registration-layout-preview";
import WorkspaceShell from "../../src/app/workspace-shell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    const [activeOccupiedSlotIndex, setActiveOccupiedSlotIndex] = useState<number | null>(null);
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
    const toggleSkippedSlot = (index: number) => changeSettings((current) => ({
      ...current,
      layout: {
        ...current.layout,
        skippedSlotIndices: current.layout.skippedSlotIndices.includes(index)
          ? current.layout.skippedSlotIndices.filter((slotIndex) => slotIndex !== index)
          : [...current.layout.skippedSlotIndices, index],
      },
    }));
    const sections = {
      cards: <p>cards</p>,
      settings: <>
        <label>Margem esquerda<input aria-label="Margem esquerda" type="number" value={settings.marginsMm.left} onChange={(event) => { const value = Number(event.currentTarget.value); changeSettings((current) => ({ ...current, marginsMm: { ...current.marginsMm, left: value } })); }} /></label>
        <label>Bleed do Project<input aria-label="Bleed do Project" type="number" step="0.125" value={settings.bleedMm} onChange={(event) => { const value = Number(event.currentTarget.value); changeSettings((current) => ({ ...current, bleedMm: value })); }} /></label>
        <button type="button" onClick={() => setCards((current) => current.map((entry) => ({ ...entry, selectedArtworkByFace: { ...entry.selectedArtworkByFace, front: artworkFrontNext } })))}>Selecionar artwork alternativa</button>
        <label>Offset de calibração<input aria-label="Offset de calibração" type="number" value={settings.printerProfileSelection?.front.offsetXUm ?? 0} onChange={(event) => { const value = Number(event.currentTarget.value); changeSettings((current) => ({ ...current, printerProfileSelection: { ...calibrationProfile, front: { ...calibrationProfile.front, offsetXUm: value } } })); }} /></label>
        {activeOccupiedSlotIndex !== null && <button type="button" onClick={() => toggleSkippedSlot(activeOccupiedSlotIndex)}>Desativar slot da carta ativa</button>}
      </>,
      export: <p>export</p>,
    };
    return <>
      <output data-testid="project-revision">{projectRevision}</output>
      <output data-testid="active-physical-instance-id">{activePhysicalInstanceId ?? "none"}</output>
      <output data-testid="physical-order-ids">{physicalOrder.instances.map(({ id }) => id).join(",")}</output>
      <output data-testid="skipped-slot-indices">{settings.layout.skippedSlotIndices.join(",")}</output>
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
          onActiveOccupiedSlotChange={setActiveOccupiedSlotIndex}
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
            toggleSkippedSlot(index);
          }}
        />}
      />
    </>;
  }
  return <Harness />;
}

function pointerLifecycleWorkspace() {
  const cards = [{ ...card(), quantity: 3 }];
  const settings: ProjectSettingsV2 = { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } };
  function Harness() {
    const [physicalOrder, setPhysicalOrder] = useState(() => createPhysicalOrder(cards));
    const [documentRevision, setDocumentRevision] = useState(0);
    const [interactionBusy, setInteractionBusy] = useState(false);
    return <>
      <output data-testid="lifecycle-order">{physicalOrder.instances.map(({ id }) => id).join(",")}</output>
      <button type="button" onClick={() => setInteractionBusy(true)}>Set interaction busy</button>
      <button type="button" onClick={() => setDocumentRevision((revision) => revision + 1)}>Change document revision</button>
      <button type="button" onClick={() => setPhysicalOrder((current) => ({ ...current, instances: current.instances.filter(({ id }) => id !== "instance-3") }))}>Remove drag source</button>
      <RegistrationLayoutPreview
        settings={settings}
        cardCount={physicalOrder.instances.length}
        cards={cards}
        physicalOrder={physicalOrder}
        documentRevision={documentRevision}
        interactionBusy={interactionBusy}
        selectedPageNumber={1}
        onSelectPage={() => undefined}
        onToggleSkippedSlot={() => undefined}
        onReorderPhysicalInstance={(instanceId, targetInstanceId, placement) => setPhysicalOrder((current) => movePhysicalInstance(current, instanceId, targetInstanceId, placement))}
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

function bodyButtonForPhysicalInstanceId(instanceId: string) {
  const body = Array.from(sheet().querySelectorAll<SVGRectElement>('[data-compositor-card-body="true"]'))
    .find((candidate) => candidate.dataset.physicalInstanceId === instanceId);
  if (!body) throw new Error(`Physical instance ${instanceId} has no visible body activation control.`);
  return body;
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

function displayArtworkForPhysicalIndex(index: number) {
  const artwork = slotForPhysicalIndex(index).querySelector("image[data-compositor-display-url]");
  if (!artwork) throw new Error("Physical card " + index + " has no compositor display request.");
  return artwork;
}

function setClientRect(element: Element, bounds: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    ...bounds,
    x: bounds.left,
    y: bounds.top,
    right: bounds.left + bounds.width,
    bottom: bounds.top + bounds.height,
    toJSON: () => ({}),
  } as DOMRect);
}

function startBodyPointerDrag(body: Element, pointerId: number, clientX = 20, clientY = 20) {
  fireEvent.pointerDown(body, { pointerId, pointerType: "mouse", isPrimary: true, button: 0, clientX, clientY });
  fireEvent.pointerMove(body, { pointerId, pointerType: "mouse", buttons: 1, clientX: clientX + 6, clientY });
}

function movePointerDrag(target: Element, pointerId: number, clientX: number, clientY: number) {
  fireEvent.pointerMove(target, { pointerId, pointerType: "mouse", buttons: 1, clientX, clientY });
}

function dropPointerDrag(target: Element, pointerId: number, clientX: number, clientY: number) {
  fireEvent.pointerUp(target, { pointerId, pointerType: "mouse", button: 0, clientX, clientY });
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
  it("keeps thumbnails visible until the bucketed display image loads and reuses URLs for repeated copies", () => {
    const originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    render(compositorWorkspace([{ ...card(), quantity: 2 }]));

    const firstDisplay = displayArtworkForPhysicalIndex(0);
    const secondDisplay = displayArtworkForPhysicalIndex(1);
    const fallbackImages = sheet().querySelectorAll("image[data-compositor-source='preview-thumbnail']");
    const displayUrl = firstDisplay.getAttribute("data-compositor-display-url")!;

    expect(fallbackImages).toHaveLength(2);
    expect(firstDisplay.getAttribute("href")).toContain("/api/cards/artworks/");
    expect(displayUrl).toContain("/display?");
    expect(new URL(displayUrl, "http://localhost").searchParams.get("width")).toBe("768");
    expect(secondDisplay.getAttribute("data-compositor-display-url")).toBe(displayUrl);
    expect(firstDisplay).toHaveAttribute("data-compositor-source", "display-high-fidelity-pending");

    fireEvent.load(firstDisplay);
    expect(firstDisplay).toHaveAttribute("data-compositor-source", "display-high-fidelity");
    expect(firstDisplay).toHaveAttribute("opacity", "1");
    expect(sheet().querySelectorAll("image[data-compositor-source='preview-thumbnail']")).toHaveLength(2);
    expect(screen.getByTestId("project-revision")).toHaveTextContent("1");
    if (originalDpr) Object.defineProperty(window, "devicePixelRatio", originalDpr);
    else Reflect.deleteProperty(window, "devicePixelRatio");
  });

  it("leaves the thumbnail visible after display failure and carries bleed geometry on the HQ URL", () => {
    render(compositorWorkspace([{ ...card(), quantity: 1 }], { ...DEFAULT_PROJECT_SETTINGS, bleedMm: 1.25, roundedCorners: true, layout: { skippedSlotIndices: [] } }));
    const display = displayArtworkForPhysicalIndex(0);
    const url = new URL(display.getAttribute("data-compositor-display-url")!, "http://localhost");

    expect(url.pathname).toContain("/display");
    expect(url.searchParams.get("bleedMm")).toBe("1.25");
    expect(url.searchParams.get("trimWidthMm")).toBe(String(DEFAULT_PROJECT_SETTINGS.cardFormat.widthMm));
    expect(url.searchParams.get("roundedCorners")).toBe("true");
    expect(url.searchParams.get("cornerRadiusMm")).toBe(String(DEFAULT_PROJECT_SETTINGS.cardFormat.cornerRadiusMm ?? 3.175));

    fireEvent.error(display);
    expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-source", "preview-thumbnail");
    expect(display).toHaveAttribute("data-compositor-source", "display-high-fidelity-pending");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-revision")).toHaveTextContent("1");
  });

  it("retries a failed display request and promotes the later high-fidelity load", () => {
    vi.useFakeTimers();
    try {
      render(compositorWorkspace([{ ...card(), quantity: 1 }]));
      const initialDisplay = displayArtworkForPhysicalIndex(0);
      const initialUrl = initialDisplay.getAttribute("data-compositor-display-url")!;

      fireEvent.error(initialDisplay);
      expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-source", "preview-thumbnail");
      expect(artworkForPhysicalIndex(0)).toHaveAttribute("opacity", "1");
      expect(initialDisplay).toHaveAttribute("data-compositor-source", "display-high-fidelity-pending");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(500));
      const retry = displayArtworkForPhysicalIndex(0);
      const retryUrl = new URL(retry.getAttribute("data-compositor-display-url")!, "http://localhost");
      expect(retryUrl.searchParams.get("retry")).toBe("1");
      expect(retryUrl.searchParams.get("width")).toBe(new URL(initialUrl, "http://localhost").searchParams.get("width"));

      fireEvent.load(retry);
      expect(retry).toHaveAttribute("data-compositor-source", "display-high-fidelity");
      expect(retry).toHaveAttribute("opacity", "1");
      expect(artworkForPhysicalIndex(0)).toHaveAttribute("opacity", "0");
      expect(screen.getByTestId("project-revision")).toHaveTextContent("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retry URLs shared between repeated copies of the same artwork", () => {
    vi.useFakeTimers();
    try {
      render(compositorWorkspace([{ ...card(), quantity: 2 }]));
      const first = displayArtworkForPhysicalIndex(0);
      const second = displayArtworkForPhysicalIndex(1);
      const initialUrl = new URL(first.getAttribute("data-compositor-display-url")!, "http://localhost");
      expect(first.getAttribute("data-compositor-display-url")).toBe(second.getAttribute("data-compositor-display-url"));

      fireEvent.error(first);
      fireEvent.error(second);
      act(() => vi.advanceTimersByTime(500));

      const firstRetryUrl = new URL(displayArtworkForPhysicalIndex(0).getAttribute("data-compositor-display-url")!, "http://localhost");
      const secondRetryUrl = new URL(displayArtworkForPhysicalIndex(1).getAttribute("data-compositor-display-url")!, "http://localhost");
      expect(firstRetryUrl.href).toBe(secondRetryUrl.href);
      expect(firstRetryUrl.searchParams.get("retry")).toBe("1");
      expect(firstRetryUrl.searchParams.get("width")).toBe(initialUrl.searchParams.get("width"));
      expect(firstRetryUrl.searchParams.has("physicalInstanceId")).toBe(false);

      fireEvent.load(displayArtworkForPhysicalIndex(0));
      expect(displayArtworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-source", "display-high-fidelity");
      expect(displayArtworkForPhysicalIndex(1)).toHaveAttribute("data-compositor-source", "display-high-fidelity-pending");
      expect(artworkForPhysicalIndex(1)).toHaveAttribute("data-compositor-source", "preview-thumbnail");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds display retries and clears pending retries when artwork, face, or page changes", () => {
    vi.useFakeTimers();
    try {
      render(compositorWorkspace([{ ...card(), quantity: 10 }]));
      const initialDisplay = displayArtworkForPhysicalIndex(0);
      fireEvent.error(initialDisplay);
      act(() => vi.advanceTimersByTime(500));

      let display = displayArtworkForPhysicalIndex(0);
      expect(new URL(display.getAttribute("data-compositor-display-url")!, "http://localhost").searchParams.get("retry")).toBe("1");
      fireEvent.error(display);
      act(() => vi.advanceTimersByTime(500));

      display = displayArtworkForPhysicalIndex(0);
      expect(new URL(display.getAttribute("data-compositor-display-url")!, "http://localhost").searchParams.get("retry")).toBe("2");
      fireEvent.error(display);
      act(() => vi.advanceTimersByTime(5_000));
      expect(displayArtworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-display-url", expect.stringContaining("retry=2"));
      expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-source", "preview-thumbnail");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByTestId("project-revision")).toHaveTextContent("1");

      fireEvent.error(displayArtworkForPhysicalIndex(0));
      fireEvent.click(screen.getByRole("tab", { name: "Configurações" }));
      fireEvent.click(screen.getByRole("button", { name: "Selecionar artwork alternativa" }));
      expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-artwork", artworkFrontNext.candidateId);
      act(() => vi.advanceTimersByTime(500));
      display = displayArtworkForPhysicalIndex(0);
      expect(display).toHaveAttribute("data-compositor-source", "display-high-fidelity-pending");
      expect(display.getAttribute("data-compositor-display-url")).not.toContain("retry=");

      fireEvent.error(display);
      fireEvent.click(screen.getByRole("button", { name: "Verso" }));
      expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);
      act(() => vi.advanceTimersByTime(500));
      display = displayArtworkForPhysicalIndex(0);
      expect(display).toHaveAttribute("data-compositor-source", "display-high-fidelity-pending");
      expect(display.getAttribute("data-compositor-display-url")).not.toContain("retry=");

      fireEvent.error(display);
      fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));
      expect(sheet()).toHaveAttribute("data-compositor-page", "2");
      act(() => vi.advanceTimersByTime(500));
      const pageTwoDisplay = displayArtworkForPhysicalIndex(9);
      expect(pageTwoDisplay).toHaveAttribute("data-compositor-source", "display-high-fidelity-pending");
      expect(pageTwoDisplay.getAttribute("data-compositor-display-url")).not.toContain("retry=");
      expect(screen.getByTestId("project-revision")).toHaveTextContent("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes the display URL only when auto-fit resize crosses a bucket boundary", () => {
    let viewportWidth = 540;
    vi.stubGlobal("ResizeObserver", undefined);
    const originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() { return this.classList.contains("compositor-sheet-scroll") ? viewportWidth : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return this.classList.contains("compositor-sheet-scroll") ? 900 : 0; },
    });
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      paperFormat: { name: "Test square", widthMm: 100, heightMm: 100 },
      cardFormat: { ...DEFAULT_PROJECT_SETTINGS.cardFormat, widthMm: 50, heightMm: 70 },
      bleedMm: 0,
      layout: { rows: 1, columns: 1, skippedSlotIndices: [] },
    };
    try {
      render(compositorWorkspace([{ ...card(), quantity: 1 }], settings));
      const displayUrl = () => displayArtworkForPhysicalIndex(0).getAttribute("data-compositor-display-url")!;
      const initialUrl = displayUrl();
      expect(new URL(initialUrl, "http://localhost").searchParams.get("width")).toBe("512");

      viewportWidth = 541;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(displayUrl()).toBe(initialUrl);

      viewportWidth = 560;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(displayUrl()).not.toBe(initialUrl);
      expect(new URL(displayUrl(), "http://localhost").searchParams.get("width")).toBe("768");
      expect(screen.getByTestId("project-revision")).toHaveTextContent("1");
    } finally {
      if (originalWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalWidth);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
      if (originalHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
      if (originalDpr) Object.defineProperty(window, "devicePixelRatio", originalDpr);
      else Reflect.deleteProperty(window, "devicePixelRatio");
    }
  });

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
    expect(main.querySelector("image[data-compositor-display-url]")).toHaveAttribute("data-compositor-display-url", expect.stringContaining("/api/cards/artworks/"));

    expect(sheet()).toHaveAttribute("data-compositor-page", "1");
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(sheet()).toHaveAttribute("data-compositor-page", "2");

    await user.click(screen.getByRole("button", { name: "Frente" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Offset de calibração" }));
    await user.type(screen.getByRole("spinbutton", { name: "Offset de calibração" }), "500");
    expect(sheet()).not.toHaveAttribute("data-compositor-calibration-matrix", "identity");
    expect(sheet().querySelector("[data-calibrated-print-content]"))
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
    expect(sheet()).toHaveAttribute("data-active-physical-card-index", "1");
    expect(screen.queryByText(/Carta física 2 · Island · cópia 2\/3/)).not.toBeInTheDocument();
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
    expect(sheet()).toHaveAttribute("data-active-physical-card-index", "1");
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
    const onSelectArtwork = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], undefined, false, onSelectArtwork, true, undefined, onPhysicalAction));

    await user.click(checkboxForPhysicalIndex(0));
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("none");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.pointerDown(checkboxForPhysicalIndex(0), { pointerId: 26, pointerType: "mouse", isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(checkboxForPhysicalIndex(0), { pointerId: 26, pointerType: "mouse", buttons: 1, clientX: 50, clientY: 60 });
    fireEvent.pointerUp(checkboxForPhysicalIndex(0), { pointerId: 26, pointerType: "mouse", button: 0, clientX: 50, clientY: 60 });
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(slotForPhysicalIndex(0)).not.toHaveClass("is-drag-source");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("none");
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2");

    const kebab = slotForPhysicalIndex(0).querySelector<HTMLButtonElement>("[data-compositor-context-trigger]");
    expect(kebab).not.toBeNull();
    fireEvent.pointerDown(kebab!, { pointerId: 27, pointerType: "mouse", isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(kebab!, { pointerId: 27, pointerType: "mouse", buttons: 1, clientX: 50, clientY: 60 });
    fireEvent.pointerUp(kebab!, { pointerId: 27, pointerType: "mouse", button: 0, clientX: 50, clientY: 60 });
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2");

    fireEvent.pointerDown(bodyButtonForPhysicalIndex(1), { pointerId: 28, pointerType: "mouse", isPrimary: true, button: 2, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(bodyButtonForPhysicalIndex(1), { pointerId: 28, pointerType: "mouse", buttons: 2, clientX: 80, clientY: 80 });
    fireEvent.pointerUp(bodyButtonForPhysicalIndex(1), { pointerId: 28, pointerType: "mouse", button: 2, clientX: 80, clientY: 80 });
    expect(fireEvent.contextMenu(bodyButtonForPhysicalIndex(1))).toBe(false);
    expect(screen.getByRole("menu", { name: /Ações para Island, cópia 2/i })).toBeInTheDocument();
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "false");
    expect(onPhysicalAction).not.toHaveBeenCalled();
    expect(onSelectArtwork).not.toHaveBeenCalled();
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
    const originalDisplay = displayArtworkForPhysicalIndex(0);
    const originalDisplayUrl = originalDisplay.getAttribute("data-compositor-display-url");
    expect(flip).toHaveAccessibleName("Ver verso de Island, cópia 1");
    expect(flip).toHaveAttribute("aria-pressed", "false");
    fireEvent.pointerDown(flip, { pointerId: 25, pointerType: "mouse", isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(flip, { pointerId: 25, pointerType: "mouse", buttons: 1, clientX: 40, clientY: 20 });
    fireEvent.pointerUp(flip, { pointerId: 25, pointerType: "mouse", button: 0, clientX: 40, clientY: 20 });
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent(order ?? "");
    await user.click(flip);

    expect(flipButtonForPhysicalIndex(0)).toHaveAttribute("aria-pressed", "true");
    expect(artworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);
    const flippedDisplay = displayArtworkForPhysicalIndex(0);
    expect(flippedDisplay).toHaveAttribute("data-compositor-face", "back");
    expect(flippedDisplay.getAttribute("data-compositor-display-url")).not.toBe(originalDisplayUrl);
    expect(flippedDisplay.getAttribute("data-compositor-display-url")).toContain(encodeURIComponent(artworkBack.candidateId));
    fireEvent.load(originalDisplay);
    expect(displayArtworkForPhysicalIndex(0)).toHaveAttribute("data-compositor-source", "display-high-fidelity-pending");
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

  it("keeps a local flip with its physical ID after pointer reorder and suppresses the residual click", () => {
    const onSelectArtwork = vi.fn();
    const order = createPhysicalOrder([{ ...card(), quantity: 3 }]);
    render(compositorWorkspace([{ ...card(), quantity: 3 }], undefined, false, onSelectArtwork, true, order));
    fireEvent.click(flipButtonForPhysicalIndex(1));

    const source = bodyButtonForPhysicalIndex(1);
    const target = bodyButtonForPhysicalIndex(2);
    setClientRect(target, { left: 100, top: 100, width: 60, height: 84 });
    startBodyPointerDrag(source, 11);
    movePointerDrag(target, 11, 145, 120);
    dropPointerDrag(target, 11, 145, 120);

    const movedSlot = slotForPhysicalIndex(2);
    expect(movedSlot).toHaveAttribute("data-physical-instance-id", "instance-2");
    expect(artworkForPhysicalIndex(2)).toHaveAttribute("data-compositor-artwork", artworkBack.candidateId);
    fireEvent.click(bodyButtonForPhysicalIndex(2));
    expect(onSelectArtwork).not.toHaveBeenCalled();
    fireEvent.pointerDown(bodyButtonForPhysicalIndex(2), { pointerId: 12, pointerType: "mouse", isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(bodyButtonForPhysicalIndex(2), { pointerId: 12, pointerType: "mouse", button: 0, clientX: 20, clientY: 20 });
    fireEvent.click(bodyButtonForPhysicalIndex(2));
    expect(onSelectArtwork).toHaveBeenCalledTimes(1);
  });

  it("promotes a body pointer gesture at 6px and inserts before the target without a picker", () => {
    const onSelectArtwork = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 4 }], undefined, false, onSelectArtwork, true));
    const source = bodyButtonForPhysicalIndex(3);
    const target = bodyButtonForPhysicalIndex(1);
    setClientRect(source, { left: 240, top: 100, width: 60, height: 84 });
    setClientRect(target, { left: 100, top: 100, width: 60, height: 84 });

    fireEvent.pointerDown(source, { pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, clientX: 250, clientY: 110 });
    fireEvent.pointerMove(source, { pointerId: 7, pointerType: "mouse", buttons: 1, clientX: 256, clientY: 110 });

    const ghost = screen.getByTestId("compositor-drag-ghost");
    expect(ghost).toHaveStyle({ pointerEvents: "none" });
    expect(slotForPhysicalIndex(3)).toHaveClass("is-drag-source");
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2,instance-3,instance-4");

    fireEvent.pointerMove(target, { pointerId: 7, pointerType: "mouse", buttons: 1, clientX: 101, clientY: 110 });
    expect(target.closest("g[data-compositor-slot]")?.querySelector('[data-compositor-insertion-indicator="before"]')).toBeInTheDocument();
    fireEvent.pointerUp(target, { pointerId: 7, pointerType: "mouse", button: 0, clientX: 101, clientY: 110 });

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-4,instance-2,instance-3");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-4");
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(document.querySelector("[data-compositor-insertion-indicator]")).not.toBeInTheDocument();
    expect(onSelectArtwork).not.toHaveBeenCalled();

    const movedSourceBody = sheet().querySelector('[data-physical-instance-id="instance-4"] [data-compositor-card-body="true"]');
    expect(movedSourceBody).not.toBeNull();
    fireEvent.click(movedSourceBody!);
    expect(onSelectArtwork).not.toHaveBeenCalled();
    fireEvent.click(movedSourceBody!);
    expect(onSelectArtwork).toHaveBeenCalledTimes(1);
  });

  it("keeps a pointer movement below 6px as the normal body click", () => {
    const onSelectArtwork = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 1 }], undefined, false, onSelectArtwork, true));
    const body = bodyButtonForPhysicalIndex(0);

    fireEvent.pointerDown(body, { pointerId: 8, pointerType: "mouse", isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(body, { pointerId: 8, pointerType: "mouse", buttons: 1, clientX: 24, clientY: 23 });
    fireEvent.pointerUp(body, { pointerId: 8, pointerType: "mouse", button: 0, clientX: 24, clientY: 23 });
    fireEvent.click(body);

    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1");
    expect(onSelectArtwork).toHaveBeenCalledTimes(1);
  });

  it("moves only the dragged member of a multi-selection and keeps selection and active IDs", () => {
    render(compositorWorkspace([{ ...card(), quantity: 4 }], undefined, false, undefined, true));
    fireEvent.click(checkboxForPhysicalIndex(1));
    fireEvent.click(checkboxForPhysicalIndex(2));
    fireEvent.click(checkboxForPhysicalIndex(3));
    const source = bodyButtonForPhysicalIndex(2);
    const target = bodyButtonForPhysicalIndex(3);
    setClientRect(target, { left: 100, top: 100, width: 60, height: 84 });

    startBodyPointerDrag(source, 20);
    movePointerDrag(target, 20, 155, 120);
    dropPointerDrag(target, 20, 155, 120);

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2,instance-4,instance-3");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-3");
    expect(checkboxForPhysicalIndex(0)).toHaveAttribute("aria-checked", "false");
    expect(checkboxForPhysicalIndex(1)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(2)).toHaveAttribute("aria-checked", "true");
    expect(checkboxForPhysicalIndex(3)).toHaveAttribute("aria-checked", "true");
  });

  it("treats dropping on self and an adjacent insertion as no-ops", () => {
    const onSelectArtwork = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 3 }], undefined, false, onSelectArtwork, true));
    const revision = screen.getByTestId("project-revision").textContent;
    const source = bodyButtonForPhysicalIndex(0);
    setClientRect(source, { left: 100, top: 100, width: 60, height: 84 });

    startBodyPointerDrag(source, 21);
    movePointerDrag(source, 21, 120, 120);
    dropPointerDrag(source, 21, 120, 120);
    fireEvent.click(source);
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2,instance-3");
    expect(onSelectArtwork).not.toHaveBeenCalled();

    const adjacentTarget = bodyButtonForPhysicalIndex(1);
    setClientRect(adjacentTarget, { left: 100, top: 100, width: 60, height: 84 });
    startBodyPointerDrag(source, 22);
    movePointerDrag(adjacentTarget, 22, 101, 120);
    dropPointerDrag(adjacentTarget, 22, 101, 120);

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2,instance-3");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
    expect(onSelectArtwork).not.toHaveBeenCalled();
  });

  it("cleans up ghost and insertion feedback on pointercancel", () => {
    render(pointerLifecycleWorkspace());
    const source = bodyButtonForPhysicalIndex(2);
    startBodyPointerDrag(source, 29);
    expect(screen.getByTestId("compositor-drag-ghost")).toBeInTheDocument();
    fireEvent.pointerCancel(source, { pointerId: 29, pointerType: "mouse" });

    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(document.querySelector("[data-compositor-insertion-indicator]")).not.toBeInTheDocument();
    expect(screen.getByTestId("lifecycle-order")).toHaveTextContent("instance-1,instance-2,instance-3");
  });

  it("cancels an active pointer drag when interaction becomes busy or the document revision changes", () => {
    const busyView = render(pointerLifecycleWorkspace());
    startBodyPointerDrag(bodyButtonForPhysicalIndex(2), 30);
    expect(screen.getByTestId("compositor-drag-ghost")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set interaction busy" }));
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(screen.getByTestId("lifecycle-order")).toHaveTextContent("instance-1,instance-2,instance-3");
    busyView.unmount();

    render(pointerLifecycleWorkspace());
    startBodyPointerDrag(bodyButtonForPhysicalIndex(2), 31);
    expect(screen.getByTestId("compositor-drag-ghost")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change document revision" }));
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(screen.getByTestId("lifecycle-order")).toHaveTextContent("instance-1,instance-2,instance-3");
  });

  it("cancels when the source instance disappears during a pointer gesture", () => {
    render(pointerLifecycleWorkspace());
    startBodyPointerDrag(bodyButtonForPhysicalIndex(2), 32);
    expect(screen.getByTestId("compositor-drag-ghost")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove drag source" }));

    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(screen.getByTestId("lifecycle-order")).toHaveTextContent("instance-1,instance-2");
  });

  it("removes the drag overlay on compositor unmount", () => {
    const view = render(pointerLifecycleWorkspace());
    startBodyPointerDrag(bodyButtonForPhysicalIndex(2), 33);
    expect(screen.getByTestId("compositor-drag-ghost")).toBeInTheDocument();
    view.unmount();
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
  });

  it("supports global keyboard reorder with Alt+Arrow and preserves the physical ID", () => {
    render(compositorWorkspace([{ ...card(), quantity: 4 }], undefined, false, undefined, true));
    const source = bodyButtonForPhysicalIndex(3);

    fireEvent.keyDown(source, { key: "ArrowLeft", altKey: true });

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2,instance-4,instance-3");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-4");
    expect(source).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight");
    expect(screen.getByText(/posição 3 da ordem física/i)).toBeInTheDocument();
  });

  it("keeps keyboard focus on the same physical instance through repeated right reorder", () => {
    render(compositorWorkspace([{ ...card(), quantity: 4 }], undefined, false, undefined, true));
    const source = bodyButtonForPhysicalIndex(1);
    source.focus();

    fireEvent.keyDown(source, { key: "ArrowRight", altKey: true });

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-3,instance-2,instance-4");
    expect(document.activeElement).toBe(bodyButtonForPhysicalInstanceId("instance-2"));
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", altKey: true });

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-3,instance-4,instance-2");
    expect(document.activeElement).toBe(bodyButtonForPhysicalInstanceId("instance-2"));
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");
  });

  it("keeps keyboard focus on the same physical instance through repeated left reorder", () => {
    render(compositorWorkspace([{ ...card(), quantity: 4 }], undefined, false, undefined, true));
    const source = bodyButtonForPhysicalIndex(3);
    source.focus();

    fireEvent.keyDown(source, { key: "ArrowLeft", altKey: true });

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2,instance-4,instance-3");
    expect(document.activeElement).toBe(bodyButtonForPhysicalInstanceId("instance-4"));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", altKey: true });

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-4,instance-2,instance-3");
    expect(document.activeElement).toBe(bodyButtonForPhysicalInstanceId("instance-4"));
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-4");
  });

  it("restores keyboard focus after a reorder moves the instance across pages", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 4 }], {
      ...DEFAULT_PROJECT_SETTINGS,
      layout: { rows: 1, columns: 2, skippedSlotIndices: [] },
    }, false, undefined, true));
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    const source = bodyButtonForPhysicalIndex(2);
    source.focus();

    fireEvent.keyDown(source, { key: "ArrowLeft", altKey: true });

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-3,instance-2,instance-4");
    expect(sheet()).toHaveAttribute("data-compositor-page", "1");
    expect(document.activeElement).toBe(bodyButtonForPhysicalInstanceId("instance-3"));
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-3");

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", altKey: true });

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-3,instance-1,instance-2,instance-4");
    expect(document.activeElement).toBe(bodyButtonForPhysicalInstanceId("instance-3"));
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-3");
  });

  it("keeps focus and skips reorder callbacks at the physical order limits", () => {
    const cards = [{ ...card(), quantity: 2 }];
    const physicalOrder = createPhysicalOrder(cards);
    const onReorderPhysicalInstance = vi.fn();
    render(<RegistrationLayoutPreview
      settings={{ ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }}
      cardCount={2}
      cards={cards}
      physicalOrder={physicalOrder}
      activePhysicalInstanceId="instance-1"
      selectedPageNumber={1}
      onSelectPage={vi.fn()}
      onToggleSkippedSlot={vi.fn()}
      onReorderPhysicalInstance={onReorderPhysicalInstance}
    />);
    const first = bodyButtonForPhysicalIndex(0);
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowLeft", altKey: true });

    expect(document.activeElement).toBe(first);
    expect(onReorderPhysicalInstance).not.toHaveBeenCalled();

    const last = bodyButtonForPhysicalIndex(1);
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowRight", altKey: true });

    expect(document.activeElement).toBe(last);
    expect(onReorderPhysicalInstance).not.toHaveBeenCalled();
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

  it("keeps the context menu open during its own scroll and closes it on sheet scroll", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 11 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { rows: 1, columns: 3, skippedSlotIndices: [] } }, false, undefined, false, undefined, vi.fn()));

    await user.click(screen.getByRole("button", { name: "Mais ações para Island, cópia 1 de 11" }));
    const menu = screen.getByRole("menu");

    fireEvent.scroll(menu);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.scroll(sheet());
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
    await user.click(slot);
    await user.click(screen.getByRole("button", { name: /mais ações para Island, cópia 1/i }));
    expect(screen.getByRole("menuitem", { name: "Aumentar quantidade" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Duplicar como entrada independente" })).toBeDisabled();

    const revision = screen.getByTestId("project-revision").textContent;
    const order = screen.getByTestId("physical-order-ids").textContent;
    fireEvent.pointerDown(bodyButtonForPhysicalIndex(0), { pointerId: 14, pointerType: "mouse", isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(bodyButtonForPhysicalIndex(0), { pointerId: 14, pointerType: "mouse", clientX: 40, clientY: 20 });
    fireEvent.pointerUp(bodyButtonForPhysicalIndex(0), { pointerId: 14, pointerType: "mouse", clientX: 40, clientY: 20 });
    fireEvent.keyDown(bodyButtonForPhysicalIndex(0), { key: "ArrowRight", altKey: true });
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent(order ?? "");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
    expect(onPhysicalAction).not.toHaveBeenCalled();
  });

  it("rejects drops into skipped and registration-reserved slots without changing physical order", () => {
    const onSkippedSelectArtwork = vi.fn();
    const skippedSettings: ProjectSettingsV2 = {
      ...DEFAULT_PROJECT_SETTINGS,
      layout: { rows: 1, columns: 3, skippedSlotIndices: [1] },
    };
    const skipped = render(compositorWorkspace([{ ...card(), quantity: 2 }], skippedSettings, false, onSkippedSelectArtwork, true));
    const firstCard = bodyButtonForPhysicalIndex(0);
    const skippedSlot = sheet().querySelector('g[aria-label^="Slot 2 desativado"]')!;
    const skippedRevision = screen.getByTestId("project-revision").textContent;
    startBodyPointerDrag(firstCard, 15);
    movePointerDrag(skippedSlot, 15, 40, 20);
    expect(skippedSlot).toHaveClass("is-invalid-drop");
    dropPointerDrag(skippedSlot, 15, 40, 20);
    expect(screen.getByText(/Drop rejeitado: slot ignorado não recebe cartas/)).toBeInTheDocument();
    expect(skippedSlot).not.toHaveClass("is-invalid-drop");
    expect(firstCard.closest("g[data-compositor-slot]")).not.toHaveClass("is-invalid-drop");
    expect(sheet().querySelector('g[data-physical-card-index="0"]')).toHaveAttribute("data-physical-instance-id", "instance-1");
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(skippedRevision ?? "");
    fireEvent.click(firstCard);
    expect(onSkippedSelectArtwork).not.toHaveBeenCalled();
    fireEvent.pointerDown(firstCard, { pointerId: 24, pointerType: "mouse", isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(firstCard, { pointerId: 24, pointerType: "mouse", button: 0, clientX: 20, clientY: 20 });
    fireEvent.click(firstCard);
    expect(onSkippedSelectArtwork).toHaveBeenCalledTimes(1);

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
    const onReservedSelectArtwork = vi.fn();
    render(compositorWorkspace([{ ...card(), quantity: 2 }], reservedSettings, false, onReservedSelectArtwork, true));
    const layoutAlert = screen.queryByRole("alert");
    if (layoutAlert) throw new Error(layoutAlert.textContent ?? "Compositor layout failed.");
    const reservedSlot = sheet().querySelector('g[aria-label^="Slot 1 reservado"]');
    expect(reservedSlot).not.toBeNull();
    const cardSlot = sheet().querySelector('g[data-physical-card-index="0"]')!;
    const reservedRevision = screen.getByTestId("project-revision").textContent;
    startBodyPointerDrag(bodyButtonForPhysicalIndex(0), 16);
    movePointerDrag(reservedSlot!, 16, 40, 20);
    expect(reservedSlot).toHaveClass("is-invalid-drop");
    dropPointerDrag(reservedSlot!, 16, 40, 20);
    expect(screen.getByText(/Drop rejeitado: slot reservado permanece vazio/)).toBeInTheDocument();
    expect(reservedSlot).not.toHaveClass("is-invalid-drop");
    expect(cardSlot).not.toHaveClass("is-invalid-drop");
    expect(sheet().querySelector('g[data-physical-card-index="0"]')).toHaveAttribute("data-physical-instance-id", "instance-1");
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-2");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(reservedRevision ?? "");
    expect(onReservedSelectArtwork).not.toHaveBeenCalled();
  });

  it("uses an accessible checkbox as selection feedback without changing artwork, geometry, or Project state", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 2 }]));
    const revision = screen.getByTestId("project-revision").textContent;
    const firstSlot = slotForPhysicalIndex(0);
    const secondSlot = slotForPhysicalIndex(1);
    const originalViewBox = sheet().getAttribute("viewBox");
    const originalSlotPosition = [firstSlot.getAttribute("data-slot-x-mm"), firstSlot.getAttribute("data-slot-y-mm")];
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
    expect([firstSlot.getAttribute("data-slot-x-mm"), firstSlot.getAttribute("data-slot-y-mm")])
      .toEqual(originalSlotPosition);
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
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(screen.getByRole("group", { name: /Compositor live frente.*página 2 de 2/ })).toHaveAttribute("data-active-physical-card-index", "none");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");
    expect(screen.queryByRole("button", { name: /carta física 2.*cópia 2 de 10/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Página anterior" }));
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");
    expect(bodyButtonForPhysicalIndex(1)).toHaveAttribute("aria-current", "true");
  });

  it("keeps the source and checkbox selection through a pointer reorder across pages", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 10 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, undefined, true));

    await user.click(checkboxForPhysicalIndex(1));
    await user.click(bodyButtonForPhysicalIndex(1));
    const revision = screen.getByTestId("project-revision").textContent;
    startBodyPointerDrag(bodyButtonForPhysicalIndex(1), 17);
    movePointerDrag(screen.getByRole("button", { name: "Próxima página" }), 17, 40, 20);
    expect(sheet()).toHaveAttribute("data-compositor-page", "2");

    const finalCardBody = bodyButtonForPhysicalIndex(9);
    setClientRect(finalCardBody, { left: 100, top: 100, width: 60, height: 84 });
    movePointerDrag(finalCardBody, 17, 155, 120);
    dropPointerDrag(finalCardBody, 17, 155, 120);

    expect(sheet()).toHaveAttribute("data-compositor-page", "2");
    expect(slotForPhysicalIndex(9)).toHaveAttribute("data-physical-instance-id", "instance-2");
    expect(bodyButtonForPhysicalIndex(9)).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-2");
    expect(sheet()).toHaveAttribute("data-active-physical-card-index", "9");
    expect(checkboxForPhysicalIndex(9)).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-1,instance-3,instance-4,instance-5,instance-6,instance-7,instance-8,instance-9,instance-10,instance-2");
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
  });

  it("keeps a page-two source alive while dragging back to page one", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace([{ ...card(), quantity: 10 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { skippedSlotIndices: [] } }, false, undefined, true));
    await user.click(screen.getByRole("button", { name: "Próxima página" }));
    const source = bodyButtonForPhysicalIndex(9);
    startBodyPointerDrag(source, 23);
    expect(screen.getByTestId("compositor-drag-ghost")).toBeInTheDocument();
    movePointerDrag(screen.getByRole("button", { name: "Página anterior" }), 23, 40, 20);
    expect(sheet()).toHaveAttribute("data-compositor-page", "1");

    const firstCardBody = bodyButtonForPhysicalIndex(0);
    setClientRect(firstCardBody, { left: 100, top: 100, width: 60, height: 84 });
    movePointerDrag(firstCardBody, 23, 101, 120);
    expect(screen.getByTestId("compositor-drag-ghost")).toBeInTheDocument();
    dropPointerDrag(firstCardBody, 23, 101, 120);

    expect(screen.getByTestId("physical-order-ids")).toHaveTextContent("instance-10,instance-1,instance-2,instance-3,instance-4,instance-5,instance-6,instance-7,instance-8,instance-9");
    expect(screen.getByTestId("active-physical-instance-id")).toHaveTextContent("instance-10");
    expect(sheet()).toHaveAttribute("data-compositor-page", "1");
  });

  it("drops on a final eligible empty slot as insertion at the end of the physical sequence", () => {
    render(compositorWorkspace([{ ...card(), quantity: 2 }], { ...DEFAULT_PROJECT_SETTINGS, layout: { rows: 1, columns: 3, skippedSlotIndices: [] } }, false, undefined, true));
    const source = bodyButtonForPhysicalIndex(0);
    const emptyEnd = sheet().querySelector('g[aria-label^="Slot 3 vazio"]')!;
    startBodyPointerDrag(source, 18);
    movePointerDrag(emptyEnd, 18, 180, 120);
    expect(emptyEnd.querySelector('[data-compositor-insertion-indicator="end"]')).toBeInTheDocument();
    dropPointerDrag(emptyEnd, 18, 180, 120);

    expect(sheet().querySelector('g[data-physical-card-index="0"]')).toHaveAttribute("data-physical-instance-id", "instance-2");
    expect(sheet().querySelector('g[data-physical-card-index="1"]')).toHaveAttribute("data-physical-instance-id", "instance-1");
    expect(sheet()).toHaveAttribute("data-active-physical-card-index", "1");
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
    expect(screen.queryByTestId("active-physical-card")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(await screen.findByRole("button", { name: "Desativar slot da carta ativa" }));

    expect(Number(screen.getByTestId("project-revision").textContent)).toBe(revision + 1);
    expect(screen.getByTestId("skipped-slot-indices")).toHaveTextContent("0");
    expect(Number(slotForPhysicalIndex(0).getAttribute("data-slot-x-mm"))).not.toBe(startingX);
  });

  it("keeps only face and page navigation in the persistent toolbar", async () => {
    const user = userEvent.setup();
    render(compositorWorkspace());
    const revision = screen.getByTestId("project-revision").textContent;
    const toolbar = screen.getByRole("toolbar", { name: "Controles do compositor" });
    const faceControls = within(toolbar).getByRole("group", { name: "Face do compositor" });
    const pageControls = within(toolbar).getByRole("group", { name: "Navegação de páginas" });
    expect(toolbar.children).toHaveLength(2);
    expect(within(faceControls).getAllByRole("button")).toHaveLength(2);
    expect(within(faceControls).getByRole("button", { name: "Frente" })).toHaveAttribute("aria-pressed", "true");
    expect(within(faceControls).getByRole("button", { name: "Verso" })).toHaveAttribute("aria-pressed", "false");
    expect(within(pageControls).getByRole("button", { name: "Página anterior" })).toBeInTheDocument();
    expect(within(pageControls).getByRole("button", { name: "Próxima página" })).toBeInTheDocument();
    expect(within(pageControls).getByLabelText("Página do compositor")).toBeInTheDocument();
    expect(within(pageControls).getByText("Página 1 de 2")).toBeInTheDocument();
    expect(within(toolbar).queryByRole("button", { name: /Fit Page|Fit Width|100%|Reduzir zoom|Aumentar zoom/i })).not.toBeInTheDocument();
    expect(within(toolbar).queryByText("Layers")).not.toBeInTheDocument();

    const compositorRegion = screen.getByRole("region", { name: "Compositor live" });
    expect(compositorRegion).toBeInTheDocument();
    expect(within(compositorRegion).queryByRole("heading", { name: "Compositor live" })).not.toBeInTheDocument();
    expect(within(compositorRegion).queryByText(/capacidade|atualiza automaticamente|cartas físicas ·/i)).not.toBeInTheDocument();
    expect(within(compositorRegion).queryByText(/Frente física|Verso físico|registration/i)).not.toBeInTheDocument();
    expect(within(compositorRegion).queryByText(/Perfil .*ΔX|Sem perfil de calibração selecionado|ΔY|skew/i)).not.toBeInTheDocument();
    expect(within(compositorRegion).queryByText(/Bleed|Trim\/card|Cut path|Skipped slot\/path|Reserved zone|Registration mark/)).not.toBeInTheDocument();
    expect(within(compositorRegion).queryByText(/Defina linhas e colunas antes de desativar slots/)).not.toBeInTheDocument();

    await user.click(within(faceControls).getByRole("button", { name: "Verso" }));
    expect(within(compositorRegion).queryByText(/O verso mantém a mesma página física/)).not.toBeInTheDocument();
    expect(within(compositorRegion).queryByText(/Verso físico|grade duplex pareada/)).not.toBeInTheDocument();
    expect(screen.getByTestId("project-revision")).toHaveTextContent(revision ?? "");
    expect(screen.queryAllByTitle(/PDF/)).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: "Conferir PDF final" })).not.toBeInTheDocument();
  });

  it("derives bleed, calibration, cut guides, and registration overlays from Project settings", () => {
    const unconfiguredSettings: ProjectSettingsV2 = {
      ...DEFAULT_PROJECT_SETTINGS,
      bleedMm: 0,
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      registration: createDefaultRegistrationConfig("none", "portrait"),
      printerProfileSelection: null,
      cutSourceSelection: null,
      cutGuides: {
        trim: { ...DEFAULT_PROJECT_SETTINGS.cutGuides.trim, enabled: false },
        external: { ...DEFAULT_PROJECT_SETTINGS.cutGuides.external, enabled: false },
      },
      layout: { rows: 1, columns: 1, skippedSlotIndices: [] },
    };
    const view = render(compositorWorkspace([{ ...card(), quantity: 1 }], unconfiguredSettings));
    const unconfiguredSheet = sheet();
    expect(unconfiguredSheet.querySelector("image[data-compositor-artwork]")).toBeInTheDocument();
    for (const layer of ["bleed", "trim", "cut", "silhouette", "registration", "reserved", "margins"]) {
      expect(unconfiguredSheet.querySelector(`[data-compositor-layer='${layer}']`)).not.toBeInTheDocument();
    }
    expect(unconfiguredSheet.getAttribute("data-compositor-calibration-matrix")).toBe("identity");

    view.unmount();
    const configuredSettings: ProjectSettingsV2 = {
      ...unconfiguredSettings,
      bleedMm: 1.25,
      printerProfileSelection: {
        ...calibrationProfile,
        front: { ...calibrationProfile.front, offsetXUm: 500 },
      },
      registration: createDefaultRegistrationConfig("three-point", "portrait"),
      cutGuides: {
        trim: { ...unconfiguredSettings.cutGuides.trim, enabled: true },
        external: { ...unconfiguredSettings.cutGuides.external, enabled: true },
      },
    };
    render(compositorWorkspace([{ ...card(), quantity: 1 }], configuredSettings));

    const configuredSheet = sheet();
    expect(configuredSheet.querySelector("image[data-compositor-artwork]")?.getAttribute("href")).toContain("bleedMm=1.25");
    expect(configuredSheet.querySelector("[data-compositor-layer='bleed']")).toBeInTheDocument();
    expect(configuredSheet.querySelector("[data-compositor-layer='cut']")).toBeInTheDocument();
    expect(configuredSheet.querySelector("[data-compositor-layer='registration']")?.childElementCount).toBeGreaterThan(0);
    expect(configuredSheet.querySelector("[data-compositor-layer='reserved']")?.childElementCount).toBeGreaterThan(0);
    const calibrationMatrix = configuredSheet.getAttribute("data-compositor-calibration-matrix");
    expect(calibrationMatrix).not.toBe("identity");
    expect(configuredSheet.querySelector("[data-calibrated-print-content]")).toHaveAttribute("transform", calibrationMatrix);
  });
});
