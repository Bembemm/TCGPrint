// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

describe("Cards and Artwork navigation", () => {
  it("keeps the selected Working Card when navigating from Cartas to Artwork and back", async () => {
    const user = userEvent.setup();
    const imported = [card("island-card", "Island", 0), card("mountain-card", "Mountain", 1)];
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
      if (url === "/api/cards/import") return Response.json({ workingCards: imported, report: { summary: {}, sources: [], selectedImporters: [], warnings: [], errors: [], pairings: [] }, providerHealth });
      if (url === "/api/cards/resolve") {
        const body = JSON.parse(String(init?.body)) as { action: string; card?: WorkingCard; faceId?: "front" | "back"; candidateId?: string };
        if (body.action === "select" && body.card && body.faceId && body.candidateId) {
          const selection: SelectedArtwork = { candidateId: body.candidateId, source: "scryfall", identityId: body.card.identity?.id ?? null, faceId: body.faceId, selectionPolicy: "user-selected" };
          return Response.json({ workingCards: [{ ...body.card, selectedArtworkByFace: { ...body.card.selectedArtworkByFace, [body.faceId]: selection } }], providerHealth });
        }
        return Response.json({ workingCards: imported, providerHealth });
      }
      if (url === "/api/back-library") return Response.json({ assets: [] });
      if (url === "/api/projects") return Response.json({ projects: [] });
      if (url === "/api/templates") return Response.json({ templates: [] });
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

    await user.click(screen.getByRole("tab", { name: "Artwork" }));
    const activeMountain = () => screen.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("Carta ativa: Mountain") === true);
    await waitFor(() => expect(activeMountain()).toBeInTheDocument());
    await user.click(await screen.findByRole("button", { name: "Selecionar arte" }));
    await waitFor(() => expect(screen.getByText(/Selecionada:.*scryfall:mountain-front/)).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    await user.click(screen.getByRole("button", { name: /1\/2 · Island/ }));
    await user.click(screen.getByRole("tab", { name: "Artwork" }));
    await user.click(await screen.findByRole("button", { name: "Selecionar arte" }));
    await waitFor(() => expect(screen.getByText(/Selecionada:.*scryfall:island-front/)).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    await user.click(screen.getByRole("button", { name: /2\/2 · Mountain/ }));
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    expect(screen.getByRole("button", { name: /2\/2 · Mountain/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("tab", { name: "Artwork" }));
    expect(activeMountain()).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Export" }));
    const composer = screen.getByRole("img", { name: /Compositor live frente/ });
    const initialSlotX = composer.querySelector("g[data-slot-x-mm]")?.getAttribute("data-slot-x-mm");
    const generate = screen.getByRole("button", { name: "Gerar PDF final" });
    expect(screen.getByText(/Project: sem Project aberto · Working Set local/)).toBeInTheDocument();
    expect(generate).toBeEnabled();
    await user.click(generate);
    const cancel = await screen.findByRole("button", { name: "Cancelar exportação do PDF" });
    await user.click(cancel);
    pendingFirstExport.resolve(new Response("%PDF-1.7 cancelled", { headers: { "Content-Type": "application/pdf" } }));
    await waitFor(() => expect(screen.getAllByText("Exportação cancelada.").length).toBeGreaterThan(0));

    const exportRequestBeforePhysicalSelection = exportRequests[0]?.body;
    const secondPhysicalCard = composer.querySelector('g[data-physical-card-index="1"]');
    if (!secondPhysicalCard) throw new Error("The second physical card is not rendered in the live compositor.");
    await user.click(secondPhysicalCard);
    expect(secondPhysicalCard).toHaveAttribute("aria-pressed", "true");

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

    await user.click(screen.getByRole("tab", { name: "Layout" }));
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
  }, 15_000);
});
