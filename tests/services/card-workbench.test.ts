import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { PDFDocument } from "@pdfme/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artworkQualityFromCandidate, createCardWorkbench, type CardWorkbenchOptions, type WorkingSetImportResult } from "../../services/card-workbench";
import { handleArtworkList, handleCardExport, handleCardImport, handleResolve, parseWorkingCards } from "../../services/card-api";
import { ArtworkCatalog } from "../../artwork/catalog";
import { appDataPaths, originalPathForHash } from "../../artwork/storage/paths";
import { ScryfallClient, type ScryfallClient as ScryfallClientType } from "../../providers/scryfall/client";
import type { CardWorkbench } from "../../services/card-workbench";
import type { ScryfallCard } from "../../providers/scryfall/types";
import type { ArtworkCandidate } from "../../core/cards/types";
import { mapScryfallCard } from "../../providers/scryfall/mapper";
import { ScryfallError } from "../../providers/scryfall/errors";
import { formatResolutionSummary } from "../../core/cards/resolution-summary";
import { mpcArtworkCandidateId } from "../../core/cards/ids";
import { BackSelectionPolicyError, isDoubleFacedIdentity } from "../../core/cards/back-selection";
import { NO_CUT_GUIDES } from "../helpers/cut-guides";
import { runAddCardsFlow } from "../../src/app/card-identity-workbench";
import { deserializeProjectSnapshot, serializeProjectSnapshot, DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";

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

async function setup(fetchImpl?: typeof fetch, scryfallClient?: ScryfallClientType, mpcFetchImpl?: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "tcgprint-workbench-"));
  roots.push(root);
  const workbench = await createCardWorkbench({ dataDirectory: root, fetchImpl, minIntervalMs: 0, ...(mpcFetchImpl ? { mpcFetchImpl } : {}), ...(scryfallClient ? { scryfallClient } : {}) });
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
  const downloadAsset = vi.fn(async (sourceUrl: string, options: { kind: "thumbnail" | "original" }) => ({ bytes: new Uint8Array(), contentType: "image/png", sourceUrl, kind: options.kind }));
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

function cardApiFetcher(workbench: CardWorkbench) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    const request = new Request(input instanceof Request ? input : url, init);
    if (url.pathname === "/api/cards/import") return handleCardImport(request, workbench);
    if (url.pathname === "/api/cards/resolve") return handleResolve(request, workbench);
    throw new Error(`Unexpected add-cards request: ${url.pathname}`);
  });
}

