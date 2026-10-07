// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtworkCandidate, WorkingCard } from "../../core/cards/types";
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

const dfcIdentity = {
  id: "scryfall:oracle:delver",
  provider: "scryfall",
  name: "Delver of Secrets // Insectile Aberration",
  resolutionMethod: "manual" as const,
  confidence: 1,
  metadata: { layout: "transform", faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] },
};

const dfc: WorkingCard = {
  id: "delver-working-card",
  quantity: 1,
  order: 0,
  section: "Mainboard",
  importSource: { sourceId: "deck:delver", importKind: "text", entryKind: "deck-card" },
  identityHints: { name: "Delver of Secrets" },
  identity: dfcIdentity,
  identityResolution: { status: "resolved", candidates: [], confirmed: true, method: "manual", confidence: 1, query: "Delver of Secrets" },
  faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
  selectedArtworkByFace: {},
  backMode: "auto",
  backModeSelectionPolicy: "automatic",
  localArtworkIds: [],
  mpcReferences: [],
  faceAssociations: [],
};

const simple: WorkingCard = {
  ...dfc,
  id: "island-working-card",
  quantity: 2,
  order: 0,
  identityHints: { name: "Island" },
  identity: { id: "scryfall:oracle:island", provider: "scryfall", name: "Island", resolutionMethod: "manual", confidence: 1 },
  identityResolution: { status: "resolved", candidates: [], confirmed: true, method: "manual", confidence: 1, query: "Island" },
  faces: [{ id: "front", side: "front", name: "Island" }],
  selectedArtworkByFace: {},
  backMode: "project-default",
};

function candidate(source: ArtworkCandidate["source"], side: "front" | "back"): ArtworkCandidate {
  const id = source === "scryfall"
    ? `scryfall:${side === "front" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222"}:${side}`
    : source === "mpc"
      ? `mpc:${side === "front" ? "a" : "b"}`.padEnd(68, "0")
      : `upload:${side === "front" ? "c" : "d"}`.padEnd(71, "0");
  return {
    id,
    source,
    identityId: dfcIdentity.id,
    faceId: side,
    faceName: `${side === "front" ? "Delver of Secrets" : "Insectile Aberration"} · ${source}`,
    effectiveDpi: 450,
    widthPx: 750,
    heightPx: 1050,
    originalAvailable: true,
    originalCached: true,
    metadata: { originalFormat: "png", byteLength: 120_000, imageStatus: "verified" },
  };
}

