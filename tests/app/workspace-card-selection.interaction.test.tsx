// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
            projectSchemaVersion: 2,
            revision: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            snapshot: body?.snapshot,
            templateSelection: body?.templateSelection ?? null,
          };
          savedProjects.push(project);
          return Response.json(project);
        }
        return Response.json({ projects: [] });
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
      await user.click(await screen.findByRole("button", { name: "Selecionar arte" }));
      return screen.findByRole("dialog");
    };
    let picker = await openPicker();
    await user.click(within(await picker).getByRole("button", { name: "Selecionar arte" }));
    await user.click(within(await picker).getByRole("button", { name: "Aplicar seleção" }));
    await waitFor(() => expect(within(screen.getByRole("dialog", { name: /Mountain/ })).getByText(/Estado atual:.*scryfall:mountain-front/)).toBeInTheDocument());
    await user.click(within(screen.getByRole("dialog", { name: /Mountain/ })).getByRole("button", { name: "Fechar seletor de arte" }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    await user.click(screen.getByRole("button", { name: /1\/2 · Island/ }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    picker = await openPicker();
    await user.click(within(await picker).getByRole("button", { name: "Selecionar arte" }));
    await user.click(within(await picker).getByRole("button", { name: "Aplicar seleção" }));
    await waitFor(() => expect(within(screen.getByRole("dialog", { name: /Island/ })).getByText(/Estado atual:.*scryfall:island-front/)).toBeInTheDocument());
    await user.click(within(screen.getByRole("dialog", { name: /Island/ })).getByRole("button", { name: "Fechar seletor de arte" }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    await user.click(screen.getByRole("button", { name: /2\/2 · Mountain/ }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    expect(screen.getByRole("button", { name: /2\/2 · Mountain/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    picker = await openPicker();
    expect(within(await picker).getByText(/Estado atual:.*scryfall:mountain-front/)).toBeInTheDocument();
    await user.click(within(await picker).getByRole("button", { name: "Fechar seletor de arte" }));

    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    const composer = screen.getByRole("group", { name: /Compositor live frente/ });
    const initialSlotX = composer.querySelector("g[data-slot-x-mm]")?.getAttribute("data-slot-x-mm");
    const generate = screen.getByRole("button", { name: "Gerar PDF final" });
    expect(screen.getByText(/Project: sem Project aberto · Working Set local/)).toBeInTheDocument();
    expect(generate).toBeEnabled();
    await user.click(generate);
    const cancel = await screen.findByRole("button", { name: "Cancelar exportação do PDF" });
    await user.click(cancel);
    pendingFirstExport.resolve(new Response("%PDF-1.7 cancelled", { headers: { "Content-Type": "application/pdf" } }));
    await waitFor(() => expect(screen.getAllByText("Exportação cancelada.").length).toBeGreaterThan(0));

    const compositorShell = document.querySelector(".workspace-shell");
    const secondPhysicalCard = composer.querySelector('g[data-physical-card-index="1"]');
    if (!secondPhysicalCard) throw new Error("The second physical card is not rendered in the live compositor.");
    const secondCardBody = secondPhysicalCard.querySelector('[data-compositor-card-body="true"]');
    if (!secondCardBody) throw new Error("The second physical card has no body activation target.");
    await user.click(secondCardBody);
    const physicalPicker = await screen.findByRole("dialog", { name: /Mountain · cópia 1\/1/ });
    expect(within(physicalPicker).getByText("Carta física 2 · cópia original 1/1")).toBeInTheDocument();
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
    expect(within(menuPicker).getByText("Carta física 2 · cópia original 1/1")).toBeInTheDocument();
    await user.click(within(menuPicker).getByRole("button", { name: "Selecionada" }));
    expect(within(menuPicker).getByRole("radio", { name: "Somente esta cópia física" })).toBeChecked();
    await user.click(within(menuPicker).getByRole("button", { name: "Fechar seletor de arte" }));
    expect(document.activeElement).toBe(contextTrigger);

    const exportRequestBeforePhysicalSelection = exportRequests[0]?.body;
    const selectedPhysicalCard = composer.querySelector('g[data-physical-card-index="1"]');
    if (!selectedPhysicalCard) throw new Error("The second physical card is not rendered in the live compositor.");
    expect(selectedPhysicalCard?.querySelector('[data-compositor-card-body="true"]')).toHaveAttribute("aria-current", "true");

    await user.click(screen.getByRole("button", { name: "Gerar PDF final" }));
    expect(await screen.findByRole("link", { name: "Baixar tcgprint-m4.pdf" })).toHaveAttribute("download", "tcgprint-m4.pdf");
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(exportCount).toBe(2);
    const generatedPdfRequestBody = exportRequests[1]?.body;
    expect(generatedPdfRequestBody).toBe(exportRequestBeforePhysicalSelection);
    await user.click(screen.getByRole("button", { name: "Aumentar zoom" }));
    expect(composer).toHaveAttribute("data-compositor-zoom-mode", "manual");

    await user.click(screen.getByRole("button", { name: "Conferir PDF final" }));
    const firstProof = await screen.findByRole("dialog", { name: "Conferir PDF final" });
    expect(within(firstProof).getByTitle("PDF final · front-only")).toBeInTheDocument();
    expect(exportRequests[2]?.url).toBe("/api/cards/export?proof=final");
    expect(exportRequests[2]?.body).toBe(generatedPdfRequestBody);
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
    expect(exportRequests[3]?.body).toBe(generatedPdfRequestBody);
    expect(document.activeElement).toBe(within(proof).getByRole("button", { name: "Fechar conferência do PDF final" }));
    await user.tab();
    expect(liveCompositor?.contains(document.activeElement)).toBe(false);

    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(screen.getByText("Grade, slots e margens avançados"));
    const margin = screen.getByRole("spinbutton", { name: "Margem esquerda (mm)" });
    await user.clear(margin);
    await user.type(margin, "5");
    expect(within(proof).getByRole("status")).toHaveTextContent("PDF conferido anteriormente está desatualizado");
    expect(composer.querySelector("g[data-slot-x-mm]")?.getAttribute("data-slot-x-mm")).not.toBe(initialSlotX);
    expect(screen.getByRole("dialog", { name: "Conferir PDF final" })).toBe(proof);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Conferir PDF final" })).not.toBeInTheDocument();
    expect(document.querySelector(".workspace-live-compositor")).toBe(liveCompositor);
    expect(liveCompositor).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(liveCompositor);
    expect(exportCount).toBe(4);
    expect(createObjectUrl).toHaveBeenCalledTimes(3);

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
    expect(screen.getAllByText(/Template: legacy-custom-unconfigured/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Gerar PDF final" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Conferir PDF final" })).toBeDisabled();
  }, 15_000);
});
