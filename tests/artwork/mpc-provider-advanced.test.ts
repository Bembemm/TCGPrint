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
import { MpcArtworkProvider } from "../../artwork/mpc-provider";

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
  const provider = new MpcArtworkProvider({ fetchImpl, originals, thumbnails, metadata, repository, timeoutMs: 1000 });
  return { database, provider, originals, repository, paths };
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
