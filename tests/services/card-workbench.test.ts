import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCardWorkbench, type CardWorkbenchOptions, type WorkingSetImportResult } from "../../services/card-workbench";
import { handleArtworkList, handleCardImport, handleResolve, parseWorkingCards } from "../../services/card-api";
import { TesseractOcrRecognizer } from "../../providers/ocr/tesseract-recognizer";
import type { ScryfallClient } from "../../providers/scryfall/client";
import type { ScryfallCard } from "../../providers/scryfall/types";
import { formatResolutionSummary } from "../../core/cards/resolution-summary";

const roots: string[] = [];
const workbenches: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const workbench of workbenches.splice(0)) await workbench.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const solRing = JSON.parse(await readFile(new URL("../fixtures/scryfall/normal-card.json", import.meta.url), "utf8")) as Record<string, unknown>;
const basicLand = {
  ...solRing,
  id: "12121212-1212-4121-8121-121212121212",
  oracle_id: "23232323-2323-4232-8232-232323232323",
  name: "Island",
  set: "m21",
  collector_number: "265",
  image_uris: { small: "https://cards.scryfall.io/small/island.jpg", png: "https://cards.scryfall.io/png/island.png" },
  all_parts: undefined,
};
const delverCard = JSON.parse(await readFile(new URL("../fixtures/scryfall/dmf-card.json", import.meta.url), "utf8")) as Record<string, unknown>;

async function setup(fetchImpl?: typeof fetch, recognizer?: CardWorkbenchOptions["recognizer"], scryfallClient?: ScryfallClient) {
  const root = await mkdtemp(join(tmpdir(), "tcgprint-workbench-"));
  roots.push(root);
  const workbench = await createCardWorkbench({ dataDirectory: root, fetchImpl, minIntervalMs: 0, ...(recognizer ? { recognizer } : {}), ...(scryfallClient ? { scryfallClient } : {}) });
  workbenches.push(workbench);
  return { root, workbench };
}

function resolvedCard(name: string, id: string, oracleId: string, setCode: string, collectorNumber: string): ScryfallCard {
  const imageRoot = `https://cards.scryfall.io/${id}`;
  return {
    id, oracleId, name, layout: "normal", setCode, collectorNumber, lang: "en", releasedAt: "2024-01-01",
    digital: false, promo: false, fullArt: false, borderColor: "black", imageStatus: "highres_scan",
    imageUris: { small: `${imageRoot}-small.jpg`, png: `${imageRoot}.png` }, faces: [], relatedCards: [], metadata: {},
  };
}

function fakeScryfallClient(cards: readonly ScryfallCard[], printingsPerIdentity = 1) {
  const notFound = () => Object.assign(new Error("not found"), { kind: "not-found" });
  const lookupByName = vi.fn(async (name: string) => cards.find((card) => card.name.toLocaleLowerCase("en") === name.toLocaleLowerCase("en")) ?? Promise.reject(notFound()));
  const lookupById = vi.fn(async (id: string) => cards.find((card) => card.id === id) ?? Promise.reject(notFound()));
  const lookupBySetCollector = vi.fn(async (setCode: string, number: string) => cards.find((card) => card.setCode === setCode && card.collectorNumber === number) ?? Promise.reject(notFound()));
  const listPrintings = vi.fn(async (oracleId: string) => {
    const card = cards.find((item) => item.oracleId === oracleId);
    if (!card) return [];
    return Array.from({ length: printingsPerIdentity }, (_, index) => index === 0 ? card : {
      ...card,
      id: `${String(index).padStart(8, "0")}-9999-4999-8999-999999999999`,
      collectorNumber: String(index + 1),
    });
  });
  const searchCards = vi.fn(async () => [...cards]);
  const downloadAsset = vi.fn(async () => ({ bytes: new Uint8Array(), contentType: "image/png", sourceUrl: "https://cards.scryfall.io/test.png", kind: "thumbnail" as const }));
  const client = { lookupByName, lookupById, lookupBySetCollector, listPrintings, searchCards, downloadAsset, autocomplete: vi.fn(async () => []), getRateLimitState: vi.fn() } as unknown as ScryfallClient;
  return { client, lookupByName, lookupById, lookupBySetCollector, listPrintings, searchCards, downloadAsset };
}

