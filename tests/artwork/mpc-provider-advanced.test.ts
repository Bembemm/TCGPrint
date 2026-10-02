import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardIdentity } from "../../core/cards/types";
import { normalizeMpcArtworkFilters } from "../../artwork/mpc-contract";
import { appDataPaths, originalPathForHash } from "../../artwork/storage/paths";
import { ArtworkMetadataCache } from "../../artwork/storage/metadata-cache";
import { ArtworkOriginalStore } from "../../artwork/storage/original-store";
import { ArtworkRepository } from "../../artwork/storage/repository";
import { ArtworkThumbnailStore } from "../../artwork/storage/thumbnail-store";
import { ArtworkCatalog } from "../../artwork/catalog";
import { MpcArtworkProvider, MPC_HYDRATION_CHUNK_SIZE } from "../../artwork/mpc-provider";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const identity: CardIdentity = {
  id: "scryfall:oracle-sol-ring", provider: "scryfall", name: "Sol Ring",
  setCode: "c21", collectorNumber: "263", lang: "en",
  resolutionMethod: "name", confidence: 1,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function sourceCatalog() {
  return { results: { "41": { pk: 41, name: "Drive A", sourceType: "Google Drive" }, "42": { pk: 42, name: "Drive B", sourceType: "Google Drive" }, "99": { pk: 99, name: "Unsafe", sourceType: "HTTP" } } };
}

function languageCatalog() { return { languages: [{ code: "en", name: "English" }, { code: "ja", name: "Japanese" }] }; }
function tagCatalog() { return { tags: [{ name: "Promo", children: [{ name: "Borderless" }] }, { name: "Showcase" }] }; }

function card(identifier: string, overrides: Record<string, unknown> = {}) {
  return {
    identifier, cardType: "CARD", name: `Sol Ring ${identifier}`, sourceId: 41,
    sourceName: "Drive A", sourceType: "Google Drive", extension: "png", size: 1000,
    dpi: 1200, language: "en", tags: ["Borderless"], priority: 4,
    dateCreated: "2024-01-01T00:00:00Z", dateModified: "2025-01-01T00:00:00Z",
    canonicalCard: { name: "Sol Ring", expansionCode: "C21", collectorNumber: "263", rarity: "rare" },
    canonicalArtist: { name: "Artist A", scryfallId: "artist-id" },
    smallThumbnailUrl: "https://drive.google.com/thumbnail?id=asset-id-1234567890",
    ...overrides,
  };
}

async function setup(fetchImpl: typeof fetch) {
  const base = await mkdtemp(join(tmpdir(), "tcgprint-mpc-advanced-"));
  temporaryDirectories.push(base);
  const paths = appDataPaths(base);
  await mkdir(dirname(paths.databaseFile), { recursive: true });
  const database = new Database(paths.databaseFile);
  const repository = new ArtworkRepository(database);
  const originals = new ArtworkOriginalStore(paths.originalsDirectory, repository);
  const thumbnails = new ArtworkThumbnailStore(paths.thumbnailsDirectory, repository);
  const metadata = new ArtworkMetadataCache(repository);
  const provider = new MpcArtworkProvider({ fetchImpl, originals, thumbnails, metadata, repository, timeoutMs: 1000, waitForRetry: async () => undefined });
  return { database, provider, originals, repository, metadata, paths };
}

function apiFake(options: { records?: Record<string, Record<string, unknown>>; calls?: Array<{ path: string; body?: unknown }>; v3Status?: number } = {}): typeof fetch {
  const calls = options.calls ?? [];
  const records: Record<string, Record<string, unknown>> = options.records ?? { "asset-id-1234567890": card("asset-id-1234567890") };
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ path: url.pathname, ...(body === undefined ? {} : { body }) });
    if (url.pathname === "/2/sources/") return json(sourceCatalog());
    if (url.pathname === "/2/languages/") return json(languageCatalog());
    if (url.pathname === "/2/tags/") return json(tagCatalog());
    if (url.pathname === "/3/editorSearch/") {
      if (options.v3Status) return new Response("unavailable", { status: options.v3Status });
      const queries = (body as { queries: Record<string, unknown> }).queries;
      const [queryHash] = Object.keys(queries);
      return json({ results: { [queryHash]: Object.keys(records) } });
    }
    if (url.pathname === "/2/editorSearch/") return json({ results: { "Sol Ring": { CARD: Object.keys(records) } } });
    if (url.pathname === "/2/cards/") {
      const ids = (body as { cardIdentifiers: string[] }).cardIdentifiers;
      return json({ results: Object.fromEntries(ids.flatMap((id) => records[id] ? [[id, records[id]]] : [])) });
    }
    if (url.pathname === "/uc") throw new Error("unexpected asset download");
    throw new Error(`unexpected HTTP fake request: ${url.pathname}`);
  };
}

