import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mpcArtworkCandidateId } from "../../core/cards/ids";
import type { CardIdentity, WorkingCardMpcReference } from "../../core/cards/types";
import type { ArtworkProvider } from "../../artwork/types";
import { appDataPaths, originalPathForHash } from "../../artwork/storage/paths";
import { ArtworkCatalog } from "../../artwork/catalog";
import { ArtworkMetadataCache } from "../../artwork/storage/metadata-cache";
import { ArtworkOriginalStore } from "../../artwork/storage/original-store";
import { ArtworkRepository } from "../../artwork/storage/repository";
import { ArtworkThumbnailStore } from "../../artwork/storage/thumbnail-store";
import { MpcArtworkProvider } from "../../artwork/mpc-provider";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const identity: CardIdentity = {
  id: "scryfall:oracle-sol-ring",
  provider: "scryfall",
  name: "Sol Ring",
  oracleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  resolutionMethod: "name",
  confidence: 1,
};

async function setup(fetchImpl: typeof fetch, options: { timeoutMs?: number; maxOriginalBytes?: number } = {}) {
  const base = await mkdtemp(join(tmpdir(), "tcgprint-mpc-provider-"));
  temporaryDirectories.push(base);
  const paths = appDataPaths(base);
  await mkdir(dirname(paths.databaseFile), { recursive: true });
  const database = new Database(paths.databaseFile);
  const repository = new ArtworkRepository(database);
  const originals = new ArtworkOriginalStore(paths.originalsDirectory, repository, { maximumBytes: options.maxOriginalBytes ?? 30 * 1024 * 1024 });
  const thumbnails = new ArtworkThumbnailStore(paths.thumbnailsDirectory, repository);
  const metadata = new ArtworkMetadataCache(repository);
  const createProvider = (fetcher: typeof fetch = fetchImpl) => new MpcArtworkProvider({
    fetchImpl: fetcher,
    originals,
    thumbnails,
    metadata,
    repository,
    timeoutMs: options.timeoutMs ?? 100,
    waitForRetry: async () => undefined,
    ...(options.maxOriginalBytes !== undefined ? { maxOriginalBytes: options.maxOriginalBytes } : {}),
  });
  return { database, provider: createProvider(), createProvider, originals, thumbnails, metadata, repository, paths };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function driveCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifier: "opaque-drive-id_1234567890",
    cardType: "CARD",
    name: "Sol Ring · Synthetic art",
    sourceId: 41,
    sourceType: "Google Drive",
    extension: "png",
    size: 8000,
    dpi: 1200,
    smallThumbnailUrl: "https://drive.google.com/thumbnail?id=opaque-drive-id_1234567890",
    ...overrides,
  };
}

function searchFake(card: Record<string, unknown>, imageFetch?: (url: string) => Promise<Response>, calls: string[] = []): typeof fetch {
  return async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
    if (url.endsWith("/3/editorSearch/")) {
      const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
      return jsonResponse({ results: { [Object.keys(body.queries)[0]]: [card.identifier] } });
    }
    if (url.endsWith("/2/cards/")) return jsonResponse({ results: { [String(card.identifier)]: card } });
    if (imageFetch) return imageFetch(url);
    throw new Error(`Unexpected fake request: ${url}`);
  };
}

function staticProvider(source: "scryfall" | "upload", id: string): ArtworkProvider {
  return {
    source,
    searchArtwork: async () => [{ id, source, identityId: identity.id, faceId: "front", originalAvailable: true }],
    getPreview: async () => undefined,
    getOriginal: async () => { throw new Error("unused"); },
    getCandidate: async () => undefined,
  };
}