const resolvedDeckPrintings = [
  resolvedCard("Sol Ring", "10101010-1010-4101-8101-101010101010", "20202020-2020-4202-8202-202020202020", "cmm", "396"),
  resolvedCard("Lightning Bolt", "30303030-3030-4303-8303-303030303030", "40404040-4040-4404-8404-404040404040", "2xm", "117"),
  resolvedCard("Counterspell", "50505050-5050-4505-8505-505050505050", "60606060-6060-4606-8606-606060606060", "dmr", "055"),
  resolvedCard("Island", "70707070-7070-4707-8707-707070707070", "80808080-8080-4808-8808-808080808080", "m21", "265"),
];

function scryfallFetch() {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.href);
    expect(new Headers(init?.headers).get("User-Agent")).toMatch(/^TCGPrint\//);
    if (url.pathname === "/cards/named") {
      const name = url.searchParams.get("exact") ?? url.searchParams.get("fuzzy");
      const card = name === "Island" ? basicLand : solRing;
      return Response.json(card);
    }
    if (url.pathname === "/cards/search") {
      const query = url.searchParams.get("q") ?? "";
      const card = query.includes("23232323") || query.includes("Island") ? basicLand : solRing;
      if (query.startsWith("name:")) return Response.json({ data: [card], has_more: false });
      return Response.json({ data: [card], has_more: false });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as typeof fetch, calls, fetchMock: fetchImpl };
}

function collectKeys(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, output));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      output.push(key);
      collectKeys(item, output);
    }
  }
  return output;
}