describe("M6 Artwork Picker face context", () => {
  it("uses real DFC faces and offers Scryfall, MPC, and compatible uploads on both sides", async () => {
    const user = userEvent.setup();
    const resolveRequests: Array<{ action: string; faceId?: string; candidateId?: string; scope?: string }> = [];
    const artworkRequests: Array<{ faceId: string; source: string; physicalBackArtwork?: boolean }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cards/import") return Response.json({ workingCards: [dfc], report: { summary: {}, sources: [], selectedImporters: [], warnings: [], errors: [], pairings: [] }, providerHealth });
      if (url === "/api/cards/resolve") {
        const body = JSON.parse(String(init?.body)) as { action: string; cards?: WorkingCard[]; targetCardId?: string; faceId?: "front" | "back"; candidateId?: string; scope?: string };
        resolveRequests.push(body);
        if (body.action === "apply-artwork-scope" && body.cards && body.targetCardId && body.faceId && body.candidateId) {
          const target = body.cards.find((item) => item.id === body.targetCardId)!;
          const selected = { candidateId: body.candidateId, source: body.candidateId.startsWith("mpc:") ? "mpc" as const : body.candidateId.startsWith("upload:") ? "upload" as const : "scryfall" as const, identityId: target.identity?.id ?? null, faceId: body.faceId, selectionPolicy: "user-selected" };
          return Response.json({ workingCards: body.cards.map((item) => item.id === target.id ? { ...item, selectedArtworkByFace: { ...item.selectedArtworkByFace, [body.faceId!]: selected } } : item), providerHealth });
        }
        return Response.json({ workingCards: body.cards ?? [dfc], providerHealth });
      }
      if (url === "/api/back-library") return Response.json({ assets: [] });
      if (url === "/api/projects") return Response.json({ projects: [] });
      if (url === "/api/templates") return Response.json({ templates: [] });
      if (url === "/api/printer-profiles") return Response.json({ profiles: [] });
      if (url === "/api/cards/artworks/mpc-catalogs") return Response.json({ catalogs: { sources: [], dpi: [], layouts: [], languages: [] } });
      if (url === `/api/cards/${encodeURIComponent(dfc.id)}`) return Response.json({ identity: dfcIdentity });
      if (url.endsWith("/artworks")) {
        const body = JSON.parse(String(init?.body)) as { faceId: "front" | "back"; source: string; physicalBackArtwork?: boolean };
        artworkRequests.push(body);
        const sources = body.source === "all" ? ["scryfall", "mpc", "upload"] as const : [body.source as "scryfall" | "mpc" | "upload"];
        const candidates = sources.map((source) => candidate(source, body.faceId));
        return Response.json({ candidates, catalogTotal: candidates.length, catalogTotalComplete: true, providerHealth });
      }
      if (url.includes("/prepare")) {
        const match = artworkRequests.at(-1);
        return Response.json({ candidate: candidate(match?.source === "mpc" ? "mpc" : match?.source === "upload" ? "upload" : "scryfall", match?.faceId === "back" ? "back" : "front") });
      }
      return Response.json({ message: `Rota não simulada: ${url}` }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);
    await user.type(screen.getByRole("textbox", { name: "Cole uma decklist ou URL" }), "1 Delver of Secrets");
    await user.click(screen.getByRole("button", { name: "Adicionar cartas" }));
    await screen.findByRole("button", { name: /1\/1 · Delver of Secrets/ });
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    const openPicker = async () => {
      await user.click(await screen.findByRole("button", { name: "Trocar artwork" }));
      return screen.findByRole("dialog", { name: /Delver of Secrets/ });
    };

    const dialog = await openPicker();
    expect(within(dialog).getByText("Dupla face")).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: "Frente · Delver of Secrets" })).toBeInTheDocument();
    const providerGroup = within(dialog).getByRole("group", { name: "Filtrar provider" });
    expect(providerGroup).toHaveTextContent("Scryfall");
    expect(providerGroup).toHaveTextContent("MPC Autofill");
    expect(providerGroup).not.toHaveTextContent("Meus uploads");
    expect(within(dialog).getByText("Nenhuma artwork aplicada")).toBeInTheDocument();

    const frontCandidate = await within(dialog).findByText("Delver of Secrets · scryfall");
    const frontCard = frontCandidate.closest<HTMLElement>(".artwork-candidate")!;
    await user.click(within(frontCard).getByRole("button", { name: "Selecionar arte" }));
    await waitFor(() => expect(resolveRequests.at(-1)).toMatchObject({ action: "apply-artwork-scope", faceId: "front", scope: "entry" }));
    expect(screen.getByRole("dialog", { name: /Delver of Secrets/ })).toBe(dialog);
    await waitFor(() => expect(within(dialog).getByText(/Atual · Scryfall/i)).toBeInTheDocument());
    expect(within(dialog).getByRole("img", { name: /Artwork atual de Delver of Secrets/ })).toBeInTheDocument();

    const backTab = within(dialog).getByRole("tab", { name: "Verso · Insectile Aberration" });
    await user.click(backTab);
    expect(backTab).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getAllByText("Back · Insectile Aberration").length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole("heading", { name: "Verso da carta simples" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Sem verso" })).not.toBeInTheDocument();

    const bulkToggle = within(dialog).getByRole("checkbox", { name: "Aplicar também às cópias iguais" });
    await user.click(bulkToggle);
    expect(bulkToggle).toBeChecked();
    const backScryfallCandidate = await within(dialog).findByText("Insectile Aberration · scryfall");
    await user.click(within(backScryfallCandidate.closest<HTMLElement>(".artwork-candidate")!).getByRole("button", { name: "Selecionar arte" }));
    await waitFor(() => expect(resolveRequests.at(-1)).toMatchObject({ action: "apply-artwork-scope", faceId: "back", scope: "same-identity" }));
    expect(screen.getByRole("dialog", { name: /Delver of Secrets/ })).toBe(dialog);

    await user.click(bulkToggle);
    expect(bulkToggle).not.toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "MPC Autofill" }));
    const backMpcCandidate = await within(dialog).findByText("Insectile Aberration · mpc");
    const backMpcCard = backMpcCandidate.closest<HTMLElement>(".artwork-candidate")!;
    await user.click(within(backMpcCard).getByRole("button", { name: "Selecionar arte" }));
    await waitFor(() => expect(resolveRequests.at(-1)).toMatchObject({ action: "apply-artwork-scope", faceId: "back", scope: "entry" }));
    expect(artworkRequests.some((request) => request.faceId === "back" && request.source === "mpc" && request.physicalBackArtwork === false)).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Meus uploads" })).not.toBeInTheDocument();
  }, 15_000);

  it("keeps simple-card backs semantic, uses Back Library/MPC, and reports project-wide DFC impact", async () => {
    const user = userEvent.setup();
    const hash = "e".repeat(64);
    const backAsset = { assetId: `back:${hash}`, sha256: hash, format: "png" as const, name: "Blue cardback", widthPx: 600, heightPx: 840, retired: false };
    const simpleBackCandidate: ArtworkCandidate = {
      id: `mpc:${"f".repeat(64)}`, source: "mpc", identityId: null, faceId: "back", providerAssetId: "verified-cardback",
      faceName: "MPC cardbacks",
      originalAvailable: true, originalCached: true, effectiveDpi: 450,
      metadata: { cardType: "CARDBACK", originalFormat: "png", byteLength: 120_000 },
    };
    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cards/import") return Response.json({ workingCards: [simple, dfc], report: { summary: {}, sources: [], selectedImporters: [], warnings: [], errors: [], pairings: [] }, providerHealth });
      if (url === "/api/cards/resolve") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { cards?: WorkingCard[]; targetCardId?: string; choiceMode?: string; scope?: string };
        requests.push(body);
        let nextCards = body.cards ?? [simple, dfc];
        if (body.action === "apply-generic-back-scope") {
          nextCards = nextCards.map((item) => {
            const shouldApply = body.scope === "all-simple-project" ? item.id === simple.id : item.id === body.targetCardId;
            if (!shouldApply) return item;
            if (body.choiceMode === "none") return { ...item, backMode: "none", manualBackAsset: undefined, manualBackArtwork: undefined };
            if (body.choiceMode === "project-default") return { ...item, backMode: "project-default", manualBackAsset: undefined, manualBackArtwork: undefined };
            if (body.choiceMode === "library") return { ...item, backMode: "manual", backModeSelectionPolicy: "explicit", manualBackAsset: body.asset as WorkingCard["manualBackAsset"], manualBackArtwork: undefined };
            if (body.choiceMode === "mpc") return { ...item, backMode: "manual", backModeSelectionPolicy: "explicit", manualBackAsset: undefined, manualBackArtwork: { candidateId: String(body.candidateId), source: "mpc", identityId: null, faceId: "back", selectionPolicy: "user-selected" } };
            return item;
          });
        }
        return Response.json({ workingCards: nextCards, impact: { affectedEntries: 1, affectedPhysicalCards: 2, preservedDfcEntries: 1, preservedDfcPhysicalCards: 1 }, providerHealth });
      }
      if (url === "/api/back-library") return Response.json({ assets: [backAsset] });
      if (url === "/api/projects") return Response.json({ projects: [] });
      if (url === "/api/templates") return Response.json({ templates: [] });
      if (url === "/api/printer-profiles") return Response.json({ profiles: [] });
      if (url === "/api/cards/artworks/mpc-catalogs") return Response.json({ catalogs: { sources: [], dpi: [], layouts: [], languages: [] } });
      if (url.endsWith("/artworks")) {
        const body = JSON.parse(String(init?.body)) as { faceId: string; source: string; physicalBackArtwork?: boolean };
        requests.push(body);
        return Response.json({ candidates: body.physicalBackArtwork ? [simpleBackCandidate] : [], catalogTotal: body.physicalBackArtwork ? 1 : 0, catalogTotalComplete: true, providerHealth });
      }
      if (url.includes("/prepare")) return Response.json({ candidate: simpleBackCandidate });
      return Response.json({ message: `Rota não simulada: ${url}` }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);
    await user.type(screen.getByRole("textbox", { name: "Cole uma decklist ou URL" }), "2 Island\n1 Delver of Secrets");
    await user.click(screen.getByRole("button", { name: "Adicionar cartas" }));
    await screen.findByRole("button", { name: /1\/2 · Island/ });
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Verso padrão do Project" }), backAsset.assetId);
    await user.click(screen.getByRole("tab", { name: "Cartas" }));

    const openBackPicker = async () => {
      await user.click(await screen.findByRole("button", { name: "Trocar artwork" }));
      const picker = await screen.findByRole("dialog", { name: /Island/ });
      await user.click(within(picker).getByRole("tab", { name: "Verso" }));
      return picker;
    };

    const dialog = await openBackPicker();
    expect(within(dialog).queryByRole("group", { name: "Filtrar provider" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Sem verso" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Project Default Back · Blue cardback/ })).toHaveAttribute("aria-current", "true");
    expect(within(dialog).getByRole("heading", { name: "Back Library" })).toBeInTheDocument();
    expect(await within(dialog).findByText("MPC cardbacks")).toBeInTheDocument();
    expect(requests).toContainEqual(expect.objectContaining({ faceId: "front", source: "mpc", physicalBackArtwork: true }));

    await user.click(within(dialog).getByRole("button", { name: "Sem verso" }));
    await waitFor(() => expect(requests.filter((request) => request.action === "apply-generic-back-scope").at(-1)).toMatchObject({ choiceMode: "none", scope: "entry" }));
    expect(screen.getByRole("dialog", { name: /Island/ })).toBe(dialog);
    await waitFor(() => expect(within(dialog).getByRole("status", { name: "Estado atual do verso" })).toHaveTextContent("Sem verso"));
    expect(within(dialog).getByRole("button", { name: /Sem verso · Atual/ })).toHaveAttribute("aria-current", "true");

    const scopeSelect = within(dialog).getByRole("combobox", { name: "Aplicar verso em" });
    await user.selectOptions(scopeSelect, "all-simple-project");
    await user.click(within(dialog).getByRole("button", { name: /Project Default Back · Blue cardback/ }));
    await waitFor(() => expect(requests.filter((request) => request.action === "apply-generic-back-scope").at(-1)).toMatchObject({ choiceMode: "project-default", scope: "all-simple-project" }));
    await waitFor(() => expect(screen.getAllByText(/Verso aplicado a 2 carta\(s\) simples; 1 cartas dupla-face preservadas\./).length).toBeGreaterThan(0));
    await waitFor(() => expect(within(dialog).getByRole("status", { name: "Estado atual do verso" })).toHaveTextContent("Project Default Back"));

    await user.selectOptions(scopeSelect, "entry");
    await user.click(dialog.querySelector(".picker-back-asset")!);
    await waitFor(() => expect(requests.filter((request) => request.action === "apply-generic-back-scope").at(-1)).toMatchObject({
      choiceMode: "library",
      scope: "entry",
      asset: { assetId: backAsset.assetId, sha256: hash, format: "png" },
    }));
    await waitFor(() => expect(within(dialog).getByRole("status", { name: "Estado atual do verso" })).toHaveTextContent("Back Library · Blue cardback"));
    expect(dialog.querySelector(".picker-back-asset")).toHaveAttribute("aria-current", "true");

    const mpcCard = within(dialog).getByText("MPC cardbacks").closest<HTMLElement>(".artwork-candidate")!;
    await user.click(within(mpcCard).getByRole("button", { name: "Selecionar arte" }));
    await waitFor(() => expect(requests.filter((request) => request.action === "apply-generic-back-scope").at(-1)).toMatchObject({
      choiceMode: "mpc",
      scope: "entry",
      candidateId: simpleBackCandidate.id,
    }));
    await waitFor(() => expect(within(dialog).getByRole("status", { name: "Estado atual do verso" })).toHaveTextContent(`MPC Autofill · ${simpleBackCandidate.id}`));
    expect(within(dialog).getByRole("button", { name: "Selecionada" })).toBeInTheDocument();
  }, 15_000);

  it("aborts obsolete progressive Scryfall completion when the picker changes face", async () => {
    const user = userEvent.setup();
    let frontCompletionStarted = false;
    let frontCompletionAborted = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "/api/cards/import") return Response.json({
        workingCards: [dfc],
        report: { summary: {}, sources: [], selectedImporters: [], warnings: [], errors: [], pairings: [] },
        providerHealth,
      });
      if (url === "/api/cards/resolve") {
        const body = JSON.parse(String(init?.body)) as { cards?: WorkingCard[] };
        return Response.json({ workingCards: body.cards ?? [dfc], providerHealth });
      }
      if (url === "/api/back-library") return Response.json({ assets: [] });
      if (url === "/api/projects") return Response.json({ projects: [] });
      if (url === "/api/templates") return Response.json({ templates: [] });
      if (url === "/api/printer-profiles") return Response.json({ profiles: [] });
      if (url === "/api/cards/artworks/mpc-catalogs") return Response.json({ catalogs: { sources: [], dpi: [], layouts: [], languages: [] } });
      if (url === `/api/cards/${encodeURIComponent(dfc.id)}`) return Response.json({ identity: dfcIdentity });
      if (url.endsWith("/artworks")) {
        const body = JSON.parse(String(init?.body)) as { faceId: "front" | "back"; source: string; progressive?: boolean };
        if (body.faceId === "front" && body.source === "scryfall" && body.progressive === true) {
          return Response.json({
            candidates: [candidate("scryfall", "front")],
            catalogTotal: 2,
            catalogTotalComplete: false,
            providerHealth,
          });
        }
        if (body.faceId === "front" && body.source === "scryfall" && body.progressive !== true) {
          frontCompletionStarted = true;
          const signal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => {
              frontCompletionAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        if (body.faceId === "back" && body.source === "scryfall") {
          return Response.json({
            candidates: [candidate("scryfall", "back")],
            catalogTotal: 1,
            catalogTotalComplete: true,
            providerHealth,
          });
        }
      }
      return Response.json({ message: `Rota não simulada: ${url}` }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);
    await user.type(screen.getByRole("textbox", { name: "Cole uma decklist ou URL" }), "1 Delver of Secrets");
    await user.click(screen.getByRole("button", { name: "Adicionar cartas" }));
    await screen.findByRole("button", { name: /1\/1 · Delver of Secrets/ });
    await user.click(screen.getByRole("tab", { name: "Cartas" }));
    await user.click(await screen.findByRole("button", { name: "Trocar artwork" }));

    const dialog = await screen.findByRole("dialog", { name: /Delver of Secrets/ });
    await within(dialog).findByText("Delver of Secrets · scryfall");
    await waitFor(() => expect(frontCompletionStarted).toBe(true));

    await user.click(within(dialog).getByRole("tab", { name: "Verso · Insectile Aberration" }));

    await waitFor(() => expect(frontCompletionAborted).toBe(true));
    expect(await within(dialog).findByText("Insectile Aberration · scryfall")).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toHaveTextContent("O restante do catálogo Scryfall não pôde ser carregado.");
  }, 15_000);

});