describe("card workbench services", () => {
  it("does not treat dimensions as effective DPI until original validation records it", () => {
    expect(artworkQualityFromCandidate({ id: "remote", source: "scryfall", identityId: "scryfall:oracle:sol-ring", faceId: "front", originalAvailable: true, widthPx: 3000, heightPx: 4200 })).toBe("unknown");
    expect(artworkQualityFromCandidate({ id: "validated", source: "scryfall", identityId: "scryfall:oracle:sol-ring", faceId: "front", originalAvailable: true, widthPx: 3000, heightPx: 4200, effectiveDpi: 798 })).toBe("excellent");
  });

  it("derives upload display assets from the validated original without replacing the catalog thumbnail", async () => {
    const originalBytes = new Uint8Array(await sharp({ create: { width: 1500, height: 2100, channels: 3, background: "#579" } }).png().toBuffer());
    const { workbench } = await setup();
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "high-resolution.png", bytes: originalBytes }] });
    const candidateId = imported.workingCards[0]!.localArtworkIds[0]!;

    const firstPreview = await workbench.getArtworkPreview(candidateId);
    const display = await workbench.getArtworkDisplay(candidateId, 1024);
    const secondPreview = await workbench.getArtworkPreview(candidateId);

    expect(firstPreview).toMatchObject({ widthPx: 300, heightPx: 420 });
    expect(display).toMatchObject({ widthPx: 1024, heightPx: 1434, source: "original" });
    expect(display!.widthPx).toBeGreaterThan(firstPreview!.widthPx);
    expect(secondPreview).toMatchObject({ widthPx: 300, heightPx: 420 });
    expect(secondPreview!.bytes).toEqual(firstPreview!.bytes);
  });

  it("uses the canonical Scryfall original URI for compositor display while keeping its small catalog preview", async () => {
    const source = resolvedCard("Sol Ring", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cmm", "396");
    const fake = fakeScryfallClient([source]);
    const originalBytes = new Uint8Array(await sharp({ create: { width: 1500, height: 2100, channels: 3, background: "#579" } }).png().toBuffer());
    const smallBytes = new Uint8Array(await sharp({ create: { width: 640, height: 896, channels: 3, background: "#357" } }).png().toBuffer());
    fake.downloadAsset.mockImplementation(async (sourceUrl, options) => ({
      bytes: options.kind === "original" ? originalBytes : smallBytes,
      contentType: "image/png",
      sourceUrl,
      kind: options.kind,
    }));
    const { workbench } = await setup(undefined, fake.client);
    const candidates = await workbench.listArtworkCandidates(`scryfall:oracle:${source.oracleId}`, "front", "scryfall");
    const candidate = candidates[0]!;

    const preview = await workbench.getArtworkPreview(candidate.id);
    const display = await workbench.getArtworkDisplay(candidate.id, 1024);

    expect(candidate.previewUri).toContain("-small.jpg");
    expect(preview).toMatchObject({ widthPx: 300, heightPx: 420 });
    expect(display).toMatchObject({ widthPx: 1024, heightPx: 1434, source: "original" });
    expect(fake.downloadAsset.mock.calls.map(([, options]) => options.kind)).toEqual(["thumbnail", "original"]);
    expect(fake.downloadAsset.mock.calls[1]?.[0]).toContain(".png");
  });

  it("falls back to the catalog preview when the canonical provider original is unavailable", async () => {
    const source = resolvedCard("Sol Ring", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "cmm", "396");
    const fake = fakeScryfallClient([source]);
    const smallBytes = new Uint8Array(await sharp({ create: { width: 640, height: 896, channels: 3, background: "#357" } }).png().toBuffer());
    fake.downloadAsset.mockImplementation(async (sourceUrl, options) => {
      if (options.kind === "original") throw new ScryfallError("network", "original unavailable");
      return { bytes: smallBytes, contentType: "image/png", sourceUrl, kind: options.kind };
    });
    const { workbench } = await setup(undefined, fake.client);
    const candidate = (await workbench.listArtworkCandidates(`scryfall:oracle:${source.oracleId}`, "front", "scryfall"))[0]!;

    const display = await workbench.getArtworkDisplay(candidate.id, 1024);

    expect(display).toMatchObject({ widthPx: 300, heightPx: 420, source: "preview" });
    expect(fake.downloadAsset.mock.calls.map(([, options]) => options.kind)).toEqual(["original", "thumbnail"]);
  });

  it("keeps a Scryfall printing at index 800 selectable and sends it through validated original storage", async () => {
    const source = resolvedCard("Sol Ring", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cmm", "396");
    const fake = fakeScryfallClient([source], 1200);
    const originalBytes = new Uint8Array(await sharp({ create: { width: 1995, height: 2793, channels: 3, background: "#579" } }).png().toBuffer());
    fake.downloadAsset.mockResolvedValue({ bytes: originalBytes, contentType: "image/png", sourceUrl: source.imageUris!.png!, kind: "original" });
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0]!, source.id);

    const catalog = await workbench.listArtworkCandidates(identified.identity!.id, "front", "scryfall");
    expect(fake.downloadAsset).not.toHaveBeenCalled();
    const distant = catalog[800]!;
    const selected = workbench.selectArtwork(identified, "front", distant);
    const original = await workbench.getArtworkOriginal(distant.id);
    const exportResponse = await handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: [selected], options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES } }),
    }), workbench);

    expect(catalog).toHaveLength(1200);
    expect(selected.selectedArtworkByFace.front).toMatchObject({ candidateId: distant.id, source: "scryfall" });
    expect(original.bytes).toEqual(originalBytes);
    expect(await workbench.getArtworkCandidate(distant.id)).toMatchObject({ effectiveDpi: 798, widthPx: 1995, heightPx: 2793 });
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("Content-Type")).toBe("application/pdf");
    expect(await PDFDocument.load(await exportResponse.arrayBuffer()).then((pdf) => pdf.getPageCount())).toBe(1);
    expect(fake.downloadAsset).toHaveBeenCalledOnce();
  }, 30_000);

  it("passes three Scryfall printing pages through CardWorkbench and the artwork API without mixing DFC faces", async () => {
    const pages: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/cards/${String(delverCard.id)}`) return Response.json(delverCard);
      if (url.pathname === "/cards/search") {
        const page = Number(url.searchParams.get("page") ?? 1);
        pages.push(page);
        const printing = { ...delverCard, id: `dfc-printing-${page}`, collector_number: String(page) };
        const nextPage = page < 3
          ? `https://api.scryfall.com/cards/search?q=oracleid%3A${String(delverCard.oracle_id)}&unique=prints&order=released&page=${page + 1}`
          : undefined;
        return Response.json({ data: [printing], has_more: page < 3, ...(nextPage ? { next_page: nextPage } : {}) });
      }
      throw new Error(`Unexpected Scryfall request: ${url.pathname}`);
    };
    const client = new ScryfallClient({ fetchImpl, minIntervalMs: 0 });
    const { workbench } = await setup(undefined, client);
    const imported = await workbench.importForWorkingSet({ text: "1 Delver of Secrets" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0]!, String(delverCard.id));
    const request = (faceId: "front" | "back") => new Request("http://localhost/api/cards/artworks", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ faceId, source: "scryfall" }),
    });

    const frontResponse = await handleArtworkList(request("front"), identified.identity!.id, workbench);
    const frontBody = await frontResponse.json() as { candidates: Array<Record<string, unknown>> };
    const backResponse = await handleArtworkList(request("back"), identified.identity!.id, workbench);
    const backBody = await backResponse.json() as { candidates: Array<Record<string, unknown>> };

    expect(pages).toEqual([1, 2, 3]);
    expect(frontBody.candidates).toHaveLength(3);
    expect(backBody.candidates).toHaveLength(3);
    expect(frontBody.candidates.every((candidate) => candidate.faceId === "front" && candidate.faceName === "Delver of Secrets")).toBe(true);
    expect(backBody.candidates.every((candidate) => candidate.faceId === "back" && candidate.faceName === "Insectile Aberration")).toBe(true);
  });
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

  it("continues to resolve an explicit decklist entry for 1 Island", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Island" });
    const resolved = await workbench.resolveWorkingCards(imported.workingCards);

    expect(resolved.workingCards[0]).toMatchObject({ identity: { name: "Island", resolutionMethod: "name" }, identityResolution: { status: "resolved" } });
    expect(fake.lookupByName).toHaveBeenCalledWith("Island", "exact", expect.anything());
  });

  it("adds a full decklist in one operation with order, sections, quantities, DFC faces, and Project round-trip intact", async () => {
    const delver = mapScryfallCard(delverCard);
    const fake = fakeScryfallClient([...resolvedDeckPrintings, delver]);
    fake.lookupByName.mockImplementation(async (name) => name === "Delver of Secrets"
      ? delver
      : resolvedDeckPrintings.find((item) => item.name === name) ?? Promise.reject(Object.assign(new Error("not found"), { kind: "not-found" })));
    const { workbench } = await setup(undefined, fake.client);
    const fetcher = cardApiFetcher(workbench);
    const form = new FormData();
    form.set("text", "Mainboard\n4 Island\n2 Sol Ring\nSideboard\n1 Delver of Secrets");
    const phases: string[] = [];

    const result = await runAddCardsFlow(form, new AbortController().signal, fetcher, (phase) => phases.push(phase));

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual(["/api/cards/import", "/api/cards/resolve"]);
    expect(phases).toEqual(["import", "resolve"]);
    expect(result.workingCards.map(({ quantity, order, section, identity, identityResolution }) => ({
      quantity, order, section, name: identity?.name, status: identityResolution.status,
    }))).toEqual([
      { quantity: 4, order: 0, section: "Mainboard", name: "Island", status: "resolved" },
      { quantity: 2, order: 1, section: "Mainboard", name: "Sol Ring", status: "resolved" },
      { quantity: 1, order: 2, section: "Sideboard", name: "Delver of Secrets // Insectile Aberration", status: "resolved" },
    ]);
    expect(result.workingCards[2]).toMatchObject({
      identity: { metadata: { layout: "transform" } },
      faces: [{ side: "front", name: "Delver of Secrets" }, { side: "back", name: "Insectile Aberration" }],
      selectedArtworkByFace: {
        front: { source: "scryfall", faceId: "front" },
        back: { source: "scryfall", faceId: "back" },
      },
    });
    expect(result.workingCards[0]?.selectedArtworkByFace.front).toMatchObject({ source: "scryfall", faceId: "front" });
    expect(result.report.sources).toHaveLength(1);
    expect(fake.lookupByName).toHaveBeenCalledTimes(3);
    expect(deserializeProjectSnapshot(serializeProjectSnapshot(result.workingCards, DEFAULT_PROJECT_SETTINGS)).cards).toEqual(result.workingCards);
  });

  it("keeps valid siblings when one imported decklist entry is unresolved", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, fake.client);
    const form = new FormData();
    form.set("text", "1 Island\n1 Not A Real Card Name 98341\n1 Lightning Bolt");

    const result = await runAddCardsFlow(form, new AbortController().signal, cardApiFetcher(workbench));

    expect(result.workingCards.map((card) => card.identity?.name ?? card.identityHints.name)).toEqual([
      "Island", "Not A Real Card Name 98341", "Lightning Bolt",
    ]);
    expect(result.workingCards.map((card) => card.identityResolution.status)).toEqual(["resolved", "unresolved", "resolved"]);
  });

  it("keeps decklist cards when a sibling file has a real importer ambiguity", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, fake.client);
    const form = new FormData();
    form.set("text", "1 Island\n1 Lightning Bolt");
    const ambiguousFile = "name, set\tquantity\nA, ABC\t1\nB, XYZ\t2\n";
    form.append("files", new File([ambiguousFile], "mixed.csv"));
    form.set("filePaths", JSON.stringify([""]));

    const result = await runAddCardsFlow(form, new AbortController().signal, cardApiFetcher(workbench));

    expect(result.workingCards.map((card) => card.identity?.name)).toEqual(["Island", "Lightning Bolt"]);
    expect(result.report.summary.ambiguousDetections).toBe(1);
    expect(result.report.errors).toEqual([]);
  });

  it("keeps valid siblings when Scryfall fails for one entry and reports provider degradation", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    fake.lookupByName.mockImplementation(async (name) => {
      if (name === "Sol Ring") throw new ScryfallError("network", "Scryfall network unavailable");
      const card = resolvedDeckPrintings.find((item) => item.name === name);
      if (!card) throw Object.assign(new Error("not found"), { kind: "not-found" });
      return card;
    });
    const { workbench } = await setup(undefined, fake.client);
    const form = new FormData();
    form.set("text", "1 Island\n1 Sol Ring\n1 Lightning Bolt");

    const result = await runAddCardsFlow(form, new AbortController().signal, cardApiFetcher(workbench));

    expect(result.workingCards.map((card) => card.identity?.name ?? card.identityHints.name)).toEqual(["Island", "Sol Ring", "Lightning Bolt"]);
    expect(result.workingCards.map((card) => card.identityResolution.status)).toEqual(["resolved", "unresolved", "resolved"]);
    expect(result.providerHealth.scryfall).toMatchObject({ degraded: true });
  });

  it.each(["Island.png", "1x Sol Ring [MPC].png"])("does not call Scryfall during one-click addition of custom %s", async (filename) => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, fake.client);
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const form = new FormData();
    form.append("files", new File([bytes], filename, { type: "image/png" }));
    form.set("filePaths", JSON.stringify([""]));

    const result = await runAddCardsFlow(form, new AbortController().signal, cardApiFetcher(workbench));

    expect(result.workingCards[0]).toMatchObject({ identity: null, identityResolution: { status: "custom", confirmed: true } });
    expect(result.workingCards[0]?.selectedArtworkByFace.front).toMatchObject({ source: "upload" });
    expect(fake.lookupById).not.toHaveBeenCalled();
    expect(fake.lookupBySetCollector).not.toHaveBeenCalled();
    expect(fake.lookupByName).not.toHaveBeenCalled();
    expect(fake.searchCards).not.toHaveBeenCalled();
  });

  it("keys identity resolution by semantic hints rather than upload filenames or artwork IDs", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "Mainboard\n1 Sol Ring\nSideboard\n1 Sol Ring" });
    const cards = imported.workingCards.map((card, index) => ({
      ...card,
      importSource: { ...card.importSource, filename: `display-${index}.png` },
      localArtworkIds: [`upload:${String(index + 1).repeat(64)}`],
    }));

    const resolved = await workbench.resolveWorkingCards(cards);

    expect(resolved.workingCards.map((card) => card.identity?.name)).toEqual(["Sol Ring", "Sol Ring"]);
    expect(fake.lookupByName).toHaveBeenCalledTimes(1);
  });

  it("imports a Scryfall card URL through the Working Set route without calling an artwork provider", async () => {
    const fetchImpl = vi.fn(async () => new Response("unexpected network request", { status: 500 }));
    const { workbench } = await setup(fetchImpl as typeof fetch);
    const form = new FormData();
    form.set("text", "https://scryfall.com/card/m21/265/island");

    const response = await handleCardImport(new Request("http://localhost/api/cards/import", { method: "POST", body: form }), workbench);
    expect(response.status).toBe(200);
    const imported = await response.json() as WorkingSetImportResult;

    expect(imported.workingCards[0]).toMatchObject({ quantity: 1, identityHints: { setCode: "m21", collectorNumber: "265" } });
    expect(imported.report.sources[0]).toMatchObject({ kind: "url", adapterId: "scryfall", sourceUrl: "https://scryfall.com/card/m21/265/island" });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it.each([
    ["Island.png", "Island"],
    ["1x Sol Ring [MPC].png", "Sol Ring"],
  ])("keeps custom image %s printable without making Scryfall requests from its filename or pixels", async (filename) => {
    const pixelsWithText = new Uint8Array(await sharp(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="336"><rect width="100%" height="100%" fill="white"/><text x="24" y="170" font-size="36">ISLAND</text></svg>',
    )).png().toBuffer());
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ files: [{ filename, bytes: pixelsWithText }] });
    const result = await workbench.resolveWorkingCards(imported.workingCards);
    const card = result.workingCards[0]!;

    expect(card).toMatchObject({ identity: null, identityResolution: { status: "custom", confirmed: true } });
    expect(card.identityHints).toEqual({});
    expect(card.selectedArtworkByFace.front).toMatchObject({ source: "upload" });
    expect(fake.lookupById).not.toHaveBeenCalled();
    expect(fake.lookupBySetCollector).not.toHaveBeenCalled();
    expect(fake.lookupByName).not.toHaveBeenCalled();
    expect(fake.searchCards).not.toHaveBeenCalled();
    await expect(workbench.getArtworkOriginal(card.selectedArtworkByFace.front!.candidateId)).resolves.toMatchObject({ bytes: pixelsWithText });
    await expect(workbench.reresolveWorkingCard(card)).resolves.toMatchObject({ identity: null, identityResolution: { status: "custom", confirmed: true } });
    expect(fake.lookupById).not.toHaveBeenCalled();
    expect(fake.lookupBySetCollector).not.toHaveBeenCalled();
    expect(fake.lookupByName).not.toHaveBeenCalled();
    expect(fake.searchCards).not.toHaveBeenCalled();
  });

  it("exports a custom upload PDF from the validated original with the standard A4 page dimensions", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, fake.client);
    const originalBytes = new Uint8Array(await sharp({ create: { width: 300, height: 420, channels: 3, background: "#397" } }).png().toBuffer());
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "Island.png", bytes: originalBytes }] });
    const resolved = await workbench.resolveWorkingCards(imported.workingCards);
    const custom = resolved.workingCards[0]!;
    const selectionId = custom.selectedArtworkByFace.front!.candidateId;
    const original = await workbench.getArtworkOriginal(selectionId);
    const getOriginal = vi.spyOn(workbench, "getArtworkOriginal");
    const response = await handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: [custom], options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES } }),
    }), workbench);

    expect(custom).toMatchObject({ identity: null, identityResolution: { status: "custom" }, selectedArtworkByFace: { front: { source: "upload", candidateId: selectionId } } });
    expect(original.bytes).toEqual(originalBytes);
    expect(original.widthPx).toBe(300);
    expect(original.heightPx).toBe(420);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(getOriginal.mock.calls.some(([candidateId]) => candidateId === selectionId)).toBe(true);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.28, 1);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(841.89, 1);
    expect(fake.lookupByName).not.toHaveBeenCalled();
    expect(fake.searchCards).not.toHaveBeenCalled();
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

  it("re-resolves a confirmed card from its own hints while preserving user artwork and entry metadata", async () => {
    const fake = fakeScryfallClient([resolvedDeckPrintings[0], resolvedDeckPrintings[3]]);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "3 Sol Ring" });
    const automaticallyResolved = (await workbench.resolveWorkingCards(imported.workingCards)).workingCards[0];
    const userArtwork = {
      ...automaticallyResolved.selectedArtworkByFace.front!,
      identityId: "scryfall:oracle:previous-manual-choice",
      selectionPolicy: "user-selected",
    };
    const confirmed = await workbench.confirmWorkingCardIdentity({
      ...automaticallyResolved,
      selectedArtworkByFace: { front: userArtwork },
    }, resolvedDeckPrintings[3].id);
    const requestsBeforeReresolve = fake.lookupByName.mock.calls.length;
    const reResolve = (workbench as unknown as { reresolveWorkingCard?: (card: typeof confirmed) => Promise<typeof confirmed> }).reresolveWorkingCard;

    expect(reResolve).toBeTypeOf("function");
    const reResolved = await reResolve!.call(workbench, confirmed);

    expect(reResolved).toMatchObject({
      id: imported.workingCards[0].id,
      quantity: 3,
      order: imported.workingCards[0].order,
      importSource: imported.workingCards[0].importSource,
      identityHints: imported.workingCards[0].identityHints,
      identity: { name: "Sol Ring" },
      identityResolution: { status: "resolved", confirmed: false },
      selectedArtworkByFace: { front: userArtwork },
      localArtworkIds: imported.workingCards[0].localArtworkIds,
      mpcReferences: imported.workingCards[0].mpcReferences,
      faceAssociations: imported.workingCards[0].faceAssociations,
    });
    expect(fake.lookupByName).toHaveBeenCalledTimes(requestsBeforeReresolve);
  });

  it("replaces an incompatible automatic artwork when a manual identity changes", async () => {
    const fake = fakeScryfallClient([resolvedDeckPrintings[0], resolvedDeckPrintings[3]]);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "3 Sol Ring" });
    const automaticallyResolved = (await workbench.resolveWorkingCards(imported.workingCards)).workingCards[0];
    const oldArtwork = automaticallyResolved.selectedArtworkByFace.front;

    const confirmed = await workbench.confirmWorkingCardIdentity(automaticallyResolved, resolvedDeckPrintings[3].id);

    expect(confirmed).toMatchObject({
      id: automaticallyResolved.id,
      quantity: automaticallyResolved.quantity,
      order: automaticallyResolved.order,
      importSource: automaticallyResolved.importSource,
      identityHints: automaticallyResolved.identityHints,
      identity: { name: "Island" },
      identityResolution: { status: "resolved", method: "manual", confirmed: true },
      selectedArtworkByFace: {
        front: {
          candidateId: `scryfall:${resolvedDeckPrintings[3].id}:front`,
          identityId: confirmed.identity?.id,
          selectionPolicy: "newest-en-highres-nondigital-v1",
        },
      },
    });
    expect(confirmed.selectedArtworkByFace.front?.candidateId).not.toBe(oldArtwork?.candidateId);
  });

  it("confirms a manual identity without changing the entry or its imported asset references", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const { workbench } = await setup(undefined, fake.client);
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "local.png", bytes }] });
    const source = imported.workingCards[0];
    const before = {
      ...source,
      quantity: 4,
      order: 2,
      mpcReferences: [{ faceId: "back" as const, importedAssetId: "mpc:reference", selectedArtworkId: "imported-back", slots: ["B1"], availableLocally: false }],
      faceAssociations: [{ slot: "paired", frontAssetId: source.localArtworkIds[0], backAssetId: "mpc:imported-back", confidence: 0.8, accepted: false }],
    };

    const confirmed = await workbench.confirmWorkingCardIdentity(before, resolvedDeckPrintings[0].id);

    expect(confirmed).toMatchObject({
      id: before.id,
      quantity: 4,
      order: 2,
      importSource: before.importSource,
      identityHints: before.identityHints,
      localArtworkIds: before.localArtworkIds,
      mpcReferences: before.mpcReferences,
      faceAssociations: before.faceAssociations,
      identity: { name: "Sol Ring" },
      identityResolution: { status: "resolved", method: "manual", confirmed: true },
      selectedArtworkByFace: { front: { candidateId: before.localArtworkIds[0], source: "upload" } },
    });
    expect(confirmed.selectedArtworkByFace.front?.identityId).toBe(confirmed.identity?.id);
    expect(before.identity).toBeNull();
    expect(before.selectedArtworkByFace.front?.identityId).toBeNull();
  });

  it("keeps a confirmed card unchanged when re-resolution hits a real provider failure", async () => {
    const fake = fakeScryfallClient([]);
    fake.lookupByName.mockRejectedValue(new Error("Scryfall network unavailable"));
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const identityId = "scryfall:oracle:previous-island";
    const previous = {
      ...imported.workingCards[0],
      identity: { id: identityId, provider: "scryfall", name: "Island", scryfallId: "12121212-1212-4121-8121-121212121212", resolutionMethod: "manual" as const, confidence: 1 },
      identityResolution: { status: "resolved" as const, method: "manual" as const, query: "Island", confidence: 1, confirmed: true, candidates: [] },
      selectedArtworkByFace: { front: { candidateId: "mpc:explicit-choice", source: "mpc" as const, identityId, faceId: "front" as const, selectionPolicy: "user-selected" } },
    };
    const before = structuredClone(previous);

    await expect(workbench.reresolveWorkingCard(previous)).rejects.toThrow("Scryfall network unavailable");

    expect(previous).toEqual(before);
  });

  it("accepts only verified MPC cardbacks as a simple card's locked physical back", async () => {
    const identityCard = resolvedDeckPrintings[0]!;
    const nextIdentity = resolvedDeckPrintings[1]!;
    const fake = fakeScryfallClient([identityCard, nextIdentity]);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0], identityCard.id);
    const [scryfallFront] = await workbench.listArtworkCandidates(identified.identity!.id, "front", "scryfall");
    if (!scryfallFront) throw new Error("Expected a Scryfall front artwork candidate.");
    expect(() => workbench.selectManualBackArtwork(identified, scryfallFront)).toThrow(/verified MPC cardback/);
    const mpcCard = {
      id: mpcArtworkCandidateId("provider-manual-card", "back"), source: "mpc" as const, identityId: identified.identity!.id,
      faceId: "back", providerAssetId: "provider-manual-card", originalAvailable: false, metadata: { cardType: "CARD" },
    };
    expect(() => workbench.selectManualBackArtwork(identified, mpcCard)).toThrow(/verified MPC cardback/);
    const mpcCandidate = {
      id: mpcArtworkCandidateId("provider-manual-back", "back"), source: "mpc" as const, identityId: identified.identity!.id,
      faceId: "back", providerAssetId: "provider-manual-back", selectedArtworkId: "selected-manual-back", originalAvailable: false,
      metadata: { cardType: "CARDBACK" },
    };
    const mpcBack = workbench.selectManualBackArtwork(identified, mpcCandidate);
    const frontChanged = workbench.selectArtwork(mpcBack, "front", scryfallFront);
    const identityChanged = await workbench.confirmWorkingCardIdentity(frontChanged, nextIdentity.id);
    const uploadBytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const uploaded = await workbench.importForWorkingSet({ files: [{ filename: "manual-back.png", bytes: uploadBytes }] });
    const uploadCandidate = await workbench.getArtworkCandidate(uploaded.workingCards[0]!.localArtworkIds[0]!);
    if (!uploadCandidate) throw new Error("Expected a validated local artwork candidate.");

    expect(isDoubleFacedIdentity(identityChanged.identity)).toBe(false);
    expect(identityChanged.faces).toMatchObject([{ id: "front", side: "front" }]);
    expect(identityChanged.faces).toHaveLength(1);
    expect(identityChanged.manualBackArtwork).toEqual(mpcBack.manualBackArtwork);
    expect(identityChanged.backModeSelectionPolicy).toBe("explicit");
    expect(mpcBack.manualBackArtwork).toMatchObject({ source: "mpc", faceId: "back", providerAssetId: "provider-manual-back", selectedArtworkId: "selected-manual-back", selectionPolicy: "user-selected" });
    expect(mpcBack.faces).toHaveLength(1);
    expect(mpcBack.mpcReferences).toContainEqual(expect.objectContaining({ faceId: "back", importedAssetId: "provider-manual-back", providerAssetId: "provider-manual-back", selectedArtworkId: "selected-manual-back", providerCardType: "CARDBACK", referenceOrigin: "gallery-selection" }));
    expect(() => workbench.selectManualBackArtwork(identified, uploadCandidate)).toThrow(/verified MPC cardback/);
    expect(() => workbench.selectArtwork(identified, "back", { ...uploadCandidate, faceId: "back" })).toThrow(BackSelectionPolicyError);
    await expect(workbench.listArtworkCandidates(identified.identity!.id, "back", "upload")).resolves.toEqual([]);
    expect(frontChanged.manualBackArtwork).toEqual(mpcBack.manualBackArtwork);
    expect(identityChanged.manualBackArtwork).toEqual(mpcBack.manualBackArtwork);
  });

  it("drops a custom Back face when confirming a simple identity while retaining its uploaded original", async () => {
    const identityCard = resolvedDeckPrintings[0]!;
    const fake = fakeScryfallClient([identityCard]);
    const { workbench } = await setup(undefined, fake.client);
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "custom-two-face.png", bytes }] });
    const importedCard = imported.workingCards[0]!;
    const assetId = importedCard.localArtworkIds[0]!;
    const upload = await workbench.getArtworkCandidate(assetId);
    if (!upload) throw new Error("Expected a validated local artwork candidate.");
    const customTwoFace = {
      ...importedCard,
      faces: [
        { id: "front", side: "front" as const, importedAssetId: assetId },
        { id: "back", side: "back" as const, importedAssetId: assetId },
      ],
    };
    const customBack = workbench.selectArtwork(customTwoFace, "back", { ...upload, faceId: "back" });
    const confirmed = await workbench.confirmWorkingCardIdentity(customBack, identityCard.id);
    const original = await workbench.getArtworkOriginal(assetId);

    expect(confirmed.identity).toMatchObject({ name: "Sol Ring" });
    expect(confirmed.faces).toEqual([{ id: "front", side: "front", importedAssetId: assetId }]);
    expect(confirmed.selectedArtworkByFace.back).toBeUndefined();
    expect(confirmed.selectedArtworkByFace.front).toMatchObject({ source: "upload", candidateId: assetId, identityId: confirmed.identity?.id });
    expect(confirmed).toMatchObject({ backMode: "project-default", backModeSelectionPolicy: "automatic", localArtworkIds: [assetId] });
    expect(confirmed.manualBackAsset).toBeUndefined();
    expect(confirmed.manualBackArtwork).toBeUndefined();
    expect(original.bytes).toEqual(bytes);
  });

  it("rejects restoring a simple identity Back before searching Scryfall", async () => {
    const identityCard = resolvedDeckPrintings[0]!;
    const fake = fakeScryfallClient([identityCard]);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0]!, identityCard.id);
    const simpleWithForgedBack = {
      ...identified,
      faces: [...identified.faces, { id: "back", side: "back" as const, name: "Forged face" }],
    };
    const search = vi.spyOn(ArtworkCatalog.prototype, "search");

    try {
      await expect(workbench.restoreDefaultArtwork(simpleWithForgedBack, "back")).rejects.toBeInstanceOf(BackSelectionPolicyError);
      expect(search).not.toHaveBeenCalled();
    } finally {
      search.mockRestore();
    }
  });

  it("lists cardbacks through the dedicated MPC route and persists the verified CARDBACK reference", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings);
    const providerId = "synthetic-cardback-id";
    const backBytes = new Uint8Array(await sharp({ create: { width: 40, height: 56, channels: 3, background: "#254" } }).png().toBuffer());
    const mpcFetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/sources/") return Response.json({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.pathname === "/2/cardbacks/") return Response.json({ cardbacks: [providerId] });
      if (url.pathname === "/2/cards/") return Response.json({ results: { [providerId]: {
        identifier: providerId, cardType: "CARDBACK", name: "Synthetic Cardback", sourceId: 41, sourceType: "Google Drive", extension: "png", size: backBytes.byteLength, dpi: 1200,
      } } });
      if (url.hostname === "drive.google.com" && url.pathname === "/uc") return new Response(backBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(backBytes.byteLength) } });
      throw new Error(`Unexpected MPC request: ${url.pathname}`);
    };
    const { workbench } = await setup(undefined, fake.client, mpcFetchImpl);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const identified = (await workbench.resolveWorkingCards(imported.workingCards)).workingCards[0]!;
    const [candidate] = await workbench.listMpcCardbackCandidates();
    if (!candidate) throw new Error("Expected one hydrated CARDBACK candidate.");

    const selected = workbench.selectManualBackArtwork(identified, candidate);

    expect(candidate).toMatchObject({ source: "mpc", identityId: null, faceId: "back", metadata: { cardType: "CARDBACK" } });
    expect(selected.manualBackArtwork).toMatchObject({ source: "mpc", faceId: "back", providerAssetId: providerId, selectionPolicy: "user-selected" });
    expect(selected.mpcReferences).toContainEqual(expect.objectContaining({ importedAssetId: providerId, providerCardType: "CARDBACK", referenceOrigin: "gallery-selection" }));
    const response = await handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: [selected], options: { exportContentMode: "back-only", missingBackPolicy: "block", bleedMm: 0, cutGuides: NO_CUT_GUIDES } }),
    }), workbench);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(await PDFDocument.load(await response.arrayBuffer()).then((pdf) => pdf.getPageCount())).toBe(1);
  });

  it("keeps DFC face selections independent across Scryfall, MPC, and upload and applies face-local filters", async () => {
    const identityCard = mapScryfallCard(delverCard);
    const fake = fakeScryfallClient([identityCard]);
    const root = await mkdtemp(join(tmpdir(), "tcgprint-mpc-dfc-faces-"));
    roots.push(root);
    const assetIds = { front: "synthetic-dfc-front-123456", back: "synthetic-dfc-back-123456" };
    const mpcFetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/sources/") return Response.json({ results: { "41": { pk: 41, sourceType: "Google Drive", name: "Synthetic source" } } });
      if (url.pathname === "/3/editorSearch/") return new Response("route missing", { status: 404 });
      if (url.pathname === "/2/editorSearch/") {
        const body = JSON.parse(String(init.body)) as { queries: Array<{ query: string; cardType: string }> };
        const side = body.queries[0]!.query.toLocaleLowerCase().includes("insectile") ? "back" : "front";
        return Response.json({ results: { [body.queries[0]!.query]: { CARD: [assetIds[side]] } } });
      }
      if (url.pathname === "/2/cards/") {
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        return Response.json({ results: Object.fromEntries(body.cardIdentifiers.map((id) => {
          const side = id === assetIds.back ? "back" : "front";
          return [id, {
            identifier: id, cardType: "CARD", name: side === "front" ? "Synthetic DFC Front" : "Synthetic DFC Back",
            sourceId: 41, sourceType: "Google Drive", extension: "png", size: 1000, dpi: side === "front" ? 300 : 600,
          }];
        })) });
      }
      throw new Error(`Unexpected MPC route: ${url.pathname}`);
    };
    const workbench = await createCardWorkbench({ dataDirectory: root, scryfallClient: fake.client, mpcFetchImpl, minIntervalMs: 0 });
    workbenches.push(workbench);
    const imported = await workbench.importForWorkingSet({ text: "1 Delver of Secrets" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0]!, identityCard.id);
    const identityId = identified.identity!.id;
    const scryfallFront: ArtworkCandidate = { id: `scryfall:${identityCard.id}:front`, source: "scryfall", identityId, faceId: "front", originalAvailable: true };
    const mpcFront: ArtworkCandidate = { id: mpcArtworkCandidateId(assetIds.front, "front"), source: "mpc", identityId, faceId: "front", providerAssetId: assetIds.front, selectedArtworkId: assetIds.front, originalAvailable: true };
    const mpcBack: ArtworkCandidate = { id: mpcArtworkCandidateId(assetIds.back, "back"), source: "mpc", identityId, faceId: "back", providerAssetId: assetIds.back, selectedArtworkId: assetIds.back, originalAvailable: true };
    const uploadBytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const uploadImport = await workbench.importForWorkingSet({ files: [{ filename: "dfc-back.png", bytes: uploadBytes }] });
    const uploadSource = await workbench.getArtworkCandidate(uploadImport.workingCards[0]!.localArtworkIds[0]!);
    if (!uploadSource) throw new Error("Expected a validated upload candidate.");
    const uploadBack: ArtworkCandidate = { ...uploadSource, faceId: "back", identityId };

    const scryfallFrontMpcBack = workbench.selectArtwork(workbench.selectArtwork(identified, "front", scryfallFront), "back", mpcBack);
    const mpcFrontUploadBack = workbench.selectArtwork(workbench.selectArtwork(identified, "front", mpcFront), "back", uploadBack);
    const mpcFrontMpcBack = workbench.selectArtwork(workbench.selectArtwork(identified, "front", mpcFront), "back", mpcBack);
    expect([scryfallFrontMpcBack.selectedArtworkByFace.front?.source, scryfallFrontMpcBack.selectedArtworkByFace.back?.source]).toEqual(["scryfall", "mpc"]);
    expect([mpcFrontUploadBack.selectedArtworkByFace.front?.source, mpcFrontUploadBack.selectedArtworkByFace.back?.source]).toEqual(["mpc", "upload"]);
    expect([mpcFrontMpcBack.selectedArtworkByFace.front?.source, mpcFrontMpcBack.selectedArtworkByFace.back?.source]).toEqual(["mpc", "mpc"]);

    const beforeFilters = structuredClone(mpcFrontMpcBack.selectedArtworkByFace);
    await expect(workbench.listArtworkCandidates(identityId, "front", "mpc", { mpcFilters: { minimumDpi: 500 } })).resolves.toEqual([]);
    await expect(workbench.listArtworkCandidates(identityId, "back", "mpc", { mpcFilters: { minimumDpi: 500 } })).resolves.toMatchObject([{ faceId: "back", metadata: { dpi: 600 } }]);
    await expect(workbench.listArtworkCandidates(identityId, "front", "mpc", { mpcFilters: { minimumDpi: 100 } })).resolves.toMatchObject([{ faceId: "front", metadata: { dpi: 300 } }]);
    await expect(workbench.listArtworkCandidates(identityId, "back", "mpc", { mpcFilters: { maximumDpi: 500 } })).resolves.toEqual([]);
    expect(mpcFrontMpcBack.selectedArtworkByFace).toEqual(beforeFilters);
  });

  it("restores default artwork independently on each DFC face without replacing the opposite face", async () => {
    const identityCard = mapScryfallCard(delverCard);
    const fake = fakeScryfallClient([identityCard]);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Delver of Secrets" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0], identityCard.id);
    const [frontCandidate] = await workbench.listArtworkCandidates(identified.identity!.id, "front", "scryfall");
    const [backCandidate] = await workbench.listArtworkCandidates(identified.identity!.id, "back", "scryfall");
    const frontSelected = workbench.selectArtwork(identified, "front", frontCandidate);
    const bothSelected = workbench.selectArtwork(frontSelected, "back", backCandidate);
    const lookupsBeforeReset = fake.lookupById.mock.calls.length;
    const printingsBeforeReset = fake.listPrintings.mock.calls.length;

    expect(bothSelected.selectedArtworkByFace.front?.selectionPolicy).toBe("user-selected");
    expect(bothSelected.selectedArtworkByFace.back?.selectionPolicy).toBe("user-selected");
    expect(bothSelected.backMode).toBe("manual");
    expect(bothSelected.backModeSelectionPolicy).toBe("explicit");

    const frontReset = await workbench.restoreDefaultArtwork(bothSelected, "front");
    const backReset = frontReset && await workbench.restoreDefaultArtwork(frontReset, "back");

    expect(frontReset).toMatchObject({
      id: identified.id,
      quantity: identified.quantity,
      order: identified.order,
      selectedArtworkByFace: {
        front: { candidateId: frontCandidate.id, selectionPolicy: "newest-en-highres-nondigital-v1" },
        back: bothSelected.selectedArtworkByFace.back,
      },
    });
    expect(backReset?.selectedArtworkByFace).toMatchObject({
      front: frontReset?.selectedArtworkByFace.front,
      back: { candidateId: backCandidate.id, selectionPolicy: "newest-en-highres-nondigital-v1" },
    });
    expect(backReset).toMatchObject({ backMode: "auto", backModeSelectionPolicy: "automatic" });
    expect(fake.lookupById).toHaveBeenCalledTimes(lookupsBeforeReset);
    expect(fake.listPrintings).toHaveBeenCalledTimes(printingsBeforeReset);
  });

  it("scopes a DFC default-artwork search to the requested face and retains its paired printing", async () => {
    const identityCard = mapScryfallCard(delverCard);
    const fake = fakeScryfallClient([identityCard]);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Delver of Secrets" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0], identityCard.id);
    const searchSpy = vi.spyOn(ArtworkCatalog.prototype, "search");

    try {
      const restored = await workbench.restoreDefaultArtwork(identified, "back");
      const searchOptions = searchSpy.mock.calls[0]?.[1];

      expect(searchSpy).toHaveBeenCalledOnce();
      expect(searchOptions).toMatchObject({ source: "scryfall", faceId: "back" });
      expect(restored?.selectedArtworkByFace.back?.providerAssetId).toBe(identified.selectedArtworkByFace.front?.providerAssetId);
      expect(fake.downloadAsset).not.toHaveBeenCalled();
    } finally {
      searchSpy.mockRestore();
    }
  });

  it("restores the newest eligible printing for a manually confirmed identity", async () => {
    const olderPrinting = resolvedCard("Sol Ring", "90909090-9090-4909-8909-909090909090", "20202020-2020-4202-8202-202020202020", "old", "1");
    const newerPrinting = { ...olderPrinting, id: "91919191-9191-4919-8919-919191919191", setCode: "new", collectorNumber: "2", releasedAt: "2025-01-01" };
    const fake = fakeScryfallClient([olderPrinting]);
    fake.listPrintings.mockResolvedValue([olderPrinting, newerPrinting]);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const confirmed = await workbench.confirmWorkingCardIdentity(imported.workingCards[0], olderPrinting.id);
    const candidates = await workbench.listArtworkCandidates(confirmed.identity!.id, "front", "scryfall");
    const olderSelection = workbench.selectArtwork(confirmed, "front", candidates.find((candidate) => candidate.scryfallId === olderPrinting.id)!);

    expect(confirmed.identityResolution.method).toBe("manual");
    expect(olderSelection.selectedArtworkByFace.front?.selectionPolicy).toBe("user-selected");

    const restored = await workbench.restoreDefaultArtwork(olderSelection, "front");

    expect(restored?.selectedArtworkByFace.front).toMatchObject({
      candidateId: `scryfall:${newerPrinting.id}:front`,
      selectionPolicy: "newest-en-highres-nondigital-v1",
    });
    expect(fake.listPrintings).toHaveBeenCalledOnce();
    expect(fake.downloadAsset).not.toHaveBeenCalled();
  });

  it("reports provider failure separately from an unavailable default and preserves the selected artwork", async () => {
    const identityCard = resolvedDeckPrintings[0];
    const fake = fakeScryfallClient([identityCard]);
    fake.listPrintings.mockRejectedValue(new Error("Scryfall network unavailable"));
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const confirmed = await workbench.confirmWorkingCardIdentity(imported.workingCards[0], identityCard.id);
    const before = {
      ...confirmed,
      selectedArtworkByFace: {
        front: { candidateId: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front", source: "scryfall" as const, identityId: confirmed.identity!.id, faceId: "front" as const, selectionPolicy: "user-selected" },
      },
    };
    const snapshot = structuredClone(before);

    await expect(workbench.restoreDefaultArtwork(before, "front")).rejects.toMatchObject({
      kind: "network",
      message: "Scryfall network unavailable",
    });

    expect(before).toEqual(snapshot);
    expect(workbench.getProviderHealth().scryfall).toMatchObject({ available: false, degraded: true });
  });

  it("reports provider failure when degraded cached candidates cover only the opposite DFC face", async () => {
    const identityCard = mapScryfallCard(delverCard);
    const fake = fakeScryfallClient([identityCard]);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Delver of Secrets" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0], identityCard.id);
    const [frontCandidate] = await workbench.listArtworkCandidates(identified.identity!.id, "front", "scryfall");
    const [backCandidate] = await workbench.listArtworkCandidates(identified.identity!.id, "back", "scryfall");
    if (!frontCandidate || !backCandidate) throw new Error("Expected both DFC face candidates in the fixture.");
    const before = workbench.selectArtwork(identified, "back", backCandidate);
    const snapshot = structuredClone(before);
    const searchSpy = vi.spyOn(ArtworkCatalog.prototype, "search").mockResolvedValue([frontCandidate]);
    const healthSpy = vi.spyOn(ArtworkCatalog.prototype, "getProviderHealth").mockReturnValue({
      scryfall: { available: true, degraded: true, message: "Scryfall network unavailable" },
    });

    try {
      await expect(workbench.restoreDefaultArtwork(before, "back")).rejects.toMatchObject({
        kind: "network",
        message: "Scryfall network unavailable",
      });
      expect(before).toEqual(snapshot);
    } finally {
      searchSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });

  it("resolves four deck entries without listing printings or expanding quantities", async () => {
    const fake = fakeScryfallClient(resolvedDeckPrintings, 300);
    const { workbench } = await setup(undefined, fake.client);
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
    const { workbench } = await setup(undefined, fake.client);
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
    const { workbench } = await setup(undefined, fake.client);
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

  it("switches the same resolved working card from Scryfall to MPC to upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcgprint-artwork-switch-"));
    roots.push(root);
    const scryfall = fakeScryfallClient(resolvedDeckPrintings);
    const mpcFetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return Response.json({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) return new Response("route missing", { status: 404 });
      if (url.endsWith("/2/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Array<{ query: string; cardType: string }> };
        expect(body.queries).toEqual([{ query: "Sol Ring", cardType: "CARD" }]);
        return Response.json({ results: { "Sol Ring": { CARD: ["switch-test-drive-id-123456"] } } });
      }
      if (url.endsWith("/2/cards/")) return Response.json({ results: {
        "switch-test-drive-id-123456": {
          identifier: "switch-test-drive-id-123456", cardType: "CARD", name: "Sol Ring",
          sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 300,
          smallThumbnailUrl: "https://drive.google.com/thumbnail?id=switch-test-drive-id-123456",
        },
      } });
      throw new Error(`Unexpected fake MPC request: ${url}`);
    };
    const workbench = await createCardWorkbench({
      dataDirectory: root,
      scryfallClient: scryfall.client,
      mpcFetchImpl,
      minIntervalMs: 0,
    });
    workbenches.push(workbench);
    const uploadBytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    await workbench.importForWorkingSet({ files: [{ filename: "local.png", bytes: uploadBytes }] });
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "local.png", bytes: uploadBytes }] });
    const originalCard = await workbench.confirmWorkingCardIdentity(imported.workingCards[0], resolvedDeckPrintings[0].id);
    const identityId = originalCard.identity!.id;
    const workingCardId = originalCard.id;

    const scryfallCandidate = (await workbench.listArtworkCandidates(identityId, "front", "scryfall"))[0];
    const scryfallSelected = workbench.selectArtwork(originalCard, "front", scryfallCandidate);
    const mpcCandidate = (await workbench.listArtworkCandidates(identityId, "front", "mpc"))[0];
    const mpcSelected = workbench.selectArtwork(scryfallSelected, "front", mpcCandidate);
    const uploadCandidate = (await workbench.listArtworkCandidates(identityId, "front", "upload"))[0];
    const uploadSelected = workbench.selectArtwork(mpcSelected, "front", uploadCandidate);

    expect([scryfallSelected.selectedArtworkByFace.front?.source, mpcSelected.selectedArtworkByFace.front?.source, uploadSelected.selectedArtworkByFace.front?.source]).toEqual(["scryfall", "mpc", "upload"]);
    for (const card of [scryfallSelected, mpcSelected, uploadSelected]) {
      expect(card.id).toBe(workingCardId);
      expect(card.identity?.id).toBe(identityId);
    }
    expect(uploadSelected.identity).toBe(originalCard.identity);
  });

  it("keeps direct custom uploads offline and does not call Scryfall for MPC references", async () => {
    const failingFetch = vi.fn(async () => new Response("offline", { status: 503 })) as typeof fetch;
    const { workbench } = await setup(failingFetch);
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const upload = await workbench.importForWorkingSet({ files: [{ filename: "custom.png", bytes }] });
    expect(await workbench.getArtworkPreview(upload.workingCards[0].localArtworkIds[0])).toMatchObject({ source: "upload" });
    await expect(workbench.resolveWorkingCards(upload.workingCards)).resolves.toMatchObject({ providerHealth: { scryfall: { degraded: false } } });
    expect(failingFetch).not.toHaveBeenCalled();

    const xml = new TextEncoder().encode("<order><details><quantity>1</quantity></details><fronts><card><id>art-front-9</id><slots>1</slots><name>Custom</name></card></fronts></order>");
    const mpc = await workbench.importForWorkingSet({ files: [{ filename: "order.xml", bytes: xml }] });
    expect(mpc.workingCards[0].selectedArtworkByFace.front).toMatchObject({ source: "mpc", selectedArtworkId: "art-front-9" });
    expect(mpc.workingCards[0].mpcReferences[0].selectedArtworkId).toBe("art-front-9");
    expect(failingFetch).not.toHaveBeenCalled();
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

  it("hydrates and exports an XML-selected MPC original without opening the artwork gallery", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcgprint-mpc-xml-export-"));
    roots.push(root);
    const originalBytes = new Uint8Array(await sharp({ create: { width: 300, height: 420, channels: 3, background: "#476" } }).png().toBuffer());
    const requests: string[] = [];
    const mpcFetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/2/sources/")) return Response.json({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/2/cards/")) return Response.json({ results: {
        "synthetic-front-art-a": {
          identifier: "synthetic-front-art-a", cardType: "CARD", name: "Example Front", sourceId: 41, sourceType: "Google Drive",
          extension: "png", size: originalBytes.byteLength, dpi: 300,
        },
      } });
      if (url.startsWith("https://drive.google.com/uc?")) return new Response(originalBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(originalBytes.byteLength) } });
      throw new Error(`Unexpected fake MPC request: ${url}`);
    };
    const noScryfallNetwork = vi.fn(async () => { throw new Error("Scryfall must not be used for an MPC selection."); }) as typeof fetch;
    const options = {
      dataDirectory: root,
      fetchImpl: noScryfallNetwork,
      mpcFetchImpl,
      minIntervalMs: 0,
    } as CardWorkbenchOptions;
    const workbench = await createCardWorkbench(options);
    workbenches.push(workbench);
    const xml = new Uint8Array(await readFile(new URL("../fixtures/import-engine/mpc-order-synthetic.xml", import.meta.url)));
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "mpc-order-synthetic.xml", bytes: xml }] });
    const selectedId = imported.workingCards[0].selectedArtworkByFace.front?.candidateId;
    const workingCardId = imported.workingCards[0].id;

    const response = await handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: imported.workingCards.slice(0, 1), options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES } }),
    }), workbench);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(imported.workingCards[0].id).toBe(workingCardId);
    expect(imported.workingCards[0].selectedArtworkByFace.front).toMatchObject({ candidateId: selectedId, selectedArtworkId: "synthetic-front-art-a" });
    expect(imported.workingCards[0].mpcReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerAssetId: "synthetic-front-art-a", selectedArtworkId: "synthetic-front-art-a", slots: ["2", "1"] }),
    ]));
    expect(requests.map((url) => new URL(url).pathname)).toEqual(["/2/sources/", "/2/cards/", "/uc"]);
    expect(noScryfallNetwork).not.toHaveBeenCalled();

    await workbench.close();
    const offlineMpcFetch = vi.fn(async () => { throw new Error("offline MPC cache should be sufficient"); }) as typeof fetch;
    const offlineWorkbench = await createCardWorkbench({ dataDirectory: root, fetchImpl: noScryfallNetwork, mpcFetchImpl: offlineMpcFetch });
    workbenches.push(offlineWorkbench);
    const offlineImport = await offlineWorkbench.importForWorkingSet({ files: [{ filename: "mpc-order-synthetic.xml", bytes: xml }] });
    const offlineResponse = await handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: offlineImport.workingCards.slice(0, 1), options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES } }),
    }), offlineWorkbench);

    expect(offlineResponse.status).toBe(200);
    expect(offlineMpcFetch).not.toHaveBeenCalled();
  });

  it("exports a gallery-selected MPC original offline after candidate metadata expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcgprint-mpc-gallery-offline-"));
    roots.push(root);
    const baseTime = Date.now();
    const originalBytes = new Uint8Array(await sharp({ create: { width: 300, height: 420, channels: 3, background: "#476" } }).png().toBuffer());
    const assetId = "gallery-choice-id_1234567890";
    let online = true;
    const mpcRequests: string[] = [];
    const mpcFetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      mpcRequests.push(url.href);
      if (!online) throw new Error("MPC is offline after the original is cached.");
      if (url.pathname === "/2/sources/") return Response.json({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.pathname === "/3/editorSearch/") {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return Response.json({ results: { [Object.keys(body.queries)[0]]: [assetId] } });
      }
      if (url.pathname === "/2/cards/") return Response.json({ results: {
        [assetId]: { identifier: assetId, cardType: "CARD", name: "Sol Ring · Gallery choice", sourceId: 41, sourceType: "Google Drive", extension: "png", size: originalBytes.byteLength, dpi: 600 },
      } });
      if (url.pathname === "/uc") return new Response(originalBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(originalBytes.byteLength) } });
      throw new Error(`Unexpected MPC request: ${url.href}`);
    };
    const scryfall = fakeScryfallClient(resolvedDeckPrintings);
    const workbench = await createCardWorkbench({ dataDirectory: root, scryfallClient: scryfall.client, mpcFetchImpl, minIntervalMs: 0, mpcWaitForRetry: async () => undefined });
    workbenches.push(workbench);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime));
    try {
      const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
      const resolved = await workbench.resolveWorkingCards(imported.workingCards);
      const card = resolved.workingCards[0];
      const [candidate] = await workbench.listArtworkCandidates(card.identity!.id, "front", "mpc");
      const selected = workbench.selectArtwork(card, "front", candidate);
      const cachedOriginal = await workbench.getArtworkOriginal(candidate.id);
      expect(cachedOriginal.bytes).toEqual(originalBytes);
      expect(selected.id).toBe(card.id);
      expect(selected.identity?.id).toBe(card.identity?.id);
      expect(selected.selectedArtworkByFace.front?.candidateId).toBe(candidate.id);
      expect(await workbench.getArtworkCandidate(candidate.id)).toMatchObject({ originalAvailable: true, originalCached: true });

      vi.setSystemTime(new Date(baseTime + 366 * 24 * 60 * 60 * 1000));
      online = false;
      const callsWhenOffline = mpcRequests.length;
      const response = await handleCardExport(new Request("http://localhost/api/cards/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: [selected], options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES } }),
      }), workbench);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/pdf");
      expect(mpcRequests).toHaveLength(callsWhenOffline);

      vi.setSystemTime(new Date(baseTime + 732 * 24 * 60 * 60 * 1000));
      const originalPath = originalPathForHash(appDataPaths(root).originalsDirectory, cachedOriginal.contentHash, cachedOriginal.extension);
      await unlink(originalPath);
      const missingResponse = await handleCardExport(new Request("http://localhost/api/cards/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: [selected], options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES } }),
      }), workbench);
      const missingBody = await missingResponse.json() as { code: string; message: string };
      expect(missingResponse.status).toBe(422);
      expect(missingBody).toMatchObject({ code: "ARTWORK_ORIGINAL_UNAVAILABLE" });
      expect(missingBody.message).toContain("ARTWORK_MISSING");

      await writeFile(originalPath, new Uint8Array([1, 2, 3, 4]));
      const corruptResponse = await handleCardExport(new Request("http://localhost/api/cards/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: [selected], options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES } }),
      }), workbench);
      const corruptBody = await corruptResponse.json() as { code: string; message: string };
      expect(corruptResponse.status).toBe(422);
      expect(corruptBody).toMatchObject({ code: "ARTWORK_ORIGINAL_UNAVAILABLE" });
      expect(corruptBody.message).toContain("ARTWORK_CONTENT_CORRUPT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps WorkingCard and CardIdentity IDs stable across independent MPC DFC face selections", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcgprint-mpc-dfc-selection-"));
    roots.push(root);
    const identityCard = mapScryfallCard(delverCard);
    const scryfall = fakeScryfallClient([identityCard]);
    const mpcFetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return Response.json({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, { query: string }> };
        const [hash, query] = Object.entries(body.queries)[0];
        const assetId = query.query === "Delver of Secrets" ? "dfc-front-id_1234567890" : "dfc-back-id_1234567890";
        return Response.json({ results: { [hash]: [assetId] } });
      }
      if (url.endsWith("/2/cards/")) {
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        return Response.json({ results: Object.fromEntries(body.cardIdentifiers.map((id) => [id, {
          identifier: id, cardType: "CARD", name: id, sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 1200,
        }])) });
      }
      throw new Error(`Unexpected fake MPC request: ${url}`);
    };
    const workbench = await createCardWorkbench({ dataDirectory: root, scryfallClient: scryfall.client, mpcFetchImpl });
    workbenches.push(workbench);
    const imported = await workbench.importForWorkingSet({ text: "1 Delver of Secrets" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0], identityCard.id);
    const identityId = identified.identity!.id;
    const [front] = await workbench.listArtworkCandidates(identityId, "front", "mpc");
    const [back] = await workbench.listArtworkCandidates(identityId, "back", "mpc");
    const frontSelected = workbench.selectArtwork(identified, "front", front);
    const bothSelected = workbench.selectArtwork(frontSelected, "back", back);

    expect(front.faceId).toBe("front");
    expect(back.faceId).toBe("back");
    expect(front.id).not.toBe(back.id);
    expect(bothSelected.id).toBe(identified.id);
    expect(bothSelected.identity).toEqual(identified.identity);
    expect(bothSelected.selectedArtworkByFace).toMatchObject({
      front: { candidateId: front.id, source: "mpc", faceId: "front" },
      back: { candidateId: back.id, source: "mpc", faceId: "back" },
    });
  });

  it("honors caller cancellation before starting resolution", async () => {
    const { workbench } = await setup();
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const controller = new AbortController();
    controller.abort();
    await expect(workbench.resolveWorkingCards(imported.workingCards, { signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
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
    expect(result.backMode).toBe("auto");
    expect(result.backModeSelectionPolicy).toBe("automatic");
    expect(requestPaths).toEqual(["/cards/named"]);
    expect(await workbench.getArtworkOriginal(localId)).toMatchObject({ bytes });
  });

  it("does not interpret two provider faces as a DFC when the Scryfall layout is split", async () => {
    const doubleFaced = mapScryfallCard(delverCard);
    const split = { ...doubleFaced, name: "Fire // Ice", layout: "split" };
    const fake = fakeScryfallClient([split]);
    const { workbench } = await setup(undefined, fake.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Delver of Secrets" });
    const source = imported.workingCards[0];
    const resolved = await workbench.resolveWorkingCards([{
      ...source,
      identityHints: { ...source.identityHints, scryfallId: split.id },
    }]);

    expect(resolved.workingCards[0]).toMatchObject({
      backMode: "project-default",
      backModeSelectionPolicy: "automatic",
      faces: [{ side: "front" }],
    });
    expect(resolved.workingCards[0].selectedArtworkByFace.back).toBeUndefined();
  });

  it("supports mixed face providers and keeps a manual DFC back after provider re-resolution", async () => {
    const identityCard = mapScryfallCard(delverCard);
    const initial = fakeScryfallClient([identityCard]);
    const { workbench } = await setup(undefined, initial.client);
    const imported = await workbench.importForWorkingSet({ text: "1 Delver of Secrets" });
    const identified = await workbench.confirmWorkingCardIdentity(imported.workingCards[0], identityCard.id);
    const [scryfallBack] = await workbench.listArtworkCandidates(identified.identity!.id, "back", "scryfall");
    const mpcBack = {
      id: `mpc:${"c".repeat(64)}`,
      source: "mpc" as const,
      identityId: identified.identity!.id,
      faceId: "back",
      providerAssetId: "dfc-back-provider-id",
      selectedArtworkId: "dfc-back-selected-id",
      originalAvailable: true,
    };
    const mpcFront = {
      ...mpcBack,
      id: `mpc:${"d".repeat(64)}`,
      faceId: "front",
      providerAssetId: "dfc-front-provider-id",
      selectedArtworkId: "dfc-front-selected-id",
    };
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const upload = await workbench.importForWorkingSet({ files: [{ filename: "face.png", bytes }] });
    const uploadCandidate = await workbench.getArtworkCandidate(upload.workingCards[0].localArtworkIds[0]);
    if (!scryfallBack || !uploadCandidate) throw new Error("Expected Scryfall and validated upload face candidates.");

    const scryfallFrontMpcBack = workbench.selectArtwork(identified, "back", mpcBack);
    const mpcFrontUploadBack = workbench.selectArtwork(
      workbench.selectArtwork(identified, "front", mpcFront),
      "back",
      uploadCandidate,
    );
    const uploadFrontScryfallBack = workbench.selectArtwork(
      workbench.selectArtwork(identified, "front", uploadCandidate),
      "back",
      scryfallBack,
    );

    expect(scryfallFrontMpcBack.selectedArtworkByFace).toMatchObject({
      front: { source: "scryfall", faceId: "front", identityId: identified.identity!.id },
      back: { source: "mpc", faceId: "back", providerAssetId: "dfc-back-provider-id", selectedArtworkId: "dfc-back-selected-id" },
    });
    expect(mpcFrontUploadBack.selectedArtworkByFace).toMatchObject({
      front: { source: "mpc", faceId: "front", providerAssetId: "dfc-front-provider-id", selectedArtworkId: "dfc-front-selected-id" },
      back: { source: "upload", faceId: "back", identityId: identified.identity!.id },
    });
    expect(uploadFrontScryfallBack.selectedArtworkByFace).toMatchObject({
      front: { source: "upload", faceId: "front", identityId: identified.identity!.id },
      back: { source: "scryfall", faceId: "back", identityId: identified.identity!.id },
    });
    expect([scryfallFrontMpcBack, mpcFrontUploadBack, uploadFrontScryfallBack].map((card) => card.backMode)).toEqual([
      "manual", "manual", "manual",
    ]);

    const updatedDfc = {
      ...identityCard,
      faces: identityCard.faces.map((face, index) => index === 1 ? { ...face, name: "Insectile Aberration Updated" } : face),
    };
    const refreshedRoot = await mkdtemp(join(tmpdir(), "tcgprint-dfc-refresh-"));
    roots.push(refreshedRoot);
    const refreshedWorkbench = await createCardWorkbench({
      dataDirectory: refreshedRoot,
      scryfallClient: fakeScryfallClient([updatedDfc]).client,
      minIntervalMs: 0,
    });
    workbenches.push(refreshedWorkbench);
    const refreshed = await refreshedWorkbench.reresolveWorkingCard({
      ...scryfallFrontMpcBack,
      identityHints: { ...scryfallFrontMpcBack.identityHints, scryfallId: identityCard.id },
    });

    expect(refreshed).toMatchObject({
      identity: { id: identified.identity!.id },
      backMode: "manual",
      backModeSelectionPolicy: "explicit",
      selectedArtworkByFace: {
        back: {
          candidateId: `mpc:${"c".repeat(64)}`,
          providerAssetId: "dfc-back-provider-id",
          selectedArtworkId: "dfc-back-selected-id",
          faceId: "back",
          selectionPolicy: "user-selected",
        },
      },
    });
  });
});