describe("card workbench services", () => {
  it("keeps deck quantities, sections and order in one session WorkingCard per entry", async () => {
    const { workbench } = await setup();
    const result = await workbench.importForWorkingSet({ text: "Mainboard\n1 Sol Ring\n6 Island\nSideboard\n2 Counterspell" });

    expect(result.workingCards.map(({ quantity, order, section, identityHints }) => ({ quantity, order, section, name: identityHints.name }))).toEqual([
      { quantity: 1, order: 0, section: "Mainboard", name: "Sol Ring" },
      { quantity: 6, order: 1, section: "Mainboard", name: "Island" },
      { quantity: 2, order: 2, section: "Sideboard", name: "Counterspell" },
    ]);
    expect(result.workingCards).toHaveLength(3);
  });

  it("registers upload bytes once by SHA-256 and returns path-free WorkingCard DTOs", async () => {
    const { root, workbench } = await setup();
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const imported = await workbench.importForWorkingSet({ files: [
      { filename: "Sol Ring-front.png", bytes },
      { filename: "Sol Ring-copy.png", bytes: new Uint8Array(bytes) },
    ] });
    const localIds = imported.workingCards.flatMap((card) => card.localArtworkIds);

    expect(localIds).toHaveLength(2);
    expect(new Set(localIds).size).toBe(1);
    expect(imported.workingCards[0].selectedArtworkByFace.front).toMatchObject({ source: "upload", candidateId: localIds[0] });
    expect(collectKeys(imported)).not.toContain("originalBytes");
    expect(collectKeys(imported)).not.toContain("sourcePath");
    expect(collectKeys(imported)).not.toContain("localOriginalPath");
    expect(collectKeys(imported)).not.toContain("originalUri");
    const paths = await readFile(join(root, ".tcgprint", "artwork-cache.sqlite"));
    expect(paths.byteLength).toBeGreaterThan(0);
    expect(await workbench.getArtworkPreview(localIds[0])).toMatchObject({ candidateId: localIds[0], source: "upload" });
  });

  it("keeps the custom upload library explicit and never falls back to it for an external identity", async () => {
    const { workbench } = await setup();
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "unlinked.png", bytes }] });

    const knownIdentity = await workbench.listArtworkCandidates("scryfall:oracle:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "front", "upload");
    const customLibrary = await workbench.listArtworkCandidates("custom:artwork-picker", "front", "upload");

    expect(knownIdentity).toEqual([]);
    expect(customLibrary.map(({ id }) => id)).toEqual(imported.workingCards[0].localArtworkIds);
  });

  it("retains relative folder paths so front/back pairing reaches the Working Set", async () => {
    const { workbench } = await setup();
    const frontBytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const backBytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#753" } }).png().toBuffer());

    const frontBuffer = new ArrayBuffer(frontBytes.byteLength);
    new Uint8Array(frontBuffer).set(frontBytes);
    const backBuffer = new ArrayBuffer(backBytes.byteLength);
    new Uint8Array(backBuffer).set(backBytes);
    const form = new FormData();
    form.append("files", new File([frontBuffer], "Card-Front.png"));
    form.append("files", new File([backBuffer], "Card-Back.png"));
    form.set("filePaths", JSON.stringify(["Deck/Card-Front.png", "Deck/Card-Back.png"]));
    const response = await handleCardImport(new Request("http://localhost/api/cards/import", { method: "POST", body: form }), workbench);
    expect(response.status).toBe(200);
    const imported = await response.json() as WorkingSetImportResult;

    expect(imported.report.pairings).toHaveLength(1);
    expect(imported.report.pairings[0]).toMatchObject({ accepted: false, reason: expect.stringContaining("same directory") });
    expect(imported.workingCards[0].faceAssociations).toEqual([{
      slot: "folder-pair",
      frontAssetId: imported.workingCards[0].localArtworkIds[0],
      backAssetId: imported.workingCards[1].localArtworkIds[0],
      confidence: 0.99,
      reason: "Basenames share the same directory and an explicit front/back suffix.",
      accepted: false,
    }]);
  });

  it("resolves a name through cached metadata and assigns a deterministic default without expanding quantity", async () => {
    const fake = scryfallFetch();
    const { workbench } = await setup(fake.fetchImpl);
    const imported = await workbench.importForWorkingSet({ text: "6 Sol Ring" });
    const first = await workbench.resolveWorkingCards(imported.workingCards);
    const callCount = fake.fetchMock.mock.calls.length;
    const repeated = await workbench.resolveWorkingCards(first.workingCards);

    expect(first.workingCards).toHaveLength(1);
    expect(first.workingCards[0]).toMatchObject({ quantity: 6, identity: { name: "Sol Ring", oracleId: solRing.oracle_id }, selectedArtworkByFace: { front: { source: "scryfall", candidateId: `scryfall:${solRing.id}:front` } } });
    expect(repeated.workingCards[0].id).toBe(first.workingCards[0].id);
    expect(fake.fetchMock).toHaveBeenCalledTimes(callCount);
  });

  it("resolves four deck entries without listing printings or expanding quantities", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings, 300);
    const { workbench } = await setup(undefined, undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring\n1 Lightning Bolt\n1 Counterspell\n6 Island" });
    const result = await workbench.resolveWorkingCards(imported.workingCards);

    expect(result.workingCards).toHaveLength(4);
    expect(result.workingCards.map((card) => card.quantity)).toEqual([1, 1, 1, 6]);
    expect(result.workingCards.map((card) => card.identity?.name)).toEqual(["Sol Ring", "Lightning Bolt", "Counterspell", "Island"]);
    expect(result.workingCards.map((card) => card.selectedArtworkByFace.front?.candidateId)).toEqual(resolvedDeckPrintings.map((card) => `scryfall:${card.id}:front`));
    expect(fake.lookupByName).toHaveBeenCalledTimes(4);
    expect(fake.listPrintings).not.toHaveBeenCalled();
    expect(fake.downloadAsset).not.toHaveBeenCalled();
  });

  it("lists printing alternatives only when the Artwork Picker endpoint is opened", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const resolved = await workbench.resolveWorkingCards(imported.workingCards);
    const identity = resolved.workingCards[0].identity!;

    expect(resolved.workingCards[0].selectedArtworkByFace.front).toMatchObject({ candidateId: `scryfall:${resolvedDeckPrintings[0].id}:front`, source: "scryfall" });
    expect(fake.listPrintings).not.toHaveBeenCalled();
    const response = await handleArtworkList(new Request(`http://localhost/api/cards/${encodeURIComponent(identity.id)}/artworks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faceId: "front", source: "scryfall" }),
    }), identity.id, workbench);
    const body = await response.json() as { candidates: Array<{ candidateId?: string; id: string }> };

    expect(response.status).toBe(200);
    expect(fake.listPrintings).toHaveBeenCalledOnce();
    expect(body.candidates.map((candidate) => candidate.id)).toContain(`scryfall:${resolvedDeckPrintings[0].id}:front`);
  });

  it("preserves preselected upload and MPC artwork while resolving identity", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, undefined, fake.client);
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const upload = await workbench.importForWorkingSet({ files: [{ filename: "local.png", bytes }] });
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring\n1 Lightning Bolt" });
    const uploadSelection = upload.workingCards[0].selectedArtworkByFace.front!;
    const mpcSelection = { candidateId: `mpc:${"b".repeat(64)}`, source: "mpc" as const, identityId: null, faceId: "front" as const, selectedArtworkId: "mpc-front-7" };
    const cards = imported.workingCards.map((card, index) => ({
      ...card,
      selectedArtworkByFace: { front: index === 0 ? uploadSelection : mpcSelection },
    }));
    const result = await workbench.resolveWorkingCards(cards);

    expect(result.workingCards[0].selectedArtworkByFace.front).toEqual({ ...uploadSelection, identityId: result.workingCards[0].identity?.id });
    expect(result.workingCards[1].selectedArtworkByFace.front).toEqual(mpcSelection);
    expect(fake.listPrintings).not.toHaveBeenCalled();
  });

  it("keeps upload usage working with Scryfall degraded and does not call Scryfall for MPC references", async () => {
    const failingFetch = vi.fn(async () => new Response("offline", { status: 503 })) as typeof fetch;
    const { workbench } = await setup(failingFetch);
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const upload = await workbench.importForWorkingSet({ files: [{ filename: "custom.png", bytes }] });
    expect(await workbench.getArtworkPreview(upload.workingCards[0].localArtworkIds[0])).toMatchObject({ source: "upload" });
    await expect(workbench.resolveWorkingCards(upload.workingCards)).resolves.toMatchObject({ providerHealth: { scryfall: { degraded: true } } });

    const xml = new TextEncoder().encode("<order><details><quantity>1</quantity></details><fronts><card><id>art-front-9</id><slots>1</slots><name>Custom</name></card></fronts></order>");
    const mpc = await workbench.importForWorkingSet({ files: [{ filename: "order.xml", bytes: xml }] });
    expect(mpc.workingCards[0].selectedArtworkByFace.front).toMatchObject({ source: "mpc", selectedArtworkId: "art-front-9" });
    expect(mpc.workingCards[0].mpcReferences[0].selectedArtworkId).toBe("art-front-9");
    expect(failingFetch).toHaveBeenCalledTimes(1);
  });

  it("reports unresolved cards and provider degradation instead of a false full-success message", async () => {
    const offlineFetch = vi.fn(async () => new Response("offline", { status: 503 })) as typeof fetch;
    const { workbench } = await setup(offlineFetch);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const resolved = await workbench.resolveWorkingCards(imported.workingCards);
    const status = formatResolutionSummary(resolved.workingCards, resolved.providerHealth);

    expect(resolved.workingCards[0]).toMatchObject({ identity: null, identityResolution: { status: "unresolved" } });
    expect(resolved.providerHealth.scryfall).toMatchObject({ degraded: true });
    expect(status).toContain("1 não resolvida");
    expect(status).toContain("Scryfall degradado");
    expect(status).not.toContain("Resolução concluída");
  });

  it("preserves the shared MPC cardback through Universal Import, WorkingCard, and API DTO round-trip", async () => {
    const { workbench } = await setup();
    const xml = new Uint8Array(await readFile(new URL("../fixtures/import-engine/mpc-order-synthetic.xml", import.meta.url)));
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "mpc-order-synthetic.xml", bytes: xml }] });
    const card = imported.workingCards[0];

    expect(card.sharedMpcCardback).toMatchObject({
      providerAssetId: "synthetic-cardback-artwork",
      selectedArtworkId: "synthetic-cardback-artwork",
      originalFormat: "mpc-cardback-reference",
      provenance: { sourceFilename: "mpc-order-synthetic.xml" },
      availableLocally: false,
    });
    expect(card.sharedMpcCardback?.importedAssetId).toEqual(expect.any(String));
    expect(card.faces.map((face) => face.side)).toEqual(["front", "back"]);

    const dtoRoundTrip = parseWorkingCards(JSON.parse(JSON.stringify([card])))[0];
    const response = await handleResolve(new Request("http://localhost/api/cards/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "custom", cards: [dtoRoundTrip] }),
    }), workbench);
    const body = await response.json() as { workingCards: typeof imported.workingCards };

    expect(response.status).toBe(200);
    expect(body.workingCards[0].sharedMpcCardback).toEqual(card.sharedMpcCardback);
    expect(body.workingCards[0].selectedArtworkByFace.back?.selectedArtworkId).toBe("synthetic-back-art-a");
  });

  it("honors caller cancellation before starting resolution", async () => {
    const { workbench } = await setup();
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const controller = new AbortController();
    controller.abort();
    await expect(workbench.resolveWorkingCards(imported.workingCards, { signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("disposes the lazily created OCR worker when the workbench closes", async () => {
    const worker = {
      recognize: vi.fn(async () => ({ data: { text: "Unknown Card Name" } })),
      terminate: vi.fn(async () => undefined),
    };
    const workerFactory = vi.fn(async () => worker);
    const recognizer = new TesseractOcrRecognizer({ cachePath: "/tmp/tcgprint-workbench-ocr-test", workerFactory });
    const offline = vi.fn(async () => new Response("not found", { status: 404 })) as typeof fetch;
    const { workbench } = await setup(offline, recognizer);
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "mystery-card.png", bytes }] });
    await workbench.resolveWorkingCards(imported.workingCards);

    expect(workerFactory).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
    workbenches.splice(workbenches.indexOf(workbench), 1);
    await workbench.close();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("maps a resolved DFC to two faces while preserving a local front and selecting Scryfall for the back", async () => {
    const requestPaths: string[] = [];
    const fakeFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestPaths.push(url.pathname);
      if (url.pathname === "/cards/named") return Response.json(delverCard);
      if (url.pathname === "/cards/search") return Response.json({ data: [delverCard], has_more: false });
      return new Response("offline", { status: 503 });
    });
    const { workbench } = await setup(fakeFetch as typeof fetch);
    const bytes = new Uint8Array(await sharp({ create: { width: 40, height: 56, channels: 3, background: "#695" } }).png().toBuffer());
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "delver-front.png", bytes }], text: "1 Delver of Secrets // Insectile Aberration" });
    const uploadedCard = imported.workingCards.find((item) => item.localArtworkIds.length > 0)!;
    const deckEntry = imported.workingCards.find((item) => item.identityHints.name?.includes("//"))!;
    const localId = uploadedCard.localArtworkIds[0];
    const working = {
      ...deckEntry,
      faces: [{ id: "front", side: "front" as const, name: "Delver of Secrets", importedAssetId: localId }, { id: "back", side: "back" as const, name: "Insectile Aberration" }],
      selectedArtworkByFace: { front: { candidateId: localId, source: "upload" as const, identityId: null, faceId: "front" as const } },
      localArtworkIds: [localId],
    };
    const resolved = await workbench.resolveWorkingCards([working]);
    const result = resolved.workingCards[0];

    expect(result.id).toBe(working.id);
    expect(result.faces).toEqual([{ id: "front", side: "front", name: "Delver of Secrets", importedAssetId: localId }, { id: "back", side: "back", name: "Insectile Aberration" }]);
    expect(result.identity?.id).toBe(`scryfall:oracle:${delverCard.oracle_id}`);
    expect(result.selectedArtworkByFace.front).toMatchObject({ candidateId: localId, source: "upload", identityId: result.identity?.id });
    expect(result.selectedArtworkByFace.back).toMatchObject({ source: "scryfall", faceId: "back", candidateId: `scryfall:${delverCard.id}:back` });
    expect(requestPaths).toEqual(["/cards/named"]);
    expect(await workbench.getArtworkOriginal(localId)).toMatchObject({ bytes });
  });
});