describe("advanced MPC artwork provider", () => {
  it("sends normalized DPI, source, tag, and language filters and reuses equivalent-filter cache entries", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const { database, provider } = await setup(apiFake({ calls }));
    const first = normalizeMpcArtworkFilters({ minimumDpi: 600, maximumDpi: 1200, sources: [42, 42], includeTags: [" promo "], excludeTags: ["showcase"], languages: ["EN"] });
    const equivalent = normalizeMpcArtworkFilters({ minimumDpi: 600, maximumDpi: 1200, sources: [42], includeTags: ["PROMO"], excludeTags: ["Showcase"], languages: ["en"] });

    await provider.searchArtworkAdvanced(identity, { filters: first });
    await provider.searchArtworkAdvanced(identity, { filters: equivalent });

    const search = calls.find(({ path }) => path === "/3/editorSearch/")?.body as { searchSettings: { filterSettings: unknown; sourceSettings: { sources: number[][] } } };
    expect(search.searchSettings.filterSettings).toEqual({ minimumDPI: 600, maximumDPI: 1200, maximumSize: 30, includesTags: ["Promo"], excludesTags: ["Showcase"], languages: ["en"] });
    expect(search.searchSettings.sourceSettings.sources).toEqual([[41, false], [42, true]]);
    expect(calls.filter(({ path }) => path === "/3/editorSearch/")).toHaveLength(1);
    await database.close();
  });

  it("filters hydrated source IDs even if an editor-search response includes an unselected verified source", async () => {
    const records = {
      "source-a-id-123456": card("source-a-id-123456", { sourceId: 41 }),
      "source-b-id-123456": card("source-b-id-123456", { sourceId: 42, sourceName: "Drive B" }),
    };
    const { database, provider } = await setup(apiFake({ records }));

    const candidates = await provider.searchArtworkAdvanced(identity, { filters: { sources: [42] } });

    expect(candidates.map((candidate) => candidate.providerAssetId)).toEqual(["source-b-id-123456"]);
    await database.close();
  });

  it.each([
    ["minimum DPI", { minimumDpi: 1300 }, { dpi: 1200 }],
    ["maximum DPI", { maximumDpi: 1000 }, { dpi: 1200 }],
    ["language", { languages: ["ja"] }, { language: "en" }],
    ["included tags", { includeTags: ["Promo"] }, { tags: ["Borderless"] }],
    ["excluded tags", { excludeTags: ["Borderless"] }, { tags: ["Borderless"] }],
  ] as const)("locally enforces hydrated %s filters when MPC returns broader results", async (_name, filters, overrides) => {
    const assetId = "filter-check-id-123456";
    const { database, provider } = await setup(apiFake({ records: { [assetId]: card(assetId, overrides) } }));

    const candidates = await provider.searchArtworkAdvanced(identity, { filters });

    expect(candidates).toEqual([]);
    await database.close();
  });

  it("keeps hydrated candidates that satisfy all active filters", async () => {
    const assetId = "filter-match-id-123456";
    const records = {
      [assetId]: card(assetId, { sourceId: 42, sourceName: "Drive B", dpi: 800, language: "ja", tags: ["Promo", "Borderless"] }),
    };
    const { database, provider } = await setup(apiFake({ records }));

    const candidates = await provider.searchArtworkAdvanced(identity, {
      filters: { minimumDpi: 700, maximumDpi: 900, sources: [42], includeTags: ["Promo"], excludeTags: ["Showcase"], languages: ["ja"] },
    });

    expect(candidates.map(({ providerAssetId }) => providerAssetId)).toEqual([assetId]);
    await database.close();
  });

  it("ranks expired cached search results consistently while MPC is offline", async () => {
    vi.useFakeTimers();
    const baseTime = Date.now();
    vi.setSystemTime(baseTime);
    let online = true;
    const records = {
      "source-a-id-123456": card("source-a-id-123456", { sourceId: 41 }),
      "source-b-id-123456": card("source-b-id-123456", { sourceId: 42, sourceName: "Drive B" }),
    };
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (!online) throw new Error("MPC is offline");
      return apiFake({ records })(input, init);
    };
    const { database, provider } = await setup(fetcher);
    try {
      const filters = { preferredSources: [42] };
      const onlineCandidates = await provider.searchArtworkAdvanced(identity, { filters });
      expect(onlineCandidates.map(({ providerAssetId }) => providerAssetId)).toEqual(["source-b-id-123456", "source-a-id-123456"]);

      vi.setSystemTime(baseTime + 25 * 60 * 60 * 1000);
      online = false;
      const offlineCandidates = await provider.searchArtworkAdvanced(identity, { filters });

      expect(offlineCandidates.map(({ providerAssetId }) => providerAssetId)).toEqual(["source-b-id-123456", "source-a-id-123456"]);
    } finally {
      vi.useRealTimers();
      await database.close();
    }
  });

  it("sends advanced filters unchanged through the documented legacy route after an explicit v3 404", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const { database, provider } = await setup(apiFake({ calls, v3Status: 404 }));

    await provider.searchArtworkAdvanced(identity, { filters: { minimumDpi: 500, maximumDpi: 1000, includeTags: ["Borderless"], languages: ["en"] } });

    expect(calls.map(({ path }) => path)).toEqual(["/2/sources/", "/2/languages/", "/2/tags/", "/3/editorSearch/", "/2/editorSearch/", "/2/cards/"]);
    const legacyBody = calls.find(({ path }) => path === "/2/editorSearch/")?.body as { searchSettings: { filterSettings: Record<string, unknown> } };
    expect(legacyBody.searchSettings.filterSettings).toMatchObject({ minimumDPI: 500, maximumDPI: 1000, includesTags: ["Borderless"], languages: ["en"] });
    expect(provider.getDiagnostic()).toMatchObject({ lastProtocolConfirmed: "v2", v3Available: false, fallbackV2Used: true });
    await database.close();
  });

  it("preserves validated MPC metadata separately from the effective DPI measured from local pixels", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 120, height: 180, channels: 3, background: "#345" } }).png().toBuffer());
    const calls: Array<{ path: string; body?: unknown }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "drive.google.com") return new Response(null, { status: 302, headers: { location: "https://drive.usercontent.google.com/download?id=asset-id-1234567890" } });
      if (url.hostname === "drive.usercontent.google.com") return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
      return apiFake({ calls, records: { "asset-id-1234567890": card("asset-id-1234567890", { size: png.byteLength }) } })(input, init);
    };
    const { database, provider } = await setup(fetcher);
    const [candidate] = await provider.searchArtwork(identity);
    expect(candidate.metadata).toMatchObject({ dpi: 1200, sourceId: 41, sourceName: "Drive A", language: "en", tags: ["Borderless"], priority: 4, dateCreated: "2024-01-01T00:00:00.000Z", dateModified: "2025-01-01T00:00:00.000Z", canonicalCard: { expansionCode: "C21", collectorNumber: "263" }, canonicalArtist: { name: "Artist A" } });
    expect(candidate.effectiveDpi).toBeUndefined();

    await provider.getOriginal(candidate.id);
    const hydrated = await provider.getCandidate(candidate.id);
    expect(hydrated?.metadata?.dpi).toBe(1200);
    expect(hydrated?.effectiveDpi).toBe(Math.floor(Math.min(120 / 2.5, 180 / 3.5)));
    await database.close();
  });

  it("caches the live filter catalogs and degrades without breaking unfiltered search when tag or language catalogs fail", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const { database, provider } = await setup(apiFake({ calls }));
    await expect(provider.getFilterCatalogs()).resolves.toMatchObject({ sources: expect.arrayContaining([{ id: 41, name: "Drive A", sourceType: "Google Drive" }]), languages: expect.arrayContaining([{ code: "en", name: "English" }]), tags: expect.arrayContaining([{ name: "Borderless" }, { name: "Promo" }]) });
    await provider.getFilterCatalogs();
    expect(calls.filter(({ path }) => ["/2/sources/", "/2/languages/", "/2/tags/"].includes(path))).toHaveLength(3);
    await database.close();

    const failingCalls: string[] = [];
    const degradedFetcher: typeof fetch = async (input, init = {}) => {
      const pathname = new URL(String(input)).pathname;
      failingCalls.push(pathname);
      if (pathname === "/2/languages/" || pathname === "/2/tags/") return new Response("offline", { status: 503 });
      return apiFake()(input, init);
    };
    const degraded = await setup(degradedFetcher);
    await expect(degraded.provider.getFilterCatalogs()).rejects.toMatchObject({ kind: "http" });
    await expect(degraded.provider.searchArtwork(identity)).resolves.toHaveLength(1);
    expect(degraded.provider.getDiagnostic()).toMatchObject({ degraded: true });
    await degraded.database.close();
  });

  it("refreshes only metadata, keeps a cached valid original when the provider removes its card, and identifies stale metadata", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 80, height: 120, channels: 3, background: "#654" } }).png().toBuffer());
    const records = { "asset-id-1234567890": card("asset-id-1234567890", { size: png.byteLength }) };
    let removed = false;
    let originalRequests = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "drive.google.com") {
        originalRequests += 1;
        return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
      }
      if (url.pathname === "/2/cards/" && removed) return json({ results: {} });
      return apiFake({ records })(input, init);
    };
    const { database, provider } = await setup(fetcher);
    const [candidate] = await provider.searchArtwork(identity);
    const original = await provider.getOriginal(candidate.id);
    removed = true;

    const refreshed = await provider.refreshCandidate(candidate.id);
    expect(refreshed).toMatchObject({ id: candidate.id, originalCached: true, originalAvailable: true, metadata: { remoteMetadataStatus: "removed" } });
    await expect(provider.getOriginal(candidate.id)).resolves.toMatchObject({ contentHash: original.contentHash, bytes: png });
    expect(originalRequests).toBe(1);
    await database.close();
  });

  it("refreshes candidate metadata without downloading or changing the candidate or selected artwork ID", async () => {
    const assetId = "asset-id-1234567890";
    const records: Record<string, Record<string, unknown>> = { [assetId]: card(assetId) };
    const fetcher: typeof fetch = (input, init = {}) => apiFake({ records })(input, init);
    const { database, provider } = await setup(fetcher);
    const [candidate] = await provider.searchArtwork(identity);
    records[assetId] = card(assetId, { name: "Updated community frame", dpi: 2400, priority: 9, dateModified: "2026-01-01T00:00:00Z" });

    const refreshed = await provider.refreshCandidate(candidate.id);

    expect(refreshed).toMatchObject({ id: candidate.id, selectedArtworkId: assetId, originalCached: false, metadata: { name: "Updated community frame", dpi: 2400, priority: 9, remoteMetadataStatus: "current", dateModified: "2026-01-01T00:00:00.000Z" } });
    expect(provider.getDiagnostic()).toMatchObject({ lastSuccessfulOperation: "metadata-refresh" });
    await database.close();
  });

  it("serves expired catalogs from stale cache when MPC is offline and reports bounded degraded diagnostics", async () => {
    vi.useFakeTimers();
    const baseTime = Date.now();
    vi.setSystemTime(baseTime);
    let online = true;
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (!online) throw new Error("https://private.example/path?token=must-not-leak");
      return apiFake()(input, init);
    };
    const { database, provider } = await setup(fetcher);
    const catalog = new ArtworkCatalog([provider]);
    try {
      await catalog.getMpcFilterCatalogs();
      vi.setSystemTime(baseTime + 25 * 60 * 60 * 1000);
      online = false;
      await expect(catalog.getMpcFilterCatalogs()).resolves.toMatchObject({ sources: expect.any(Array), languages: expect.any(Array), tags: expect.any(Array) });
      const diagnostic = provider.getDiagnostic();
      expect(diagnostic).toMatchObject({ degraded: true, catalogCaches: { sources: { state: "stale" }, languages: { state: "stale" }, tags: { state: "stale" } } });
      expect(provider.getHealth()).toMatchObject({ available: true, degraded: true });
      expect(catalog.getProviderHealth().mpc).toMatchObject({ available: true, degraded: true });
      expect(JSON.stringify(diagnostic)).not.toContain("private");
      expect(JSON.stringify(diagnostic)).not.toContain("token");
      expect(JSON.stringify(provider.getHealth())).not.toContain("private.example");
      expect(JSON.stringify(catalog.getProviderHealth().mpc)).not.toContain("must-not-leak");

      online = true;
      await expect(catalog.getMpcFilterCatalogs()).resolves.toMatchObject({ sources: expect.any(Array), languages: expect.any(Array), tags: expect.any(Array) });
      expect(provider.getDiagnostic()).toMatchObject({ degraded: false });
      expect(provider.getHealth()).toMatchObject({ available: true, degraded: false });
      expect(catalog.getProviderHealth().mpc).toMatchObject({ available: true, degraded: false });
    } finally {
      vi.useRealTimers();
      await database.close();
    }
  });

  it("preserves the MPC search order as providerRank and ranks by that signal after explicit preferences", async () => {
    const first = "provider-rank-first-123456";
    const second = "provider-rank-second-12345";
    const records = { [first]: card(first), [second]: card(second) };
    const { database, provider } = await setup(apiFake({ records }));

    const candidates = await provider.searchArtworkAdvanced(identity);

    expect(candidates.map(({ providerAssetId }) => providerAssetId)).toEqual([first, second]);
    expect(candidates.map(({ metadata }) => metadata?.providerRank)).toEqual([0, 1]);
    await database.close();
  });

  it("confirms UI capabilities only after the corresponding MPC protocol and catalogs are observed", async () => {
    const { database, provider } = await setup(apiFake());
    expect(provider.getDiagnostic().capabilities).toMatchObject({
      search: false,
      filters: { dpi: false, sources: false, tags: false, languages: false },
    });

    await provider.getFilterCatalogs();
    expect(provider.getDiagnostic().capabilities.filters).toMatchObject({ sources: true, tags: true, languages: true, dpi: false });
    await provider.searchArtwork(identity);
    expect(provider.getDiagnostic().capabilities).toMatchObject({
      search: true,
      preview: true,
      original: true,
      filters: { dpi: true, sources: true, tags: true, languages: true },
      protocol: { confirmedVersion: "v3", v3Available: true, fallbackV2Used: false },
    });
    await database.close();
  });

  it("tracks successful remote contact separately from a cached successful search", async () => {
    vi.useFakeTimers();
    const baseTime = Date.parse("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(baseTime);
    const calls: Array<{ path: string; body?: unknown }> = [];
    const { database, provider } = await setup(apiFake({ calls }));
    try {
      await provider.searchArtwork(identity);
      const afterRemoteSearch = provider.getDiagnostic();
      const contactAt = afterRemoteSearch.lastSuccessfulContactAt;
      const requests = afterRemoteSearch.metrics.remoteRequestCount;
      expect(contactAt).toBeDefined();

      vi.setSystemTime(baseTime + 10_000);
      await provider.searchArtwork(identity);
      const afterCachedSearch = provider.getDiagnostic();

      expect(afterCachedSearch.lastSuccessfulAt).not.toBe(afterRemoteSearch.lastSuccessfulAt);
      expect(afterCachedSearch.lastSuccessfulContactAt).toBe(contactAt);
      expect(afterCachedSearch.metrics.remoteRequestCount).toBe(requests);
    } finally {
      await database.close();
      vi.useRealTimers();
    }
  });

  it("keeps valid cards from partial hydration, marks health degraded, and records omitted IDs", async () => {
    const first = "partial-hydration-first-12345";
    const missing = "partial-hydration-missing-1234";
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (new URL(String(input)).pathname === "/3/editorSearch/") {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return json({ results: { [Object.keys(body.queries)[0]!]: [first, missing] } });
      }
      if (new URL(String(input)).pathname === "/2/cards/") return json({ results: { [first]: card(first) } });
      return apiFake()(input, init);
    };
    const { database, provider } = await setup(fetcher);

    const candidates = await provider.searchArtworkAdvanced(identity);

    expect(candidates.map(({ providerAssetId }) => providerAssetId)).toEqual([first]);
    expect(provider.getDiagnostic()).toMatchObject({ degraded: true, metrics: { omittedHydrationCount: 1 } });
    expect(provider.getDiagnostic().metrics.inFlightRequests).toEqual({ api: 0, images: 0 });
    await database.close();
  });

  it("hydrates repeated candidate references once per unique provider asset using bounded chunks", async () => {
    const records: Record<string, Record<string, unknown>> = {};
    const calls: Array<{ path: string; body?: unknown }> = [];
    const { database, provider, metadata } = await setup(apiFake({ records, calls }));
    const candidateIds: string[] = [];
    const uniqueAssetIds = Array.from({ length: 20 }, (_, index) => `batch-asset-${String(index).padStart(2, "0")}-12345`);
    for (let index = 0; index < 100; index += 1) {
      const id = `mpc:${index.toString(16).padStart(64, "0")}`;
      const assetId = uniqueAssetIds[index % uniqueAssetIds.length]!;
      candidateIds.push(id);
      records[assetId] = card(assetId);
      metadata.putMetadata(`mpc:candidate:${id}`, { candidate: { id, source: "mpc", identityId: identity.id, faceId: index % 2 ? "back" : "front", providerAssetId: assetId, selectedArtworkId: assetId, originalAvailable: false, originalCached: false, metadata: { name: `Candidate ${index}`, sourceId: 41, dpi: 1200 } } }, Date.now() + 60_000);
    }

    const results = await provider.revalidateCandidates(candidateIds);

    expect(results).toHaveLength(100);
    expect(calls.filter(({ path }) => path === "/2/cards/")).toHaveLength(Math.ceil(20 / MPC_HYDRATION_CHUNK_SIZE));
    expect(provider.getDiagnostic().metrics).toMatchObject({ hydrationBatchCount: Math.ceil(20 / MPC_HYDRATION_CHUNK_SIZE), revalidation: { candidates: 100 } });
    await database.close();
  });

  it("isolates a malformed hydration chunk while keeping successful revalidation results", async () => {
    const records: Record<string, Record<string, unknown>> = {};
    const calls: Array<{ path: string; body?: unknown }> = [];
    const assetIds = Array.from({ length: MPC_HYDRATION_CHUNK_SIZE + 1 }, (_, index) => `chunk-${String(index).padStart(2, "0")}-asset-12345`);
    for (const assetId of assetIds) records[assetId] = card(assetId);
    const baseFetch = apiFake({ records, calls });
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (new URL(String(input)).pathname === "/2/cards/") {
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        if (body.cardIdentifiers.includes(assetIds.at(-1)!)) {
          calls.push({ path: "/2/cards/", body });
          return new Response("malformed json", { headers: { "content-type": "application/json" } });
        }
      }
      return baseFetch(input, init);
    };
    const { database, provider, metadata } = await setup(fetcher);
    const candidateIds = assetIds.map((assetId, index) => {
      const id = `mpc:${index.toString(16).padStart(64, "0")}`;
      metadata.putMetadata(`mpc:candidate:${id}`, {
        candidate: { id, source: "mpc", identityId: identity.id, faceId: "front", providerAssetId: assetId, selectedArtworkId: assetId, originalAvailable: false, originalCached: false, metadata: { sourceId: 41, dpi: 1200 } },
      }, Date.now() + 60_000);
      return id;
    });

    const results = await provider.revalidateCandidates(candidateIds);

    expect(results).toHaveLength(assetIds.length);
    expect(results.slice(0, MPC_HYDRATION_CHUNK_SIZE).every(({ status }) => status !== "remote-unavailable")).toBe(true);
    expect(results.at(-1)).toMatchObject({ status: "remote-unavailable", failureKind: "protocol" });
    expect(calls.filter(({ path }) => path === "/2/cards/")).toHaveLength(2);
    expect(provider.getDiagnostic()).toMatchObject({ degraded: true, metrics: { inFlightRequests: { api: 0, images: 0 } } });
    await database.close();
  });

  it("cancels every active hydration chunk and clears its shared request state", async () => {
    let enteredHydration!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => { enteredHydration = resolve; });
    const fetcher: typeof fetch = async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === "/2/sources/") return json(sourceCatalog());
      if (path === "/2/cards/") {
        enteredHydration();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      throw new Error(`unexpected request: ${path}`);
    };
    const { database, provider, metadata } = await setup(fetcher);
    const candidateId = `mpc:${"b".repeat(64)}`;
    const stored = {
      candidate: { id: candidateId, source: "mpc" as const, identityId: identity.id, faceId: "front" as const, providerAssetId: "cancel-batch-asset-123456", originalAvailable: false, originalCached: false, metadata: { dpi: 1200 } },
    };
    metadata.putMetadata(`mpc:candidate:${candidateId}`, stored, Date.now() + 60_000);
    const controller = new AbortController();
    const revalidation = provider.revalidateCandidates([candidateId], controller.signal);
    await hydrationStarted;
    controller.abort();

    await expect(revalidation).rejects.toMatchObject({ kind: "aborted" });
    expect(metadata.getMetadataSnapshot(`mpc:candidate:${candidateId}`)?.value).toEqual(stored);
    expect(provider.getDiagnostic().metrics.inFlightRequests).toEqual({ api: 0, images: 0 });
    await database.close();
  });

  it("coalesces simultaneous identical searches while one cancelled consumer leaves the other active", async () => {
    const calls: string[] = [];
    const baseFetcher = apiFake();
    let releaseSearch!: () => void;
    let enteredSearch!: () => void;
    const searchStarted = new Promise<void>((resolve) => { enteredSearch = resolve; });
    const waitForSearch = new Promise<void>((resolve) => { releaseSearch = resolve; });
    const fetcher: typeof fetch = async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/3/editorSearch/") { enteredSearch(); await waitForSearch; }
      return baseFetcher(input, init);
    };
    const { database, provider } = await setup(fetcher);
    const firstController = new AbortController();
    const first = provider.searchArtworkAdvanced(identity, { signal: firstController.signal });
    const second = provider.searchArtworkAdvanced(identity);
    await searchStarted;
    firstController.abort();
    releaseSearch();

    await expect(first).rejects.toMatchObject({ kind: "aborted" });
    await expect(second).resolves.toHaveLength(1);
    expect(calls.filter((path) => path === "/3/editorSearch/")).toHaveLength(1);
    expect(calls.filter((path) => path === "/2/cards/")).toHaveLength(1);
    await database.close();
  });

  it("coalesces concurrent revalidation of the same candidate and returns structured outcomes", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const records: Record<string, Record<string, unknown>> = { "asset-id-1234567890": card("asset-id-1234567890") };
    const { database, provider } = await setup(apiFake({ calls, records }));
    const [candidate] = await provider.searchArtwork(identity);
    records["asset-id-1234567890"] = card("asset-id-1234567890", { dpi: 2400, name: "Updated metadata" });
    const before = calls.filter(({ path }) => path === "/2/cards/").length;

    const [first, second] = await Promise.all([
      provider.revalidateCandidates([candidate!.id]),
      provider.revalidateCandidates([candidate!.id]),
    ]);

    expect(first[0]).toMatchObject({ status: "metadata-updated", localOriginal: "missing", candidate: { metadata: { name: "Updated metadata", dpi: 2400 } } });
    expect(second[0]).toMatchObject({ status: "metadata-updated" });
    expect(calls.filter(({ path }) => path === "/2/cards/")).toHaveLength(before + 1);
    expect(provider.getDiagnostic().metrics.inFlightRequests).toEqual({ api: 0, images: 0 });
    await database.close();
  });

  it("uses bounded Retry-After for 429 and recovers without caching rate limits as empty searches", async () => {
    let searchAttempts = 0;
    const delays: number[] = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (new URL(String(input)).pathname === "/3/editorSearch/" && searchAttempts++ < 2) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "20" } });
      }
      return apiFake()(input, init);
    };
    const base = await mkdtemp(join(tmpdir(), "tcgprint-mpc-retry-"));
    temporaryDirectories.push(base);
    const paths = appDataPaths(base);
    await mkdir(dirname(paths.databaseFile), { recursive: true });
    const database = new Database(paths.databaseFile);
    const repository = new ArtworkRepository(database);
    const provider = new MpcArtworkProvider({
      fetchImpl: fetcher,
      originals: new ArtworkOriginalStore(paths.originalsDirectory, repository),
      thumbnails: new ArtworkThumbnailStore(paths.thumbnailsDirectory, repository),
      metadata: new ArtworkMetadataCache(repository),
      repository,
      waitForRetry: async (milliseconds) => { delays.push(milliseconds); },
    });

    await expect(provider.searchArtworkAdvanced(identity)).resolves.toHaveLength(1);
    expect(delays).toEqual([2_000, 2_000]);
    expect(provider.getDiagnostic()).toMatchObject({ metrics: { httpStatusSummary: { "429": 2 }, rateLimits: 2 } });
    expect(searchAttempts).toBe(3);
    await database.close();
  });

  it("returns a distinct rate-limit error after bounded retries and does not cache it as a missing search", async () => {
    let rateLimited = true;
    let searchCalls = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (new URL(String(input)).pathname === "/3/editorSearch/") {
        searchCalls += 1;
        if (rateLimited) return new Response("private upstream content", { status: 429, headers: { "retry-after": "99999" } });
      }
      return apiFake()(input, init);
    };
    const base = await mkdtemp(join(tmpdir(), "tcgprint-mpc-rate-limit-"));
    temporaryDirectories.push(base);
    const paths = appDataPaths(base);
    await mkdir(dirname(paths.databaseFile), { recursive: true });
    const database = new Database(paths.databaseFile);
    const repository = new ArtworkRepository(database);
    const delays: number[] = [];
    const provider = new MpcArtworkProvider({
      fetchImpl: fetcher,
      originals: new ArtworkOriginalStore(paths.originalsDirectory, repository),
      thumbnails: new ArtworkThumbnailStore(paths.thumbnailsDirectory, repository),
      metadata: new ArtworkMetadataCache(repository),
      repository,
      waitForRetry: async (milliseconds) => { delays.push(milliseconds); },
    });

    await expect(provider.searchArtworkAdvanced(identity)).rejects.toMatchObject({ kind: "rate-limited", status: 429, retryAfterMs: 2_000 });
    expect(delays).toEqual([2_000, 2_000]);
    expect(provider.getDiagnostic()).toMatchObject({ degraded: true, lastFailureType: "rate-limited", metrics: { rateLimits: 3 } });
    rateLimited = false;
    await expect(provider.searchArtworkAdvanced(identity)).resolves.toHaveLength(1);
    expect(searchCalls).toBe(4);
    expect(provider.getDiagnostic().metrics.inFlightRequests).toEqual({ api: 0, images: 0 });
    await database.close();
  });

  it("retries transient 5xx responses without negative caching and then recovers", async () => {
    let offline = true;
    let searchAttempts = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      if (new URL(String(input)).pathname === "/3/editorSearch/") {
        searchAttempts += 1;
        if (offline) return new Response("upstream body", { status: 503 });
      }
      return apiFake()(input, init);
    };
    const { database, provider } = await setup(fetcher);

    await expect(provider.searchArtworkAdvanced(identity)).rejects.toMatchObject({ kind: "http", status: 503 });
    expect(searchAttempts).toBe(3);
    expect(provider.getDiagnostic()).toMatchObject({ degraded: true, metrics: { httpStatusSummary: { "503": 3 } } });
    offline = false;
    await expect(provider.searchArtworkAdvanced(identity)).resolves.toHaveLength(1);
    expect(searchAttempts).toBe(4);
    await database.close();
  });

  it.each(["thumbnail", "original"] as const)("does not abort another consumer when a coalesced %s request is cancelled", async (role) => {
    const png = new Uint8Array(await sharp({ create: { width: 60, height: 90, channels: 3, background: "#497" } }).png().toBuffer());
    let releaseImage!: () => void;
    let startedImage!: () => void;
    const imageEntered = new Promise<void>((resolve) => { startedImage = resolve; });
    const imageGate = new Promise<void>((resolve) => { releaseImage = resolve; });
    let imageRequests = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "drive.google.com") {
        imageRequests += 1;
        startedImage();
        await imageGate;
        return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.byteLength) } });
      }
      return apiFake({ records: { "asset-id-1234567890": card("asset-id-1234567890", { size: png.byteLength }) } })(input, init);
    };
    const { database, provider } = await setup(fetcher);
    const [candidate] = await provider.searchArtwork(identity);
    const firstController = new AbortController();
    const first = role === "thumbnail" ? provider.getPreview(candidate!.id, firstController.signal) : provider.getOriginal(candidate!.id, firstController.signal);
    const second = role === "thumbnail" ? provider.getPreview(candidate!.id) : provider.getOriginal(candidate!.id);
    await imageEntered;
    firstController.abort();
    releaseImage();

    await expect(first).rejects.toMatchObject({ kind: "aborted" });
    await expect(second).resolves.toBeDefined();
    expect(imageRequests).toBe(1);
    expect(provider.getDiagnostic().metrics.inFlightRequests).toEqual({ api: 0, images: 0 });
    await database.close();
  });

  it("records empty searches briefly but does not cache transient failures", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    vi.setSystemTime(startedAt);
    let online = true;
    let empty = true;
    let searchCalls = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (!online && path === "/3/editorSearch/") throw new Error("offline");
      if (path === "/3/editorSearch/") {
        searchCalls += 1;
        if (empty) {
          const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
          return json({ results: { [Object.keys(body.queries)[0]!]: [] } });
        }
      }
      return apiFake()(input, init);
    };
    const { database, provider } = await setup(fetcher);
    try {
      await expect(provider.searchArtworkAdvanced(identity)).resolves.toEqual([]);
      await expect(provider.searchArtworkAdvanced(identity)).resolves.toEqual([]);
      expect(searchCalls).toBe(1);
      vi.setSystemTime(startedAt + 31_000);
      online = false;
      await expect(provider.searchArtworkAdvanced(identity)).resolves.toEqual([]);
      online = true;
      empty = false;
      await expect(provider.searchArtworkAdvanced(identity)).resolves.toHaveLength(1);
      expect(searchCalls).toBe(2);
    } finally {
      vi.useRealTimers();
      await database.close();
    }
  });

  it("detects local corruption without refreshing implicitly and recovers only when original retrieval is explicitly requested", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 80, height: 120, channels: 3, background: "#765" } }).png().toBuffer());
    const records = { "asset-id-1234567890": card("asset-id-1234567890", { size: png.byteLength }) };
    let assetRequests = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "drive.google.com") {
        assetRequests += 1;
        return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
      }
      return apiFake({ records })(input, init);
    };
    const { database, provider, paths } = await setup(fetcher);
    const [candidate] = await provider.searchArtwork(identity);
    const first = await provider.getOriginal(candidate.id);
    await writeFile(originalPathForHash(paths.originalsDirectory, first.contentHash, first.extension), new Uint8Array([1, 2, 3, 4]));
    await expect(provider.getCandidate(candidate.id)).resolves.toMatchObject({ originalCached: false });
    expect(assetRequests).toBe(1);
    await expect(provider.getOriginal(candidate.id)).resolves.toMatchObject({ bytes: png });
    expect(assetRequests).toBe(2);
    expect(first.contentHash).toBeTruthy();
    await database.close();
  });
});