describe("MPC artwork provider", () => {
  it.each([75, 501, 1200])("keeps all %i search results in the logical catalog and hydrates in bounded batches", async (count) => {
    const ids = Array.from({ length: count }, (_, index) => `asset_${String(index).padStart(5, "0")}`);
    let activeHydrations = 0;
    let peakHydrations = 0;
    let hydrationBatches = 0;
    let previewOrOriginalDownloads = 0;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/sources/") return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.pathname === "/3/editorSearch/") {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]!]: ids } });
      }
      if (url.pathname === "/2/cards/") {
        hydrationBatches += 1;
        activeHydrations += 1;
        peakHydrations = Math.max(peakHydrations, activeHydrations);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        const records = Object.fromEntries(body.cardIdentifiers.map((identifier) => [identifier, {
          identifier, cardType: "CARD", name: identifier, sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 800,
        }]));
        activeHydrations -= 1;
        return jsonResponse({ results: records });
      }
      previewOrOriginalDownloads += 1;
      throw new Error(`Unexpected non-metadata MPC request: ${url.pathname}`);
    };
    const { database, provider } = await setup(fetchImpl, { timeoutMs: 30_000 });

    const candidates = await provider.searchArtwork(identity);

    expect(candidates).toHaveLength(count);
    expect(candidates[0]?.metadata?.providerRank).toBe(0);
    expect(candidates.at(-1)?.metadata?.providerRank).toBe(count - 1);
    expect(hydrationBatches).toBe(Math.ceil(count / 20));
    expect(peakHydrations).toBeLessThanOrEqual(3);
    expect(previewOrOriginalDownloads).toBe(0);
    const cached = await provider.searchArtwork(identity);
    expect(cached).toHaveLength(count);
    expect(hydrationBatches).toBe(Math.ceil(count / 20));
    database.close();
  }, 30_000);

  it("returns the first MPC gallery page without hydrating the whole catalog", async () => {
    const ids = Array.from({ length: 1200 }, (_, index) => `progressive_${String(index).padStart(4, "0")}`);
    const hydratedIds: string[] = [];
    let searchRequests = 0;
    let hydrationBatches = 0;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/sources/") return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.pathname === "/3/editorSearch/") {
        searchRequests += 1;
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]!]: ids } });
      }
      if (url.pathname === "/2/cards/") {
        hydrationBatches += 1;
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        hydratedIds.push(...body.cardIdentifiers);
        return jsonResponse({ results: Object.fromEntries(body.cardIdentifiers.map((identifier) => [identifier, {
          identifier, cardType: "CARD", name: identifier, sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 800,
          smallThumbnailUrl: `https://drive.google.com/thumbnail?id=${identifier}`,
        }])) });
      }
      throw new Error(`Unexpected MPC request: ${url.pathname}`);
    };
    const { database, provider } = await setup(fetchImpl, { timeoutMs: 30_000 });

    const first = await provider.searchArtworkAdvancedWithTotal(identity, { offset: 0, limit: 20 });
    expect(first.catalogTotal).toBe(1200);
    expect(first.candidates).toHaveLength(20);
    expect(first.candidates[0]?.metadata?.providerRank).toBe(0);
    expect(first.candidates.at(-1)?.metadata?.providerRank).toBe(19);
    expect(hydratedIds).toEqual(ids.slice(0, 20));
    expect(hydrationBatches).toBe(1);
    expect(searchRequests).toBe(1);

    const next = await provider.searchArtworkAdvancedWithTotal(identity, { offset: 20, limit: 60 });
    expect(next.catalogTotal).toBe(1200);
    expect(next.candidates).toHaveLength(60);
    expect(next.candidates[0]?.metadata?.providerRank).toBe(20);
    expect(next.candidates.at(-1)?.metadata?.providerRank).toBe(79);
    expect(hydratedIds).toEqual(ids.slice(0, 80));
    expect(hydrationBatches).toBe(4);
    expect(searchRequests).toBe(1);
    await database.close();
  }, 30_000);

  it("lets a late candidate satisfy whole-catalog filters and outrank the first provider result by reported DPI", async () => {
    const ids = Array.from({ length: 1200 }, (_, index) => `rank_${String(index).padStart(5, "0")}`);
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/sources/") return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.pathname === "/2/languages/") return jsonResponse({ languages: [{ code: "en", name: "English" }] });
      if (url.pathname === "/2/tags/") return jsonResponse({ tags: [{ name: "foil" }] });
      if (url.pathname === "/3/editorSearch/") {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]!]: ids } });
      }
      if (url.pathname === "/2/cards/") {
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        return jsonResponse({ results: Object.fromEntries(body.cardIdentifiers.map((identifier) => [identifier, {
          identifier, cardType: "CARD", name: identifier, sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000,
          dpi: identifier === ids[1199] ? 2400 : 800, language: "en", tags: identifier === ids[1199] ? ["foil"] : [],
        }])) });
      }
      throw new Error(`Unexpected MPC request: ${url.pathname}`);
    };
    const { database, provider } = await setup(fetchImpl, { timeoutMs: 30_000 });

    const ranked = await provider.searchArtworkAdvanced(identity, {
      filters: { maximumDpi: 3000, preferredTags: ["foil"], rankingMode: "balanced" },
    });
    const filtered = await provider.searchArtworkAdvanced(identity, {
      filters: { minimumDpi: 2200, maximumDpi: 3000, includeTags: ["foil"], rankingMode: "balanced" },
    });

    expect(ranked).toHaveLength(1200);
    expect(ranked[0]).toMatchObject({ providerAssetId: ids[1199], metadata: { providerRank: 1199, dpi: 2400 } });
    expect(ranked[1]?.metadata?.providerRank).toBe(0);
    expect(ranked.at(-1)?.metadata?.providerRank).toBe(1198);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ providerAssetId: ids[1199], metadata: { providerRank: 1199, dpi: 2400 } });
    database.close();
  }, 30_000);

  it("lists only MPC endpoint documents hydrated as CARDBACK, never ordinary CARD artwork", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const ids = ["verified-cardback-123", "ordinary-card-asset-456"];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      requests.push({ path: url.pathname, ...(body === undefined ? {} : { body }) });
      if (url.pathname === "/2/sources/") return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.pathname === "/2/cardbacks/") return jsonResponse({ cardbacks: ids });
      if (url.pathname === "/2/cards/") return jsonResponse({ results: {
        [ids[0]!]: { identifier: ids[0], cardType: "CARDBACK", name: "Verified Back", sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 1200 },
        [ids[1]!]: { identifier: ids[1], cardType: "CARD", name: "Ordinary Card", sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 1200 },
      } });
      throw new Error(`Unexpected MPC request: ${url.pathname}`);
    };
    const { database, provider } = await setup(fetchImpl, { timeoutMs: 30_000 });

    const candidates = await provider.searchCardbacks();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "mpc", identityId: null, faceId: "back", providerAssetId: ids[0], metadata: { cardType: "CARDBACK" } });
    expect(requests.map(({ path }) => path)).toEqual(["/2/sources/", "/2/cardbacks/", "/2/cards/"]);
    expect(requests[1]?.body).toMatchObject({ searchSettings: { filterSettings: { maximumSize: 30 } } });
    database.close();
  }, 30_000);

  it("reports the complete CARDBACK catalog total while applying filters and preserving CARDBACK validation", async () => {
    const ids = Array.from({ length: 75 }, (_, index) => `back_asset_${String(index).padStart(3, "0")}`);
    const matchingIds = ids.slice(0, 15);
    let cardHydrationBatches = 0;
    let originalOrPreviewRequests = 0;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/sources/") return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.pathname === "/2/cardbacks/") {
        const body = JSON.parse(String(init.body)) as { searchSettings: { filterSettings: { minimumDPI: number } } };
        return jsonResponse({ cardbacks: body.searchSettings.filterSettings.minimumDPI >= 500 ? matchingIds : ids });
      }
      if (url.pathname === "/2/cards/") {
        cardHydrationBatches += 1;
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        return jsonResponse({ results: Object.fromEntries(body.cardIdentifiers.map((identifier) => [identifier, {
          identifier,
          cardType: "CARDBACK",
          name: identifier,
          sourceId: 41,
          sourceType: "Google Drive",
          extension: "png",
          size: 8000,
          dpi: matchingIds.includes(identifier) ? 800 : 300,
        }])) });
      }
      originalOrPreviewRequests += 1;
      throw new Error(`Unexpected MPC original/preview request: ${url.pathname}`);
    };
    const { database, provider } = await setup(fetchImpl, { timeoutMs: 30_000 });

    const result = await provider.searchCardbacksWithTotal({ filters: { minimumDpi: 500 } });

    expect(result.catalogTotal).toBe(75);
    expect(result.candidates).toHaveLength(15);
    expect(result.candidates.every(({ metadata }) => metadata?.cardType === "CARDBACK")).toBe(true);
    expect(cardHydrationBatches).toBe(5);
    expect(originalOrPreviewRequests).toBe(0);
    await database.close();
  }, 30_000);

  it("aggregates logical provider totals for source=all", async () => {
    const mpc = {
      ...staticProvider("upload", "unused-mpc-source"),
      source: "mpc" as const,
      searchArtworkAdvanced: vi.fn(async () => []),
      searchArtworkAdvancedWithTotal: vi.fn(async () => ({
        candidates: [{ id: "mpc:match", source: "mpc" as const, identityId: identity.id, faceId: "front" as const, originalAvailable: true }],
        catalogTotal: 1200,
      })),
      getFilterCatalogs: async () => ({ sources: [], languages: [], tags: [] }),
      getDiagnostic: () => ({}),
      refreshCandidate: async () => undefined,
    } as unknown as ArtworkProvider;
    const catalog = new ArtworkCatalog([staticProvider("scryfall", "scryfall:one"), staticProvider("upload", "upload:one"), mpc]);

    const result = await catalog.searchWithTotal(identity, { source: "all", faceId: "front" });

    expect(result.catalogTotal).toBe(1202);
    expect(result.candidates.map(({ source }) => source).sort()).toEqual(["mpc", "scryfall", "upload"]);
  });

  it("marks source=all totals partial when one provider cannot supply a catalog", async () => {
    const mpc = {
      ...staticProvider("upload", "unused-mpc-source"),
      source: "mpc" as const,
      searchArtworkAdvanced: vi.fn(async () => []),
      searchArtworkAdvancedWithTotal: vi.fn(async () => ({ candidates: [], catalogTotal: 1200 })),
      getFilterCatalogs: async () => ({ sources: [], languages: [], tags: [] }),
      getDiagnostic: () => ({}),
      refreshCandidate: async () => undefined,
    } as unknown as ArtworkProvider;
    const unavailableScryfall = {
      ...staticProvider("scryfall", "scryfall:unavailable"),
      searchArtwork: async () => { throw new Error("provider offline"); },
    } as ArtworkProvider;
    const catalog = new ArtworkCatalog([unavailableScryfall, staticProvider("upload", "upload:one"), mpc]);

    const result = await catalog.searchWithTotal(identity, { source: "all", faceId: "front" });

    expect(result.catalogTotal).toBe(1201);
    expect(result.catalogTotalComplete).toBe(false);
  });

  it("sends selected filters to the cardback endpoint and retains only matching hydrated results", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const ids = ["eligible-cardback-123", "low-dpi-cardback-123", "wrong-tag-cardback-123"];
    const records = [
      { identifier: ids[0], cardType: "CARDBACK", name: "Holographic Back", sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 900, language: "en", tags: ["Holographic"] },
      { identifier: ids[1], cardType: "CARDBACK", name: "Low DPI Back", sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 300, language: "en", tags: ["Holographic"] },
      { identifier: ids[2], cardType: "CARDBACK", name: "Wrong Tag Back", sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 900, language: "en", tags: ["Foil"] },
    ];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      requests.push({ path: url.pathname, ...(body === undefined ? {} : { body }) });
      if (url.pathname === "/2/sources/") return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.pathname === "/2/languages/") return jsonResponse({ languages: [{ code: "en", name: "English" }] });
      if (url.pathname === "/2/tags/") return jsonResponse({ tags: [{ name: "Holographic" }, { name: "Foil" }] });
      if (url.pathname === "/2/cardbacks/") return jsonResponse({ cardbacks: ids });
      if (url.pathname === "/2/cards/") return jsonResponse({ results: Object.fromEntries(records.map((item) => [item.identifier, item])) });
      throw new Error(`Unexpected fake request: ${url.pathname}`);
    };
    const { database, provider } = await setup(fetchImpl, { timeoutMs: 30_000 });

    const candidates = await provider.searchCardbacks({ filters: {
      minimumDpi: 600,
      maximumDpi: 1200,
      sources: [41],
      includeTags: ["Holographic"],
      languages: ["en"],
    } });

    expect(requests.find(({ path }) => path === "/2/cardbacks/")?.body).toMatchObject({ searchSettings: {
      filterSettings: {
        minimumDPI: 600,
        maximumDPI: 1200,
        includesTags: ["Holographic"],
        excludesTags: [],
        languages: ["en"],
      },
      searchTypeSettings: { fuzzySearch: false, filterCardbacks: true },
      sourceSettings: { sources: [[41, true]] },
    } });
    expect(candidates.map(({ providerAssetId }) => providerAssetId)).toEqual([ids[0]]);
    database.close();
  });

  it("keeps a 1200 item cardback catalog complete while validating every hydrated record as CARDBACK", async () => {
    const ids = Array.from({ length: 1200 }, (_, index) => `cardback-${String(index).padStart(4, "0")}-asset`);
    const hydratedIds: string[] = [];
    let batches = 0;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/sources/") return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.pathname === "/2/cardbacks/") return jsonResponse({ cardbacks: ids });
      if (url.pathname === "/2/cards/") {
        batches += 1;
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        hydratedIds.push(...body.cardIdentifiers);
        return jsonResponse({ results: Object.fromEntries(body.cardIdentifiers.map((identifier) => [identifier, {
          identifier, cardType: "CARDBACK", name: "Bounded Back", sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 1200,
        }])) });
      }
      throw new Error(`Unexpected fake request: ${url.pathname}`);
    };
    const { database, provider } = await setup(fetchImpl, { timeoutMs: 30_000 });

    const candidates = await provider.searchCardbacks();

    expect(candidates).toHaveLength(1200);
    expect(hydratedIds).toEqual(ids);
    expect(batches).toBe(60);
    expect(candidates.every(({ metadata }) => metadata?.cardType === "CARDBACK")).toBe(true);
    database.close();
  }, 30_000);

  it("uses the legacy query-array contract only after v3 returns 404", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      requests.push({ url, method: init.method ?? "GET", ...(body === undefined ? {} : { body }) });
      if (url.endsWith("/2/sources/")) {
        return jsonResponse({ results: { "41": { pk: 41, name: "Verified Drive source", sourceType: "Google Drive" } } });
      }
      if (url.endsWith("/3/editorSearch/")) return new Response("route missing", { status: 404 });
      if (url.endsWith("/2/editorSearch/")) {
        return jsonResponse({ results: { "Sol Ring": { CARD: ["opaque-drive-id_1234567890"] } } });
      }
      if (url.endsWith("/2/cards/")) {
        return jsonResponse({ results: {
          "opaque-drive-id_1234567890": {
            identifier: "opaque-drive-id_1234567890",
            cardType: "CARD",
            name: "Sol Ring · Community frame",
            sourceId: 41,
            sourceType: "Google Drive",
            extension: "png",
            size: 8000,
            dpi: 1200,
            smallThumbnailUrl: "https://drive.google.com/thumbnail?id=opaque-drive-id_1234567890",
            mediumThumbnailUrl: "https://drive.google.com/thumbnail?id=opaque-drive-id_1234567890",
          },
        } });
      }
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    const candidates = await provider.searchArtwork(identity);

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/2/sources/",
      "/3/editorSearch/",
      "/2/editorSearch/",
      "/2/cards/",
    ]);
    expect((requests[1].body as { queries: unknown }).queries).toEqual(expect.objectContaining({}));
    expect((requests[2].body as { queries: unknown }).queries).toEqual([{ query: "Sol Ring", cardType: "CARD" }]);
    expect(candidates).toMatchObject([{
      source: "mpc",
      identityId: identity.id,
      faceId: "front",
      providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "opaque-drive-id_1234567890",
      originalAvailable: true,
      metadata: { name: "Sol Ring · Community frame", sourceType: "Google Drive", dpi: 1200 },
    }]);
    expect(candidates[0].effectiveDpi).toBeUndefined();
    expect(candidates[0].id).toMatch(/^mpc:[a-f0-9]{64}$/);
    database.close();
  });

  it.each(["webp", "gif"])("does not list %s MPC originals that the current PDF exporter cannot encode", async (extension) => {
    const { database, provider } = await setup(searchFake(driveCard({ extension })));

    await expect(provider.searchArtwork(identity)).resolves.toEqual([]);
    expect(provider.getHealth()).toMatchObject({ available: true, degraded: false });
    database.close();
  });

  it.each(["png", "jpg", "jpeg"])("lists %s MPC originals supported by the current export policy", async (extension) => {
    const { database, provider } = await setup(searchFake(driveCard({ extension })));

    await expect(provider.searchArtwork(identity)).resolves.toMatchObject([{ metadata: { extension }, originalAvailable: true }]);
    database.close();
  });

  it("lists MPC SVGs as unverified instead of claiming PDF exportability from the extension", async () => {
    const { database, provider } = await setup(searchFake(driveCard({ extension: "svg" })));

    const [candidate] = await provider.searchArtwork(identity);
    const refreshed = await provider.getCandidate(candidate.id);

    expect(candidate).toMatchObject({ originalAvailable: true, metadata: { extension: "svg", originalFormatKnown: true } });
    expect(candidate.metadata?.originalFormatExportable).toBeUndefined();
    expect(refreshed?.metadata?.originalFormatExportable).toBeUndefined();
    database.close();
  });

  it("keeps a candidate with unknown remote format metadata until downloaded bytes are validated", async () => {
    const webp = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#496" } }).webp().toBuffer());
    const fetchImpl = searchFake(driveCard({ extension: undefined, size: webp.byteLength }), async (url) => {
      if (url.includes("/uc?")) return new Response(webp, { headers: { "Content-Type": "image/webp", "Content-Length": String(webp.byteLength) } });
      throw new Error(`Unexpected MPC image request: ${url}`);
    });
    const { database, provider, repository } = await setup(fetchImpl);
    const [candidate] = await provider.searchArtwork(identity);

    expect(candidate).toMatchObject({ originalAvailable: true, metadata: { originalFormatKnown: false } });
    await expect(provider.getOriginal(candidate.id)).rejects.toMatchObject({ name: "MpcArtworkProviderError", kind: "unsupported-format" });
    expect(repository.findOriginalByProviderSource("mpc", "opaque-drive-id_1234567890", "https://drive.google.com/uc?export=download&id=opaque-drive-id_1234567890")).toBeUndefined();
    database.close();
  });

  it("accepts PNG bytes when the MPC original format metadata is unknown", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#496" } }).png().toBuffer());
    const fetchImpl = searchFake(driveCard({ extension: undefined, size: png.byteLength }), async (url) => {
      if (url.includes("/uc?")) return new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": String(png.byteLength) } });
      throw new Error(`Unexpected MPC image request: ${url}`);
    });
    const { database, provider } = await setup(fetchImpl);
    const [candidate] = await provider.searchArtwork(identity);
    const original = await provider.getOriginal(candidate.id);

    expect(original).toMatchObject({ format: "png", extension: "png", bytes: png });
    expect(await provider.getCandidate(candidate.id)).toMatchObject({ originalAvailable: true, originalCached: true, metadata: { extension: "png", originalFormatKnown: true, originalFormatExportable: true } });
    database.close();
  });

  it("accepts a JPEG MPC original with matching format metadata", async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#496" } }).jpeg().toBuffer());
    const { database, provider } = await setup(searchFake(driveCard({ extension: "jpg", size: jpeg.byteLength }), async () => new Response(jpeg, {
      headers: { "Content-Type": "image/jpeg", "Content-Length": String(jpeg.byteLength) },
    })));
    const [candidate] = await provider.searchArtwork(identity);

    await expect(provider.getOriginal(candidate.id)).resolves.toMatchObject({ format: "jpeg", extension: "jpg", bytes: jpeg });
    await expect(provider.getCandidate(candidate.id)).resolves.toMatchObject({ metadata: { originalFormatExportable: true } });
    await database.close();
  });

  it("accepts a WebP thumbnail when the declared original is PNG", async () => {
    const webp = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#496" } }).webp().toBuffer());
    const fetchImpl = searchFake(driveCard({ extension: "png" }), async () => new Response(webp, { headers: { "Content-Type": "image/webp" } }));
    const { database, provider } = await setup(fetchImpl);
    const [candidate] = await provider.searchArtwork(identity);
    const preview = await provider.getPreview(candidate.id);

    expect(candidate.metadata).toMatchObject({ extension: "png" });
    expect(preview).toMatchObject({ contentType: "image/webp" });
    database.close();
  });

  it.each(["missing", "corrupt"] as const)("reports a %s local original when expired MPC metadata cannot be revalidated offline", async (fileState) => {
    const baseTime = Date.now();
    const originalBytes = new Uint8Array(await sharp({ create: { width: 80, height: 120, channels: 3, background: "#537799" } }).png().toBuffer());
    const assetId = "opaque-drive-id_1234567890";
    let online = true;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      if (!online) throw new Error("MPC offline");
      return searchFake(driveCard({ identifier: assetId, extension: "png", size: originalBytes.byteLength }), async (url) => {
        if (url.includes("/uc?")) return new Response(originalBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(originalBytes.byteLength) } });
        throw new Error(`Unexpected MPC image request: ${url}`);
      })(input, init);
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime));
    const { database, provider, paths } = await setup(fetchImpl);
    try {
      const [candidate] = await provider.searchArtwork(identity);
      const original = await provider.getOriginal(candidate.id);
      const path = originalPathForHash(paths.originalsDirectory, original.contentHash, original.extension);
      if (fileState === "missing") await unlink(path);
      else await writeFile(path, new Uint8Array([1, 2, 3, 4]));

      vi.setSystemTime(new Date(baseTime + 366 * 24 * 60 * 60 * 1000));
      online = false;
      await expect(provider.getCandidateForReferences(candidate.id, [{
        faceId: "front",
        importedAssetId: assetId,
        providerAssetId: assetId,
        selectedArtworkId: assetId,
        referenceOrigin: "gallery-selection",
        slots: [],
        availableLocally: false,
      }], identity)).rejects.toMatchObject({
        name: "MpcArtworkProviderError",
        kind: "network",
        message: expect.stringContaining(fileState === "missing" ? "ARTWORK_MISSING" : "ARTWORK_CONTENT_CORRUPT"),
      });
    } finally {
      vi.useRealTimers();
      database.close();
    }
  });

  it("uses the v3 object-map schema first and derives stable candidate IDs from opaque IDs", async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, ...(body ? { body } : {}) });
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: {
        "41": { pk: 41, sourceType: "Google Drive" },
        "42": { pk: 42, sourceType: "HTTP" },
      } });
      if (url.endsWith("/3/editorSearch/")) {
        const queries = body?.queries as Record<string, { query: string; cardType: string }>;
        const [hash, query] = Object.entries(queries)[0];
        expect(hash).toBe("1094235669");
        expect(query).toEqual({ query: "Sol Ring", cardType: "CARD" });
        return jsonResponse({ results: { [hash]: ["opaque-drive-id_1234567890"] } });
      }
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: {
        "opaque-drive-id_1234567890": {
          identifier: "opaque-drive-id_1234567890", cardType: "CARD", name: "Sol Ring",
          sourceId: 41, sourceType: "Google Drive", extension: "png", size: 8000, dpi: 1200,
          smallThumbnailUrl: "https://drive.google.com/thumbnail?id=opaque-drive-id_1234567890",
        },
      } });
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    const candidates = await provider.searchArtwork(identity);
    const v3Request = requests.find(({ url }) => url.endsWith("/3/editorSearch/"))!;
    const settings = v3Request.body?.searchSettings as { sourceSettings: { sources: number[][] } };

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual(["/2/sources/", "/3/editorSearch/", "/2/cards/"]);
    expect(settings.sourceSettings.sources).toEqual([[41, true]]);
    expect(candidates[0].id).toBe(mpcArtworkCandidateId("opaque-drive-id_1234567890", "front"));
    expect((await provider.searchArtwork(identity))[0].id).toBe(candidates[0].id);
    expect(requests).toHaveLength(3);
    database.close();
  });

  it("treats a valid empty search result as success without card hydration", async () => {
    let searchCalls = 0;
    let cardCalls = 0;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        searchCalls += 1;
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]]: [] } });
      }
      if (url.endsWith("/2/cards/")) { cardCalls += 1; throw new Error("empty search should not hydrate cards"); }
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    await expect(provider.searchArtwork(identity)).resolves.toEqual([]);
    await expect(provider.searchArtwork(identity)).resolves.toEqual([]);
    expect(searchCalls).toBe(1);
    expect(cardCalls).toBe(0);
    expect(provider.getHealth()).toMatchObject({ available: true, degraded: false });
    database.close();
  });

  it("treats a malformed successful search envelope as protocol degradation and does not cache it empty", async () => {
    let malformed = true;
    let searchCalls = 0;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        searchCalls += 1;
        if (malformed) return jsonResponse({ results: {} });
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]]: ["opaque-drive-id_1234567890"] } });
      }
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: { "opaque-drive-id_1234567890": driveCard() } });
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    await expect(provider.searchArtwork(identity)).rejects.toMatchObject({ kind: "protocol" });
    expect(provider.getHealth()).toMatchObject({ available: false, degraded: true });
    malformed = false;
    await expect(provider.searchArtwork(identity)).resolves.toHaveLength(1);
    expect(searchCalls).toBe(2);
    database.close();
  });

  it("treats malformed successful card hydration as protocol degradation instead of an empty result", async () => {
    let malformed = true;
    let hydrationCalls = 0;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]]: ["opaque-drive-id_1234567890"] } });
      }
      if (url.endsWith("/2/cards/")) {
        hydrationCalls += 1;
        return malformed ? jsonResponse({ documents: [] }) : jsonResponse({ results: { "opaque-drive-id_1234567890": driveCard() } });
      }
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    await expect(provider.searchArtwork(identity)).rejects.toMatchObject({ kind: "protocol" });
    expect(provider.getHealth()).toMatchObject({ available: false, degraded: true });
    malformed = false;
    await expect(provider.searchArtwork(identity)).resolves.toHaveLength(1);
    expect(hydrationCalls).toBe(2);
    database.close();
  });

  it("rejects extra hydrated artwork IDs not submitted in the search request", async () => {
    const requestedId = "requested-drive-id-123456";
    const extraId = "extra-drive-id-123456789";
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]]: [requestedId] } });
      }
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: {
        [requestedId]: driveCard({ identifier: requestedId }),
        [extraId]: driveCard({ identifier: extraId }),
      } });
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    await expect(provider.searchArtwork(identity)).rejects.toMatchObject({ kind: "protocol" });
    expect(provider.getHealth()).toMatchObject({ available: false, degraded: true });
    database.close();
  });

  it("rejects hydrated documents without an explicit cardType", async () => {
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]]: ["opaque-drive-id_1234567890"] } });
      }
      if (url.endsWith("/2/cards/")) {
        const { cardType: _cardType, ...card } = driveCard();
        return jsonResponse({ results: { "opaque-drive-id_1234567890": card } });
      }
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    await expect(provider.searchArtwork(identity)).resolves.toEqual([]);
    expect(provider.getHealth()).toMatchObject({ available: false, degraded: true });
    database.close();
  });

  it("degrades when reference hydration omits the selected ID from a successful response", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: {} });
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);
    const reference: WorkingCardMpcReference = {
      faceId: "front", importedAssetId: "xml-missing-card", providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "opaque-drive-id_1234567890", slots: [], availableLocally: false,
    };

    await expect(provider.getCandidateForReferences(mpcArtworkCandidateId("xml-missing-card", "front"), [reference], identity))
      .rejects.toMatchObject({ kind: "protocol" });
    expect(provider.getHealth()).toMatchObject({ available: false, degraded: true });
    database.close();
  });

  it("rejects a hydrated document whose source ID is absent from the verified source map", async () => {
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]]: ["opaque-drive-id_1234567890"] } });
      }
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: {
        "opaque-drive-id_1234567890": driveCard({ sourceId: 999 }),
      } });
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    await expect(provider.searchArtwork(identity)).resolves.toEqual([]);
    expect(provider.getHealth()).toMatchObject({ available: false, degraded: true });
    const reference: WorkingCardMpcReference = {
      faceId: "front", importedAssetId: "xml-invalid-source", providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "opaque-drive-id_1234567890", slots: [], availableLocally: false,
    };
    await expect(provider.getCandidateForReferences(mpcArtworkCandidateId("xml-invalid-source", "front"), [reference], identity))
      .rejects.toMatchObject({ kind: "unsafe-source" });
    database.close();
  });

  it("does not use v2 when v3 fails with anything other than 404", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(new URL(url).pathname);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) return jsonResponse({ error: "invalid request" }, 400);
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    await expect(provider.searchArtwork(identity)).rejects.toMatchObject({ kind: "http", status: 400 });

    expect(requests).toEqual(["/2/sources/", "/3/editorSearch/"]);
    database.close();
  });

  it("fetches thumbnails separately, downloads originals lazily, and stores byte-hash provenance", async () => {
    const originalBytes = new Uint8Array(await sharp({ create: { width: 1200, height: 1680, channels: 3, background: "#336699" } }).png().toBuffer());
    const thumbnailBytes = new Uint8Array(await sharp({ create: { width: 120, height: 168, channels: 3, background: "#993366" } }).png().toBuffer());
    const imageRequests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]]: ["opaque-drive-id_1234567890"] } });
      }
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: {
        "opaque-drive-id_1234567890": {
          identifier: "opaque-drive-id_1234567890", cardType: "CARD", name: "Sol Ring", sourceId: 41,
          sourceType: "Google Drive", extension: "png", size: originalBytes.byteLength, dpi: 1200,
          smallThumbnailUrl: "https://drive.google.com/thumbnail?id=opaque-drive-id_1234567890",
        },
      } });
      imageRequests.push(url);
      if (url.includes("drive.google.com/thumbnail")) return new Response(null, { status: 302, headers: { Location: "https://lh3.googleusercontent.com/thumbnail.png" } });
      if (url.startsWith("https://lh3.googleusercontent.com/")) return new Response(thumbnailBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(thumbnailBytes.byteLength) } });
      if (url.startsWith("https://drive.google.com/uc?")) return new Response(null, { status: 302, headers: { Location: "https://drive.usercontent.google.com/download?id=opaque-drive-id_1234567890" } });
      if (url.startsWith("https://drive.usercontent.google.com/download")) return new Response(originalBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(originalBytes.byteLength) } });
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider, createProvider } = await setup(fetchImpl);

    const [candidate] = await provider.searchArtwork(identity);
    expect(candidate.originalAvailable).toBe(true);
    expect(candidate.originalCached).toBe(false);
    expect(imageRequests).toEqual([]);
    const preview = await provider.getPreview(candidate.id);
    expect(preview?.bytes).toEqual(thumbnailBytes);
    expect(imageRequests).toHaveLength(2);
    expect(imageRequests[0]).toContain("drive.google.com/thumbnail");
    expect(imageRequests[1]).toContain("lh3.googleusercontent.com/thumbnail.png");
    expect(imageRequests[0]).not.toContain("/uc?");

    const original = await provider.getOriginal(candidate.id);
    const secondOriginal = await provider.getOriginal(candidate.id);
    expect(original.bytes).toEqual(originalBytes);
    expect(secondOriginal.bytes).toEqual(originalBytes);
    expect(original.contentHash).toBe(createHash("sha256").update(originalBytes).digest("hex"));
    expect(original.provenance).toContainEqual(expect.objectContaining({
      provider: "mpc",
      providerAssetId: "opaque-drive-id_1234567890",
      contentType: "image/png",
      importMetadata: expect.objectContaining({ faceId: "front", sourceType: "Google Drive" }),
    }));
    expect(imageRequests.filter((url) => url.includes("/uc?") || url.includes("drive.usercontent.google.com"))).toHaveLength(2);
    expect(await provider.getCandidate(candidate.id)).toMatchObject({ widthPx: 1200, heightPx: 1680, originalAvailable: true, originalCached: true });
    await expect(provider.searchArtwork(identity)).resolves.toMatchObject([{ id: candidate.id, originalCached: true }]);

    const offline = createProvider(async () => { throw new Error("offline cache should satisfy this request"); });
    expect(await offline.searchArtwork(identity)).toMatchObject([{ id: candidate.id }]);
    expect(await offline.getPreview(candidate.id)).toMatchObject({ bytes: thumbnailBytes });
    expect(await offline.getOriginal(candidate.id)).toMatchObject({ bytes: originalBytes });
    expect(imageRequests).toHaveLength(4);
    database.close();
  });

  it.each(["missing", "corrupt"] as const)("does not report a %s content-addressed file as cached", async (fileState) => {
    const originalBytes = new Uint8Array(await sharp({ create: { width: 80, height: 120, channels: 3, background: "#445577" } }).png().toBuffer());
    const fetchImpl = searchFake(driveCard({ size: originalBytes.byteLength }), async (url) => {
      if (url.includes("/uc?")) return new Response(originalBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(originalBytes.byteLength) } });
      throw new Error(`Unexpected image fetch: ${url}`);
    });
    const { database, provider, createProvider, originals, paths } = await setup(fetchImpl);
    const [candidate] = await provider.searchArtwork(identity);
    const original = await provider.getOriginal(candidate.id);
    const originalPath = originalPathForHash(paths.originalsDirectory, original.contentHash, original.extension);
    if (fileState === "missing") await unlink(originalPath);
    else await writeFile(originalPath, new Uint8Array(original.bytes.byteLength).fill(0));
    const restartedProvider = createProvider();
    const candidateAfterRestart = await restartedProvider.getCandidate(candidate.id);

    expect(candidateAfterRestart).toMatchObject({ originalAvailable: true, originalCached: false });
    expect(restartedProvider.getHealth()).toMatchObject({ available: false, degraded: true });
    database.close();
  });

  it.each(["missing", "corrupt"] as const)("withholds SVG exportability when a previously validated original is %s, including cached references", async (fileState) => {
    const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140" viewBox="0 0 100 140"><rect width="100" height="140" fill="#123456"/></svg>');
    const fetchImpl = searchFake(driveCard({ extension: "svg", size: svgBytes.byteLength }), async () => new Response(svgBytes, {
      headers: { "Content-Type": "image/svg+xml", "Content-Length": String(svgBytes.byteLength) },
    }));
    const { database, provider, paths } = await setup(fetchImpl);
    try {
      const [candidate] = await provider.searchArtwork(identity);
      const original = await provider.getOriginal(candidate.id);
      const reference: WorkingCardMpcReference = {
        faceId: "front",
        importedAssetId: "xml-stale-svg-original",
        providerAssetId: candidate.providerAssetId!,
        selectedArtworkId: candidate.selectedArtworkId!,
        slots: ["1"],
        availableLocally: true,
      };
      const importedCandidateId = mpcArtworkCandidateId(reference.importedAssetId, "front");

      await expect(provider.getCandidateForReferences(importedCandidateId, [reference], identity))
        .resolves.toMatchObject({ originalCached: true, metadata: { originalFormatExportable: true } });
      const originalPath = originalPathForHash(paths.originalsDirectory, original.contentHash, original.extension);
      if (fileState === "missing") await unlink(originalPath);
      else await writeFile(originalPath, new Uint8Array(original.bytes.byteLength).fill(0));

      const directCandidate = await provider.getCandidate(candidate.id);
      const importedCandidate = await provider.getCandidateForReferences(importedCandidateId, [reference], identity);
      for (const refreshed of [directCandidate, importedCandidate]) {
        expect(refreshed).toMatchObject({ originalAvailable: true, originalCached: false });
        expect(refreshed?.metadata?.originalFormatExportable).toBeUndefined();
        expect(refreshed?.metadata).not.toHaveProperty("svgPdfValidationVersion");
      }

      await expect(provider.getOriginal(importedCandidateId)).resolves.toMatchObject({ bytes: svgBytes, extension: "svg" });
      await expect(provider.getCandidate(importedCandidateId)).resolves.toMatchObject({
        originalAvailable: true,
        originalCached: true,
        metadata: { originalFormatExportable: true },
      });
    } finally {
      await database.close();
    }
  });

  it("does not trust an unverified imported local-availability hint as a cached original", async () => {
    const { database, provider } = await setup(async () => { throw new Error("offline"); });
    const reference: WorkingCardMpcReference = {
      faceId: "front", importedAssetId: "xml-local-hint", providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "opaque-drive-id_1234567890", slots: ["1"], availableLocally: true,
    };

    const [candidate] = await provider.searchArtwork(identity, { mpcReferences: [reference] });
    expect(candidate).toMatchObject({ originalAvailable: false, originalCached: false });
    expect(provider.getHealth()).toMatchObject({ available: false, degraded: true });
    database.close();
  });

  it.each(["missing", "corrupt"] as const)("rehydrates and repairs an imported MPC original whose local file is %s", async (fileState) => {
    const originalBytes = new Uint8Array(await sharp({ create: { width: 120, height: 168, channels: 3, background: "#537799" } }).png().toBuffer());
    const requests: string[] = [];
    const fetchImpl = searchFake(driveCard({ size: originalBytes.byteLength }), async (url) => {
      requests.push(url);
      if (url.includes("/uc?")) return new Response(originalBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(originalBytes.byteLength) } });
      throw new Error(`Unexpected image fetch: ${url}`);
    });
    const { database, provider, originals, paths } = await setup(fetchImpl);
    const [onlineCandidate] = await provider.searchArtwork(identity);
    const original = await provider.getOriginal(onlineCandidate.id);
    const originalPath = originalPathForHash(paths.originalsDirectory, original.contentHash, original.extension);
    if (fileState === "missing") await unlink(originalPath);
    else await writeFile(originalPath, new Uint8Array(original.bytes.byteLength).fill(0));
    const reference: WorkingCardMpcReference = {
      faceId: "front",
      importedAssetId: `xml-${fileState}-original`,
      providerAssetId: onlineCandidate.providerAssetId!,
      selectedArtworkId: onlineCandidate.selectedArtworkId!,
      slots: ["1", "2"],
      availableLocally: true,
    };
    const importedCandidateId = mpcArtworkCandidateId(reference.importedAssetId, "front");

    const candidate = await provider.getCandidateForReferences(importedCandidateId, [reference], identity);

    expect(candidate).toMatchObject({
      id: importedCandidateId,
      providerAssetId: onlineCandidate.providerAssetId,
      selectedArtworkId: onlineCandidate.selectedArtworkId,
      originalAvailable: true,
      originalCached: false,
      metadata: { referenceOnly: true, localAvailabilityHint: true, slots: ["1", "2"] },
    });
    const recovered = await provider.getOriginal(importedCandidateId);
    expect(recovered.bytes).toEqual(originalBytes);
    expect(await provider.getCandidate(importedCandidateId)).toMatchObject({ originalAvailable: true, originalCached: true });
    expect(requests.filter((url) => url.includes("/uc?")).length).toBeGreaterThanOrEqual(2);
    expect(await originals.getOriginal(original.contentHash)).toMatchObject({ bytes: originalBytes });
    database.close();
  });

  it("hydrates an imported XML reference by its preserved provider ID without searching the gallery", async () => {
    const originalBytes = new Uint8Array(await sharp({ create: { width: 1200, height: 1680, channels: 3, background: "#447755" } }).png().toBuffer());
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: {
        "opaque-drive-id_1234567890": {
          identifier: "opaque-drive-id_1234567890", cardType: "CARD", name: "Sol Ring · Imported choice", sourceId: 41, sourceType: "Google Drive",
          extension: "png", size: originalBytes.byteLength, dpi: 1200,
          smallThumbnailUrl: "https://drive.google.com/thumbnail?id=opaque-drive-id_1234567890",
        },
      } });
      if (url.startsWith("https://drive.google.com/uc?")) return new Response(null, { status: 302, headers: { Location: "https://drive.usercontent.google.com/download?id=opaque-drive-id_1234567890" } });
      if (url.startsWith("https://drive.usercontent.google.com/download")) return new Response(originalBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(originalBytes.byteLength) } });
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);
    const reference: WorkingCardMpcReference = {
      faceId: "front",
      importedAssetId: "internal-xml-import-id",
      providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "synthetic-selected-artwork-id",
      slots: ["1", "2"],
      availableLocally: true,
    };
    const importedCandidateId = mpcArtworkCandidateId(reference.importedAssetId, "front");

    const candidate = await provider.getCandidateForReferences(importedCandidateId, [reference], identity);
    const exportedOriginal = await provider.getOriginal(importedCandidateId);

    expect(candidate).toMatchObject({
      id: importedCandidateId,
      providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "synthetic-selected-artwork-id",
      originalAvailable: true,
      originalCached: false,
      metadata: { importedAssetId: "internal-xml-import-id", slots: ["1", "2"], sourceType: "Google Drive", localAvailabilityHint: true },
    });
    expect(exportedOriginal.bytes).toEqual(originalBytes);
    expect(requests.map((url) => new URL(url).pathname)).toEqual(["/2/sources/", "/2/cards/", "/uc", "/download"]);
    expect(requests.some((url) => url.includes("editorSearch"))).toBe(false);
    expect(await provider.getCandidate(importedCandidateId)).toMatchObject({ selectedArtworkId: "synthetic-selected-artwork-id", originalAvailable: true, originalCached: true });
    database.close();
  });

  it("propagates cancellation instead of returning an imported-reference fallback", async () => {
    const fetchImpl: typeof fetch = async () => { throw new Error("pre-aborted lookup must not fetch"); };
    const { database, provider } = await setup(fetchImpl);
    const reference: WorkingCardMpcReference = {
      faceId: "front", importedAssetId: "xml-cancel-id", providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "opaque-drive-id_1234567890", slots: ["1"], availableLocally: false,
    };
    const controller = new AbortController();
    controller.abort();

    await expect(provider.searchArtwork(identity, { faceId: "front", mpcReferences: [reference], signal: controller.signal }))
      .rejects.toMatchObject({ kind: "aborted" });
    expect(provider.getHealth()).toMatchObject({ available: true, degraded: false });
    database.close();
  });

  it("propagates in-flight cancellation while hydrating an imported XML reference", async () => {
    let requestCardsStarted!: () => void;
    const cardsStarted = new Promise<void>((resolve) => { requestCardsStarted = resolve; });
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/2/cards/")) {
        requestCardsStarted();
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);
    const reference: WorkingCardMpcReference = {
      faceId: "front", importedAssetId: "xml-in-flight-cancel", providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "opaque-drive-id_1234567890", slots: ["1"], availableLocally: false,
    };
    const controller = new AbortController();

    try {
      const pending = provider.searchArtwork(identity, { faceId: "front", mpcReferences: [reference], signal: controller.signal });
      await cardsStarted;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ kind: "aborted" });
      expect(provider.getHealth()).toMatchObject({ available: true, degraded: false });
    } finally {
      database.close();
    }
  });

  it("shows an imported reference in the gallery without searching custom identities", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: {
        "opaque-drive-id_1234567890": driveCard(),
      } });
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);
    const reference: WorkingCardMpcReference = {
      faceId: "front", importedAssetId: "xml-import-id", providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "opaque-drive-id_1234567890", slots: ["1"], availableLocally: false,
    };
    const customIdentity: CardIdentity = { id: "custom:artwork-picker", provider: "local", name: "Artwork library", resolutionMethod: "custom", confidence: 0 };

    const candidates = await provider.searchArtwork(customIdentity, { faceId: "front", mpcReferences: [reference] });

    expect(candidates).toMatchObject([{
      id: mpcArtworkCandidateId("xml-import-id", "front"),
      identityId: customIdentity.id,
      providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "opaque-drive-id_1234567890",
      originalAvailable: true,
      previewUri: "https://drive.google.com/thumbnail?id=opaque-drive-id_1234567890",
    }]);
    const updatedHint = await provider.searchArtwork(customIdentity, { faceId: "front", mpcReferences: [{ ...reference, availableLocally: true }] });
    expect(updatedHint[0]).toMatchObject({ originalCached: false, metadata: { localAvailabilityHint: true } });
    expect(requests.map((url) => new URL(url).pathname)).toEqual(["/2/sources/", "/2/cards/"]);
    database.close();
  });

  it("keeps an imported MPC reference visible when online search is degraded", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(new URL(url).pathname);
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: { "opaque-drive-id_1234567890": driveCard() } });
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) return jsonResponse({ error: "offline" }, 503);
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);
    const reference: WorkingCardMpcReference = {
      faceId: "front", importedAssetId: "xml-import-id", providerAssetId: "opaque-drive-id_1234567890",
      selectedArtworkId: "opaque-drive-id_1234567890", slots: ["1"], availableLocally: false,
    };

    const candidates = await provider.searchArtwork(identity, { faceId: "front", mpcReferences: [reference] });

    expect(candidates).toMatchObject([{ id: mpcArtworkCandidateId("xml-import-id", "front"), originalAvailable: true }]);
    expect(provider.getHealth()).toMatchObject({ available: false, degraded: true });
    expect(requests).toEqual(["/2/sources/", "/2/cards/", "/3/editorSearch/", "/3/editorSearch/", "/3/editorSearch/"]);
    database.close();
  });

  it("rejects unsupported MPC source types while hydrating XML references", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (String(input).endsWith("/2/cards/")) return jsonResponse({ results: { "opaque-drive-id_1234567890": driveCard({ sourceType: "Dropbox" }) } });
      throw new Error(`Unexpected fake request: ${String(input)}`);
    };
    const { database, provider } = await setup(fetchImpl);
    const reference: WorkingCardMpcReference = { faceId: "front", importedAssetId: "xml-ref", providerAssetId: "opaque-drive-id_1234567890", selectedArtworkId: "opaque-drive-id_1234567890", slots: [], availableLocally: false };

    await expect(provider.getCandidateForReferences(mpcArtworkCandidateId("xml-ref", "front"), [reference], identity))
      .rejects.toMatchObject({ kind: "unsafe-source" });
    database.close();
  });

  it("rejects unsafe opaque IDs before making a hydration or download URL", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => { requests.push(String(input)); throw new Error("should not fetch"); };
    const { database, provider } = await setup(fetchImpl);
    const reference: WorkingCardMpcReference = { faceId: "front", importedAssetId: "xml-ref", providerAssetId: "../private/file", selectedArtworkId: "../private/file", slots: [], availableLocally: false };

    await expect(provider.getCandidateForReferences(mpcArtworkCandidateId("xml-ref", "front"), [reference], identity))
      .rejects.toMatchObject({ kind: "unsafe-source" });
    expect(requests).toEqual([]);
    database.close();
  });

  it("does not accept a thumbnail CDN redirect as the original artwork", async () => {
    const originalBytes = new Uint8Array(await sharp({ create: { width: 120, height: 168, channels: 3, background: "#315" } }).png().toBuffer());
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]]: ["opaque-drive-id_1234567890"] } });
      }
      if (url.endsWith("/2/cards/")) return jsonResponse({ results: {
        "opaque-drive-id_1234567890": driveCard({ size: originalBytes.byteLength }),
      } });
      if (url.startsWith("https://drive.google.com/uc?")) return new Response(null, { status: 302, headers: { Location: "https://lh3.googleusercontent.com/thumbnail.png" } });
      if (url.startsWith("https://lh3.googleusercontent.com/")) return new Response(originalBytes, { headers: { "Content-Type": "image/png", "Content-Length": String(originalBytes.byteLength) } });
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);
    const [candidate] = await provider.searchArtwork(identity);

    await expect(provider.getOriginal(candidate.id)).rejects.toMatchObject({ kind: "unsafe-source" });
    expect(requests.some((url) => url.startsWith("https://lh3.googleusercontent.com/"))).toBe(false);
    database.close();
  });

  it("rejects provider thumbnails hosted outside the exact Google allowlist", async () => {
    const requests: string[] = [];
    const fetchImpl = searchFake(driveCard({ smallThumbnailUrl: "https://attacker.google.com/image.png" }), async (url) => {
      requests.push(url);
      throw new Error("unsafe host must never be fetched");
    });
    const { database, provider } = await setup(fetchImpl);

    const candidates = await provider.searchArtwork(identity);

    expect(candidates).toEqual([]);
    expect(requests).toEqual([]);
    database.close();
  });

  it.each([
    ["a mismatched MIME type", "image/jpeg", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["an invalid image signature", "image/png", new TextEncoder().encode("not an image")],
  ] as const)("rejects MPC originals with %s", async (_label, contentType, bytes) => {
    const fetchImpl = searchFake(driveCard({ size: bytes.byteLength }), async (url) => {
      if (url.startsWith("https://drive.google.com/uc?")) return new Response(bytes, { headers: { "Content-Type": contentType, "Content-Length": String(bytes.byteLength) } });
      throw new Error(`Unexpected fake asset request: ${url}`);
    });
    const { database, provider } = await setup(fetchImpl);
    const [candidate] = await provider.searchArtwork(identity);

    await expect(provider.getOriginal(candidate.id)).rejects.toMatchObject({ kind: "invalid-image" });
    database.close();
  });

  it("blocks unsafe redirects and never contacts the redirected host", async () => {
    const contacted: string[] = [];
    const fetchImpl = searchFake(driveCard(), async (url) => {
      contacted.push(url);
      if (url.startsWith("https://drive.google.com/uc?")) return new Response(null, { status: 302, headers: { Location: "https://evil.example/payload" } });
      throw new Error(`Unsafe redirected host was contacted: ${url}`);
    });
    const { database, provider } = await setup(fetchImpl);
    const [candidate] = await provider.searchArtwork(identity);

    await expect(provider.getOriginal(candidate.id)).rejects.toMatchObject({ kind: "unsafe-source" });
    expect(contacted).toEqual([expect.stringContaining("drive.google.com/uc?")]);
    database.close();
  });

  it("validates API redirects as well as artwork redirects", async () => {
    const contacted: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      contacted.push(String(input));
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/sources" } });
    };
    const { database, provider } = await setup(fetchImpl);

    await expect(provider.searchArtwork(identity)).rejects.toMatchObject({ kind: "unsafe-source" });
    expect(contacted).toEqual(["https://mpcfill.com/2/sources/"]);
    database.close();
  });

  it("rejects malformed search IDs before hydration URL construction and degrades health", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      requests.push(new URL(url).pathname);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, unknown> };
        return jsonResponse({ results: { [Object.keys(body.queries)[0]]: ["../private/file"] } });
      }
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);

    await expect(provider.searchArtwork(identity)).rejects.toMatchObject({ kind: "protocol" });
    expect(provider.getHealth()).toMatchObject({ available: false, degraded: true });
    expect(requests).toEqual(["/2/sources/", "/3/editorSearch/"]);
    database.close();
  });

  it("rejects malformed thumbnail MIME or image signatures", async () => {
    const fetchImpl = searchFake(driveCard(), async (url) => {
      if (url.includes("drive.google.com/thumbnail")) return new Response(new TextEncoder().encode("not an image"), { headers: { "Content-Type": "image/png" } });
      throw new Error(`Unexpected fake asset request: ${url}`);
    });
    const { database, provider } = await setup(fetchImpl);
    const [candidate] = await provider.searchArtwork(identity);

    await expect(provider.getPreview(candidate.id)).rejects.toMatchObject({ kind: "invalid-image" });
    database.close();
  });

  it("rejects a declared original larger than the configured byte cap before download", async () => {
    const requests: string[] = [];
    const fetchImpl = searchFake(driveCard({ size: 100 }), async (url) => { requests.push(url); throw new Error("must not download an oversized original"); });
    const { database, provider } = await setup(fetchImpl, { maxOriginalBytes: 50 });
    const [candidate] = await provider.searchArtwork(identity);

    expect(candidate.originalAvailable).toBe(false);
    await expect(provider.getOriginal(candidate.id)).rejects.toMatchObject({ code: "ARTWORK_MISSING" });
    expect(requests).toEqual([]);
    database.close();
  });

  it("stops reading and cancels an oversized streamed original", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(32)); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = searchFake(driveCard({ size: 10 }), async (url) => {
      if (url.startsWith("https://drive.google.com/uc?")) return new Response(stream, { headers: { "Content-Type": "image/png" } });
      throw new Error(`Unexpected fake asset request: ${url}`);
    });
    const { database, provider } = await setup(fetchImpl, { maxOriginalBytes: 50 });
    const [candidate] = await provider.searchArtwork(identity);

    await expect(provider.getOriginal(candidate.id)).rejects.toMatchObject({ kind: "asset-too-large" });
    expect(cancelled).toBe(true);
    database.close();
  });

  it("searches independent DFC face names and keeps candidates on separate face IDs", async () => {
    const searchNames: string[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (url.endsWith("/3/editorSearch/")) {
        const body = JSON.parse(String(init.body)) as { queries: Record<string, { query: string }> };
        const [hash, query] = Object.entries(body.queries)[0];
        searchNames.push(query.query);
        const id = query.query === "Daybound" ? "front-drive-id_1234567890" : "back-drive-id_1234567890";
        return jsonResponse({ results: { [hash]: [id] } });
      }
      if (url.endsWith("/2/cards/")) {
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        return jsonResponse({ results: Object.fromEntries(body.cardIdentifiers.map((id) => [id, driveCard({ identifier: id, name: id })])) });
      }
      throw new Error(`Unexpected fake request: ${url}`);
    };
    const { database, provider } = await setup(fetchImpl);
    const dfc: CardIdentity = { ...identity, name: "Front // Back", metadata: { faces: [{ name: "Daybound" }, { name: "Nightbound" }] } };

    const front = await provider.searchArtwork(dfc, { faceId: "front" });
    const back = await provider.searchArtwork(dfc, { faceId: "back" });

    expect(searchNames).toEqual(["Daybound", "Nightbound"]);
    expect(front).toMatchObject([{ faceId: "front", providerAssetId: "front-drive-id_1234567890" }]);
    expect(back).toMatchObject([{ faceId: "back", providerAssetId: "back-drive-id_1234567890" }]);
    expect(front[0].id).not.toBe(back[0].id);
    database.close();
  });

  it("isolates MPC degradation and does not substitute Scryfall for an MPC-only search", async () => {
    const mpcFetch: typeof fetch = async (input) => {
      if (String(input).endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (String(input).endsWith("/3/editorSearch/")) return jsonResponse({ error: "offline" }, 503);
      throw new Error(`Unexpected fake request: ${String(input)}`);
    };
    const { database, provider: mpc } = await setup(mpcFetch);
    const scryfall = {
      source: "scryfall" as const,
      searchArtwork: vi.fn(async () => [{ id: "scryfall:must-not-fallback", source: "scryfall" as const, identityId: identity.id, faceId: "front", originalAvailable: true }]),
      getPreview: vi.fn(async () => undefined),
      getOriginal: vi.fn(async () => { throw new Error("unused"); }),
      getCandidate: vi.fn(async () => undefined),
    };
    const catalog = new ArtworkCatalog([scryfall, mpc]);

    await expect(catalog.search(identity, { source: "mpc" })).resolves.toEqual([]);
    expect(catalog.getProviderHealth()).toMatchObject({ mpc: { available: false, degraded: true } });
    expect(scryfall.searchArtwork).not.toHaveBeenCalled();
    database.close();
  });

  it("keeps Scryfall and uploads available when MPC search degrades", async () => {
    const mpcFetch: typeof fetch = async (input) => {
      if (String(input).endsWith("/2/sources/")) return jsonResponse({ results: { "41": { pk: 41, sourceType: "Google Drive" } } });
      if (String(input).endsWith("/3/editorSearch/")) return jsonResponse({ error: "offline" }, 503);
      throw new Error(`Unexpected fake request: ${String(input)}`);
    };
    const { database, provider: mpc } = await setup(mpcFetch);
    const availableScryfall = staticProvider("scryfall", "scryfall:available");
    const availableUpload = staticProvider("upload", "upload:available");
    const catalog = new ArtworkCatalog([availableScryfall, availableUpload, mpc]);

    const candidates = await catalog.search(identity, { source: "all" });

    expect(candidates.map(({ id }) => id)).toEqual(["scryfall:available", "upload:available"]);
    expect(catalog.getProviderHealth()).toMatchObject({
      mpc: { available: false, degraded: true },
      scryfall: { available: true, degraded: false },
      upload: { available: true, degraded: false },
    });
    database.close();
  });

  it("enforces a timeout even when the injected HTTP transport ignores AbortSignal", async () => {
    const fetchImpl: typeof fetch = async () => new Promise<Response>(() => undefined);
    const { database, provider } = await setup(fetchImpl, { timeoutMs: 10 });
    const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout was not enforced")), 100));

    await expect(Promise.race([provider.searchArtwork(identity), timeout])).rejects.toMatchObject({ kind: "timeout" });
    database.close();
  });

  it("honors caller cancellation even when the injected HTTP transport ignores AbortSignal", async () => {
    const fetchImpl: typeof fetch = async () => new Promise<Response>(() => undefined);
    const { database, provider } = await setup(fetchImpl, { timeoutMs: 500 });
    const controller = new AbortController();
    const cancellation = new Promise<never>((_resolve, reject) => setTimeout(() => controller.abort(), 5));
    const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cancellation was not enforced")), 100));

    await expect(Promise.race([provider.searchArtwork(identity, { signal: controller.signal }), cancellation, timeout]))
      .rejects.toMatchObject({ kind: "aborted" });
    database.close();
  });

  it("downloads and stores an SVG original without converting it", async () => {
    const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140" viewBox="0 0 100 140"><rect width="100" height="140" fill="#123456"/></svg>');
    const { database, provider } = await setup(searchFake(driveCard({ extension: "svg", size: svgBytes.byteLength }), async () => new Response(svgBytes, {
      headers: { "Content-Type": "image/svg+xml", "Content-Length": String(svgBytes.byteLength) },
    })));
    const [candidate] = await provider.searchArtwork(identity);

    expect(candidate.metadata?.originalFormatExportable).toBeUndefined();
    await expect(provider.getOriginal(candidate.id)).resolves.toMatchObject({ extension: "svg", bytes: svgBytes });
    await expect(provider.getCandidate(candidate.id)).resolves.toMatchObject({ metadata: { originalFormatExportable: true } });

    await database.close();
  });

  it.each([
    ["outside the PDF SVG subset", '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140" viewBox="0 0 100 140"><path d="M0 0h100v140z" fill-rule="evenodd" /></svg>', "unsupported-format"],
    ["invalid SVG bytes", "not an SVG document", "invalid-image"],
  ] as const)("rejects MPC SVG originals that are %s and records them as non-exportable", async (_label, source, kind) => {
    const svgBytes = new TextEncoder().encode(source);
    const { database, provider, repository } = await setup(searchFake(driveCard({ extension: "svg", size: svgBytes.byteLength }), async () => new Response(svgBytes, {
      headers: { "Content-Type": "image/svg+xml", "Content-Length": String(svgBytes.byteLength) },
    })));
    const [candidate] = await provider.searchArtwork(identity);

    expect(candidate.metadata?.originalFormatExportable).toBeUndefined();
    await expect(provider.getOriginal(candidate.id)).rejects.toMatchObject({ name: "MpcArtworkProviderError", kind });
    await expect(provider.getCandidate(candidate.id)).resolves.toMatchObject({
      originalAvailable: false,
      metadata: { originalFormatExportable: false },
    });
    expect(repository.findOriginalByProviderSource("mpc", "opaque-drive-id_1234567890", "https://drive.google.com/uc?export=download&id=opaque-drive-id_1234567890")).toBeUndefined();
    await database.close();
  });
});
