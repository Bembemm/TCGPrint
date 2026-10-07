// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectedArtwork, WorkingCard } from "../../core/cards/types";
import HomePage from "../../src/app/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const providerHealth = {
  scryfall: { available: true, degraded: false },
  upload: { available: true, degraded: false },
  mpc: { available: true, degraded: false },
};

const legacyTemplateVersion = {
  templateId: "legacy-custom-template",
  name: "Legacy custom",
  source: "Fixture",
  version: "v9",
  paper: "a4",
  cardFormat: "standard",
  orientation: "portrait",
  registrationType: "custom",
  packageHash: "9".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  files: [],
};
const legacyTemplate = {
  id: "legacy-custom-template",
  name: "Legacy custom",
  source: "Fixture",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  versions: [legacyTemplateVersion],
};

function card(id: string, name: string, order: number): WorkingCard {
  return {
    id,
    quantity: 1,
    order,
    section: "Mainboard",
    importSource: { sourceId: `deck:${id}`, importKind: "text", entryKind: "deck-card" },
    identityHints: { name },
    identity: { id: id.toLowerCase(), provider: "scryfall", name, resolutionMethod: "name", confidence: 1 },
    identityResolution: { status: "resolved", candidates: [], confirmed: false, method: "name", confidence: 1, query: name },
    faces: [{ id: "front", side: "front", name }],
    selectedArtworkByFace: {},
    backMode: "project-default",
    backModeSelectionPolicy: "automatic",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("Cartas workspace navigation", () => {
  it("keeps physical checkbox selection out of the active Project and autosave", async () => {
    const user = userEvent.setup();
    const imported = [
      { ...card("island-card", "Island", 0), manualBackArtwork: { candidateId: `upload:${"b".repeat(64)}`, source: "upload" as const, identityId: null, faceId: "back" as const, selectionPolicy: "user-selected" as const }, backMode: "manual" as const, backModeSelectionPolicy: "explicit" as const },
      card("mountain-card", "Mountain", 1),
    ];
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const savedProjects: Array<Record<string, unknown>> = [];
    const pendingRecoveries = new Map<string, Record<string, unknown>>();

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/projects")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        requests.push({ url, method, ...(body ? { body } : {}) });
      }
      if (url === "/api/projects") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        if (method === "POST") {
          const project = {
            id: `project-selection-test-${savedProjects.length + 1}`,
            name: `Selection test ${savedProjects.length + 1}`,
            projectSchemaVersion: 6,
            revision: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            snapshot: body?.snapshot,
            templateSelection: body?.templateSelection ?? null,
          };
          savedProjects.push(project);
          return Response.json(project);
        }
        return Response.json({ projects: savedProjects.map(({ id, name, projectSchemaVersion, revision, createdAt, updatedAt }) => ({ id, name, projectSchemaVersion, revision, createdAt, updatedAt })) });
      }
      const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url);
      if (projectMatch && method === "GET") {
        const project = savedProjects.find(({ id }) => id === projectMatch[1]);
        return project ? Response.json({ ...project, recovery: null }) : Response.json({ message: "Not found" }, { status: 404 });
      }
      const recoveryMatch = /^\/api\/projects\/([^/]+)\/recovery$/.exec(url);
      if (recoveryMatch && method === "POST") {
        const project = savedProjects.find(({ id }) => id === recoveryMatch[1]);
        if (!project) return Response.json({ message: "Not found" }, { status: 404 });
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        pendingRecoveries.set(recoveryMatch[1]!, body);
        return Response.json({ recovery: { baseRevision: project.revision } });
      }
      const promoteMatch = /^\/api\/projects\/([^/]+)\/recovery\/promote$/.exec(url);
      if (promoteMatch && method === "POST") {
        const project = savedProjects.find(({ id }) => id === promoteMatch[1]);
        const recovery = pendingRecoveries.get(promoteMatch[1]!);
        if (!project || !recovery) return Response.json({ message: "Not found" }, { status: 404 });
        Object.assign(project, {
          revision: Number(project.revision) + 1,
          snapshot: recovery.snapshot,
          templateSelection: recovery.templateSelection ?? null,
        });
        pendingRecoveries.delete(promoteMatch[1]!);
        return Response.json(project);
      }
      if (url === "/api/cards/import") return Response.json({ workingCards: imported, report: { summary: {}, sources: [], selectedImporters: [], warnings: [], errors: [], pairings: [] }, providerHealth });
      if (url === "/api/cards/resolve") {
        const body = JSON.parse(String(init?.body)) as { cards?: WorkingCard[] };
        return Response.json({ workingCards: body.cards ?? imported, providerHealth });
      }
      if (url === "/api/back-library") return Response.json({ assets: [] });
      if (url === "/api/templates") return Response.json({ templates: [] });
      if (url === "/api/printer-profiles") return Response.json({ profiles: [] });
      return Response.json({ message: `Rota não simulada: ${url}` }, { status: 404 });
    }));

    render(<HomePage />);
    await user.type(screen.getByRole("textbox", { name: "Cole uma decklist ou URL" }), "1 Island\n1 Mountain");
    await user.click(screen.getByRole("button", { name: "Adicionar cartas" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Selecionar Island, cópia 1 de 1" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Salvar como projeto" }));
    await waitFor(() => expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo"));
    expect(savedProjects).toHaveLength(1);
    const snapshot = savedProjects[0]?.snapshot;
    expect(snapshot).toMatchObject({ physicalOrder: { instances: [{ id: "instance-1" }, { id: "instance-2" }] } });
    expect(snapshot).not.toHaveProperty("activePhysicalInstanceId");
    expect(snapshot).not.toHaveProperty("selectedPhysicalInstanceIds");

    await user.click(screen.getByRole("checkbox", { name: "Selecionar Island, cópia 1 de 1" }));
    expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo");
    await user.click(screen.getByRole("button", { name: "Selecionar tudo" }));
    expect(screen.getByRole("checkbox", { name: "Selecionar Island, cópia 1 de 1" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "Selecionar Mountain, cópia 1 de 1" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Desmarcar" }));
    expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo");
    expect(screen.queryByRole("group", { name: "Ações de seleção" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ver verso de Island, cópia 1" }));
    expect(document.querySelector(".workspace-live-compositor image[data-compositor-artwork]"))
      .toHaveAttribute("data-compositor-artwork", `upload:${"b".repeat(64)}`);
    await user.click(screen.getByRole("button", { name: "Mais ações para Island, cópia 1 de 1" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const islandBody = document.querySelector<SVGRectElement>(".workspace-live-compositor [data-compositor-card-body='true']");
    expect(islandBody).not.toBeNull();
    fireEvent.contextMenu(islandBody!, { clientX: 430, clientY: 240 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(islandBody!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fechar seletor de arte" }));

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo");
    expect(savedProjects[0]?.snapshot).toEqual(snapshot);
    expect(requests.filter(({ url }) => url.includes("/recovery") || url.includes("project-selection-test"))).toHaveLength(0);
    expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(0);

    const mountainBody = document.querySelector<SVGRectElement>('[data-physical-instance-id="instance-2"] [data-compositor-card-body="true"]');
    const islandDropBody = document.querySelector<SVGRectElement>('[data-physical-instance-id="instance-1"] [data-compositor-card-body="true"]');
    expect(mountainBody).not.toBeNull();
    expect(islandDropBody).not.toBeNull();
    setClientRect(mountainBody!, { left: 240, top: 100, width: 60, height: 84 });
    setClientRect(islandDropBody!, { left: 100, top: 100, width: 60, height: 84 });
    fireEvent.pointerDown(mountainBody!, { pointerId: 31, pointerType: "mouse", isPrimary: true, button: 0, clientX: 250, clientY: 110 });
    fireEvent.pointerMove(mountainBody!, { pointerId: 31, pointerType: "mouse", buttons: 1, clientX: 256, clientY: 110 });
    fireEvent.pointerMove(islandDropBody!, { pointerId: 31, pointerType: "mouse", buttons: 1, clientX: 101, clientY: 110 });
    fireEvent.pointerUp(islandDropBody!, { pointerId: 31, pointerType: "mouse", button: 0, clientX: 101, clientY: 110 });
    await waitFor(() => expect(savedProjects[0]?.revision).toBe(2), { timeout: 4_000 });
    expect(savedProjects[0]?.snapshot).toMatchObject({ physicalOrder: { instances: [{ id: "instance-2" }, { id: "instance-1" }] } });
    expect(requests.filter(({ url, method }) => url.endsWith("/recovery") && method === "POST")).toHaveLength(1);
    expect(requests.filter(({ url, method }) => url.endsWith("/recovery/promote") && method === "POST")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Abrir projeto" }));
    const reopenDialog = await screen.findByRole("dialog", { name: "Abrir projeto" });
    await user.click(within(reopenDialog).getByRole("button", { name: "Abrir Selection test 1" }));
    await waitFor(() => expect(document.querySelector('[data-physical-card-index="0"]')).toHaveAttribute("data-physical-instance-id", "instance-2"));
    expect(document.querySelector('[data-physical-card-index="1"]')).toHaveAttribute("data-physical-instance-id", "instance-1");
    expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo");

    await user.click(screen.getByRole("checkbox", { name: "Selecionar Island, cópia 1 de 1" }));
    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Novo projeto" }));
    await waitFor(() => expect(savedProjects).toHaveLength(2));
    expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo");
    expect(savedProjects[1]?.snapshot).toMatchObject({ cards: [], physicalOrder: { instances: [] } });
    expect(screen.queryByRole("group", { name: "Ações de seleção" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Selecionar Island, cópia 1 de 1" })).not.toBeInTheDocument();
  }, 15_000);

  it("keeps the selected Working Card and Artwork Picker reachable in Cartas", async () => {
    const user = userEvent.setup();
    const imported = [card("island-card", "Island", 0), card("mountain-card", "Mountain", 1)];
    let cardsReturnedByImport = imported;
    const mountainArtwork = {
      id: "scryfall:mountain-front",
      source: "scryfall",
      identityId: "mountain-card",
      faceId: "front",
      faceName: "Mountain print",
      effectiveDpi: 300,
      resolutionQuality: "good",
      qualityStatus: "verified",
      widthPx: 750,
      heightPx: 1050,
      originalAvailable: true,
      originalCached: true,
      metadata: { originalFormat: "png", byteLength: 120_000 },
    } as const;
    const islandArtwork = { ...mountainArtwork, id: "scryfall:island-front", identityId: "island-card", faceName: "Island print" } as const;
    const pendingFirstExport = deferred<Response>();
    let exportCount = 0;
    const exportRequests: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    const createObjectUrl = vi.fn(() => "blob:tcgprint-export");
    const revokeObjectUrl = vi.fn();
    const NativeURL = URL;
    class TestURL extends NativeURL {
      static createObjectURL = createObjectUrl;
      static revokeObjectURL = revokeObjectUrl;
    }
    vi.stubGlobal("URL", TestURL);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cards/import") return Response.json({ workingCards: cardsReturnedByImport, report: { summary: {}, sources: [], selectedImporters: [], warnings: [], errors: [], pairings: [] }, providerHealth });
      if (url === "/api/cards/resolve") {
        const body = JSON.parse(String(init?.body)) as { action: string; cards?: WorkingCard[]; targetCardId?: string; faceId?: "front" | "back"; candidateId?: string };
        if (body.action === "apply-artwork-scope" && body.cards && body.targetCardId && body.faceId && body.candidateId) {
          const target = body.cards.find((item) => item.id === body.targetCardId)!;
          const selection: SelectedArtwork = { candidateId: body.candidateId, source: "scryfall", identityId: target.identity?.id ?? null, faceId: body.faceId, selectionPolicy: "user-selected" };
          const next = body.cards.map((item) => item.identity?.id === target.identity?.id && item.identity?.provider === target.identity?.provider
            ? { ...item, selectedArtworkByFace: { ...item.selectedArtworkByFace, [body.faceId!]: selection } }
            : item);
          return Response.json({ workingCards: next, providerHealth });
        }
        return Response.json({ workingCards: body.cards ?? imported, providerHealth });
      }
      if (url === "/api/back-library") return Response.json({ assets: [] });
      if (url === "/api/projects") return Response.json({ projects: [] });
      if (url === "/api/templates") return Response.json({ templates: [legacyTemplate] });
      if (url.startsWith("/api/templates/legacy-custom-template/versions/v9/verify")) {
        const selection = { templateId: "legacy-custom-template", version: "v9", packageHash: legacyTemplateVersion.packageHash };
        return Response.json({ selection, status: "available", version: legacyTemplateVersion, files: [] });
      }
      if (url === "/api/printer-profiles") return Response.json({ profiles: [] });
      if (url === "/api/cards/mountain-card") return Response.json({ identity: { id: "mountain", provider: "scryfall", name: "Mountain", resolutionMethod: "name", confidence: 1, relatedCards: [] } });
      if (url === "/api/cards/mountain-card/artworks") return Response.json({ candidates: [mountainArtwork], catalogTotal: 1, catalogTotalComplete: true, providerHealth });
      if (url === "/api/cards/island-card") return Response.json({ identity: { id: "island", provider: "scryfall", name: "Island", resolutionMethod: "name", confidence: 1, relatedCards: [] } });
      if (url === "/api/cards/island-card/artworks") return Response.json({ candidates: [islandArtwork], catalogTotal: 1, catalogTotalComplete: true, providerHealth });
      if (url.includes("/api/cards/artworks/") && url.endsWith("/prepare")) return Response.json({ candidate: url.includes("island-front") ? islandArtwork : mountainArtwork });
      if (url === "/api/cards/export" || url === "/api/cards/export?proof=final") {
        exportCount += 1;
        exportRequests.push({ url, body: init?.body });
        if (exportCount === 1) return pendingFirstExport.promise;
        return new Response("%PDF-1.7 test", { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="tcgprint-m4.pdf"' } });
      }
      return Response.json({ message: `Rota não simulada: ${url} (${init?.method ?? "GET"})` }, { status: 404 });
    }));

    render(<HomePage />);
    await user.type(screen.getByRole("textbox", { name: "Cole uma decklist ou URL" }), "1 Island\n1 Mountain");
    await user.click(screen.getByRole("button", { name: "Adicionar cartas" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /2\/2 · Mountain/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /2\/2 · Mountain/ }));
    expect(screen.getByRole("button", { name: /2\/2 · Mountain/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    const openPicker = async () => {
      await user.click(await screen.findByRole("button", { name: "Trocar artwork" }));
      return screen.findByRole("dialog");
    };
    let picker = await openPicker();
    await user.click(within(await picker).getByRole("button", { name: "Selecionar arte" }));
    expect(screen.getByRole("dialog", { name: /Mountain/ })).toBe(picker);
    await waitFor(() => expect(within(picker).getByText(/Atual · Scryfall/)).toBeInTheDocument());
    expect(within(picker).getByRole("img", { name: /Artwork atual de Mountain/ })).toBeInTheDocument();
    expect(picker.querySelector(".artwork-picker-current-display")).toHaveAttribute(
      "src",
      expect.stringContaining("/api/cards/artworks/scryfall%3Amountain-front/display?width=1024"),
    );
    await user.click(within(picker).getByRole("button", { name: "Fechar seletor de arte" }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    await user.click(screen.getByRole("button", { name: /1\/2 · Island/ }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    picker = await openPicker();
    await user.click(within(picker).getByRole("button", { name: "Selecionar arte" }));
    expect(screen.getByRole("dialog", { name: /Island/ })).toBe(picker);
    await waitFor(() => expect(within(picker).getByText(/Atual · Scryfall/)).toBeInTheDocument());
    await user.click(within(picker).getByRole("button", { name: "Fechar seletor de arte" }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    await user.click(screen.getByRole("button", { name: /2\/2 · Mountain/ }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    expect(screen.getByRole("button", { name: /2\/2 · Mountain/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    picker = await openPicker();
    expect(within(picker).getByText(/Atual · Scryfall/)).toBeInTheDocument();
    await user.click(within(picker).getByRole("button", { name: "Fechar seletor de arte" }));

    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    const composer = screen.getByRole("group", { name: /Compositor live frente/ });
    const initialSlotX = composer.querySelector("g[data-slot-x-mm]")?.getAttribute("data-slot-x-mm");
    const generate = screen.getByRole("button", { name: "Gerar PDF final" });
    expect(screen.getByRole("region", { name: "Exportação final" })).toHaveTextContent("Pronto");
    expect(generate).toBeEnabled();
    await user.click(generate);
    const cancel = await screen.findByRole("button", { name: "Cancelar exportação do PDF" });
    await user.click(cancel);
    pendingFirstExport.resolve(new Response("%PDF-1.7 cancelled", { headers: { "Content-Type": "application/pdf" } }));
    await waitFor(() => expect(screen.getAllByText("Exportação cancelada.").length).toBeGreaterThan(0));

    const displayImages = [...composer.querySelectorAll<SVGImageElement>("image[data-compositor-display-url]")];
    expect(displayImages.length).toBeGreaterThanOrEqual(2);
    fireEvent.load(displayImages[0]!);
    vi.useFakeTimers();
    fireEvent.error(displayImages[1]!);
    try {
      window.dispatchEvent(new Event("resize"));
      expect(displayImages[0]).toHaveAttribute("data-compositor-source", "display-high-fidelity");
      expect(displayImages[1]).toHaveAttribute("data-compositor-source", "display-high-fidelity-pending");
      expect(displayImages[1]!.closest("[data-physical-instance-id]")?.querySelector("image[data-compositor-artwork]")).toHaveAttribute("data-compositor-source", "preview-thumbnail");
      await act(() => vi.advanceTimersByTime(500));
      const retriedDisplay = [...composer.querySelectorAll<SVGImageElement>("image[data-compositor-display-url]")]
        .find((image) => new URL(image.getAttribute("data-compositor-display-url")!, "http://localhost").searchParams.get("retry") === "1");
      expect(retriedDisplay).toBeDefined();
      fireEvent.load(retriedDisplay!);
      expect(retriedDisplay).toHaveAttribute("data-compositor-source", "display-high-fidelity");
      expect(retriedDisplay!.closest("[data-physical-instance-id]")?.querySelector("image[data-compositor-artwork]")).toHaveAttribute("opacity", "0");
      expect(exportRequests[0]?.body).toBeDefined();
    } finally {
      vi.useRealTimers();
    }

    await user.click(screen.getByRole("button", { name: "Gerar PDF final" }));
    await screen.findByRole("link", { name: "Baixar tcgprint-m4.pdf" });
    expect(exportRequests[1]?.body).toBe(exportRequests[0]?.body);

    const compositorShell = document.querySelector(".workspace-shell");
    const secondPhysicalCard = composer.querySelector('g[data-physical-card-index="1"]');
    if (!secondPhysicalCard) throw new Error("The second physical card is not rendered in the live compositor.");
    const secondCardBody = secondPhysicalCard.querySelector('[data-compositor-card-body="true"]');
    if (!secondCardBody) throw new Error("The second physical card has no body activation target.");
    await user.click(secondCardBody);
    const physicalPicker = await screen.findByRole("dialog", { name: /Mountain · cópia 1\/1/ });
    expect(within(physicalPicker).getByText("Cópia 1 de 1")).toBeInTheDocument();
    expect(compositorShell).toHaveAttribute("inert");
    expect(compositorShell).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".workspace-live-compositor")).toBeInTheDocument();
    await user.click(within(physicalPicker).getByRole("button", { name: "Fechar seletor de arte" }));
    expect(document.activeElement).toBe(secondCardBody);
    expect(compositorShell).not.toHaveAttribute("inert");

    const contextTrigger = secondPhysicalCard.querySelector<HTMLButtonElement>("[data-compositor-context-trigger]");
    if (!contextTrigger) throw new Error("The second physical card has no context menu trigger.");
    await user.click(contextTrigger);
    const contextMenu = screen.getByRole("menu", { name: /Ações para Mountain, cópia 1 de 1/ });
    await user.click(within(contextMenu).getByRole("menuitem", { name: "Trocar artwork" }));
    const menuPicker = await screen.findByRole("dialog", { name: /Mountain · cópia 1\/1/ });
    expect(within(menuPicker).getByText("Cópia 1 de 1")).toBeInTheDocument();
    const bulkToggle = within(menuPicker).getByRole("checkbox", { name: "Aplicar também às cópias iguais" });
    expect(bulkToggle).not.toBeChecked();
    await user.click(within(menuPicker).getByRole("button", { name: "Fechar seletor de arte" }));
    expect(document.activeElement).toBe(contextTrigger);

    const exportRequestBeforePointerReorder = exportRequests[1]?.body;
    const mountainDragBody = composer.querySelector<SVGRectElement>('[data-physical-instance-id="instance-2"] [data-compositor-card-body="true"]');
    const islandDropBody = composer.querySelector<SVGRectElement>('[data-physical-instance-id="instance-1"] [data-compositor-card-body="true"]');
    if (!mountainDragBody || !islandDropBody) throw new Error("The two physical cards are not rendered in the live compositor.");
    setClientRect(mountainDragBody, { left: 240, top: 100, width: 60, height: 84 });
    setClientRect(islandDropBody, { left: 100, top: 100, width: 60, height: 84 });
    fireEvent.pointerDown(mountainDragBody, { pointerId: 32, pointerType: "mouse", isPrimary: true, button: 0, clientX: 250, clientY: 110 });
    fireEvent.pointerMove(mountainDragBody, { pointerId: 32, pointerType: "mouse", buttons: 1, clientX: 256, clientY: 110 });
    expect(screen.getByTestId("compositor-drag-ghost")).toBeInTheDocument();
    fireEvent.pointerMove(islandDropBody, { pointerId: 32, pointerType: "mouse", buttons: 1, clientX: 101, clientY: 110 });
    fireEvent.pointerUp(islandDropBody, { pointerId: 32, pointerType: "mouse", button: 0, clientX: 101, clientY: 110 });
    expect(screen.queryByTestId("compositor-drag-ghost")).not.toBeInTheDocument();
    expect([...composer.querySelectorAll<SVGGElement>("g[data-physical-instance-id]")].map((slot) => slot.dataset.physicalInstanceId)).toEqual(["instance-2", "instance-1"]);
    expect(composer.querySelector('[data-physical-instance-id="instance-2"] [data-compositor-card-body="true"]')).toHaveAttribute("aria-current", "true");

    await user.click(screen.getByRole("button", { name: "Gerar PDF final" }));
    expect(await screen.findByRole("link", { name: "Baixar tcgprint-m4.pdf" })).toHaveAttribute("download", "tcgprint-m4.pdf");
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(exportCount).toBe(3);
    const generatedPdfRequestBody = exportRequests[2]?.body;
    expect(generatedPdfRequestBody).not.toBe(exportRequestBeforePointerReorder);
    const parsedExportRequest = JSON.parse(String(generatedPdfRequestBody)) as {
      options: { physicalOrder: { instances: readonly { id: string }[] } };
    };
    expect(parsedExportRequest.options.physicalOrder.instances.map(({ id }) => id)).toEqual(["instance-2", "instance-1"]);
    expect(composer).toHaveAttribute("data-compositor-zoom-mode", "fit-page");
    expect(screen.queryByRole("button", { name: "Aumentar zoom" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Conferir PDF final" }));
    const firstProof = await screen.findByRole("dialog", { name: "Conferir PDF final" });
    expect(within(firstProof).getByTitle("PDF final · front-only")).toBeInTheDocument();
    expect(exportRequests[3]?.url).toBe("/api/cards/export?proof=final");
    expect(exportRequests[3]?.body).toBe(generatedPdfRequestBody);
    const liveCompositor = composer.closest(".workspace-live-compositor");
    expect(liveCompositor).toHaveAttribute("inert");
    expect(liveCompositor).toHaveAttribute("aria-hidden", "true");
    expect(liveCompositor).toContainElement(composer);
    const closeProof = within(firstProof).getByRole("button", { name: "Fechar conferência do PDF final" });
    expect(document.activeElement).toBe(closeProof);

    await user.click(closeProof);
    expect(screen.queryByRole("dialog", { name: "Conferir PDF final" })).not.toBeInTheDocument();
    const proofTrigger = screen.getByRole("button", { name: "Conferir PDF final" });
    expect(document.activeElement).toBe(proofTrigger);
    await user.click(proofTrigger);
    const proof = await screen.findByRole("dialog", { name: "Conferir PDF final" });
    expect(exportRequests[4]?.body).toBe(generatedPdfRequestBody);
    expect(document.activeElement).toBe(within(proof).getByRole("button", { name: "Fechar conferência do PDF final" }));
    await user.tab();
    expect(liveCompositor?.contains(document.activeElement)).toBe(false);

    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(screen.getByText("Posicionamento, slots e margens"));
    const margin = screen.getByRole("spinbutton", { name: "Margem esquerda (mm)" });
    await user.clear(margin);
    await user.type(margin, "5");
    expect(within(proof).getByRole("status")).toHaveTextContent("Esta prévia ficou desatualizada");
    expect(composer.querySelector("g[data-slot-x-mm]")?.getAttribute("data-slot-x-mm")).not.toBe(initialSlotX);
    expect(screen.getByRole("dialog", { name: "Conferir PDF final" })).toBe(proof);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Conferir PDF final" })).not.toBeInTheDocument();
    expect(document.querySelector(".workspace-live-compositor")).toBe(liveCompositor);
    expect(liveCompositor).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(liveCompositor);
    expect(exportCount).toBe(5);
    expect(createObjectUrl).toHaveBeenCalledTimes(4);

    cardsReturnedByImport = [card("swamp-card", "Swamp", 0), card("forest-card", "Forest", 1)];
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    const decklist = screen.getByRole("textbox", { name: "Cole uma decklist ou URL" });
    await user.clear(decklist);
    await user.type(decklist, "1 Swamp\n1 Forest");
    await user.click(screen.getByRole("button", { name: "Adicionar cartas" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /2\/2 · Forest/ })).toBeInTheDocument());
    expect(composer.querySelector('g[data-physical-card-index="1"]')).toHaveAttribute("data-physical-instance-id", "instance-2");
    expect(composer.querySelector('g[data-physical-card-index="1"] [role="checkbox"]')).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(await screen.findByRole("button", { name: "Associar ao Project" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Associado" })).toHaveAttribute("aria-pressed", "true"));
    await screen.findByText(/Registration custom desta versão legada/);
    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    expect(screen.getByText("O template precisa de uma escolha explícita para as marcas de registro.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar PDF final" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Conferir PDF final" })).toBeDisabled();
  }, 15_000);
});
