import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardIdentity } from "../../core/cards/types";
import { ArtworkRepository } from "../../artwork/storage/repository";
import { ArtworkOriginalStore } from "../../artwork/storage/original-store";
import { ArtworkThumbnailStore } from "../../artwork/storage/thumbnail-store";
import { appDataPaths } from "../../artwork/storage/paths";
import { ArtworkMetadataCache } from "../../artwork/storage/metadata-cache";
import { calculateEffectiveDpi, artworkResolutionQuality } from "../../artwork/effective-dpi";
import { LocalArtworkProvider } from "../../artwork/local-provider";
import { ScryfallArtworkProvider } from "../../artwork/scryfall-provider";
import type { ScryfallClient } from "../../providers/scryfall/client";
import type { ScryfallCard, ScryfallDownloadedAsset } from "../../providers/scryfall/types";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "tcgprint-artwork-provider-"));
  temporaryDirectories.push(base);
  const paths = appDataPaths(base);
  await mkdir(dirname(paths.databaseFile), { recursive: true });
  const database = new Database(paths.databaseFile);
  const repository = new ArtworkRepository(database);
  return { database, repository, originals: new ArtworkOriginalStore(paths.originalsDirectory, repository), thumbnails: new ArtworkThumbnailStore(paths.thumbnailsDirectory, repository), metadata: new ArtworkMetadataCache(repository) };
}

async function png(width = 1500, height = 2100) {
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: { r: 90, g: 50, b: 180 } } }).png().toBuffer());
}

const identity: CardIdentity = { id: "scryfall:oracle-sol-ring", provider: "scryfall", name: "Sol Ring", oracleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", resolutionMethod: "name", confidence: 1 };
const solRing: ScryfallCard = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", oracleId: identity.oracleId, name: "Sol Ring", layout: "normal", setCode: "cmm", collectorNumber: "396", lang: "en", releasedAt: "2023-08-04", digital: false, promo: false, fullArt: false, borderColor: "black", imageStatus: "highres_scan",
  imageUris: { small: "https://cards.scryfall.io/small/front/a/a/one.jpg", normal: "https://cards.scryfall.io/normal/front/a/a/one.jpg", large: "https://cards.scryfall.io/large/front/a/a/one.jpg", png: "https://cards.scryfall.io/png/front/a/a/one.png" }, faces: [], relatedCards: [], metadata: {},
};

function fakeScryfall(cards: readonly ScryfallCard[], bytes: Uint8Array, previewBytes = bytes) {
  const listPrintings = vi.fn(async () => cards);
  const downloadAsset = vi.fn(async (sourceUrl: string, options: { kind: "thumbnail" | "original" }) => ({ bytes: new Uint8Array(options.kind === "thumbnail" ? previewBytes : bytes), contentType: "image/png", sourceUrl, kind: options.kind }) satisfies ScryfallDownloadedAsset);
  return { client: { listPrintings, lookupById: vi.fn(async () => cards[0]), lookupByName: vi.fn(async () => cards[0]), downloadAsset } as unknown as ScryfallClient, listPrintings, downloadAsset };
}

describe("artwork providers", () => {
  it("lists several printings per identity, keeps preview separate, and caches byte-identical original with provenance", async () => {
    const storage = await setup();
    const second = { ...solRing, id: "12121212-1212-4121-8121-121212121212", setCode: "m21", collectorNumber: "265", releasedAt: "2020-07-03", imageUris: { small: "https://cards.scryfall.io/small/two.jpg", large: "https://cards.scryfall.io/large/two.jpg" } };
    const previewOnly = { ...second, id: "34343434-3434-4343-8343-343434343434", setCode: "abc", collectorNumber: "10", imageUris: { small: "https://cards.scryfall.io/small/preview.jpg", normal: "https://cards.scryfall.io/normal/preview.jpg" } };
    const bytes = await png();
    const fake = fakeScryfall([solRing, second, previewOnly], bytes, await png(300, 420));
    const provider = new ScryfallArtworkProvider(fake.client, storage.originals, storage.thumbnails, storage.metadata, storage.repository);
    const candidates = await provider.searchArtwork(identity);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ id: `scryfall:${solRing.id}:front`, source: "scryfall", identityId: identity.id, faceId: "front", previewUri: solRing.imageUris?.small, originalUri: solRing.imageUris?.png, providerAssetId: solRing.id, scryfallId: solRing.id, oracleId: identity.oracleId, setCode: "cmm", collectorNumber: "396", language: "en" });
    const candidate = candidates[0];
    expect(candidates[2]).toMatchObject({ previewUri: previewOnly.imageUris.small, originalAvailable: false });
    expect(candidates[2].originalUri).toBeUndefined();
    const preview = await provider.getPreview(candidate.id);
    const original = await provider.getOriginal(candidate.id);
    const cached = await provider.getOriginal(candidate.id);
    expect(preview).toMatchObject({ source: "scryfall", candidateId: candidate.id, widthPx: 300, heightPx: 420 });
    expect(original.bytes).toEqual(bytes);
    expect(cached.bytes).toEqual(bytes);
    expect(fake.downloadAsset).toHaveBeenCalledTimes(2);
    expect(fake.downloadAsset.mock.calls.map(([uri]) => uri)).toContain(solRing.imageUris?.png);
    expect(original.provenance).toContainEqual(expect.objectContaining({ provider: "scryfall", providerAssetId: solRing.id, scryfallId: solRing.id, oracleId: identity.oracleId, sourceUrl: solRing.imageUris?.png }));
    expect(await provider.getCandidate(candidate.id)).toMatchObject({ widthPx: 1500, heightPx: 2100, effectiveDpi: 600 });
    await expect(provider.getOriginal("missing")).rejects.toMatchObject({ code: "ARTWORK_MISSING" });
    storage.database.close();
  }, 15_000);

  it("maps DFC candidates to their corresponding faces and keeps face artwork independently addressable", async () => {
    const storage = await setup();
    const dmf: ScryfallCard = {
      ...solRing,
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      name: "Delver of Secrets // Insectile Aberration",
      layout: "transform",
      imageUris: undefined,
      faces: [
        { name: "Delver of Secrets", imageUris: { small: "https://cards.scryfall.io/small/front.jpg", png: "https://cards.scryfall.io/png/front.png" } },
        { name: "Insectile Aberration", imageUris: { small: "https://cards.scryfall.io/small/back.jpg", png: "https://cards.scryfall.io/png/back.png" } },
      ],
    };
    const fake = fakeScryfall([dmf], await png());
    const provider = new ScryfallArtworkProvider(fake.client, storage.originals, storage.thumbnails, storage.metadata, storage.repository);
    const candidates = await provider.searchArtwork({ ...identity, id: "scryfall:delver", name: dmf.name, oracleId: dmf.oracleId }, {});
    expect(candidates.map((item) => [item.faceId, item.faceName, item.originalUri])).toEqual([
      ["front", "Delver of Secrets", "https://cards.scryfall.io/png/front.png"],
      ["back", "Insectile Aberration", "https://cards.scryfall.io/png/back.png"],
    ]);
    expect(candidates.map((item) => item.id)).toEqual([`scryfall:${dmf.id}:front`, `scryfall:${dmf.id}:back`]);
    storage.database.close();
  });

  it("registers immutable local uploads by SHA-256, links identity separately, and exposes library candidates", async () => {
    const storage = await setup();
    const provider = new LocalArtworkProvider(storage.originals, storage.thumbnails, storage.repository);
    const bytes = await png(300, 420);
    const before = new Uint8Array(bytes);
    const uploaded = await provider.registerUpload(bytes, { originalFilename: "../Sol Ring-front.png", sourcePath: "Deck/Sol Ring-front.png" });
    const duplicated = await provider.registerUpload(bytes, { originalFilename: "other-copy.png" });
    expect(duplicated.id).toBe(uploaded.id);
    expect(Buffer.from(bytes)).toEqual(Buffer.from(before));
    provider.linkUpload(identity.id, uploaded.id, "front");
    const candidates = await provider.searchArtwork(identity, { faceId: "front" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "upload", identityId: identity.id, faceId: "front", originalAvailable: true, widthPx: 300, heightPx: 420, metadata: { originalFilename: "../Sol Ring-front.png" } });
    expect(await provider.getOriginal(uploaded.id)).toMatchObject({ bytes });
    expect(await provider.getPreview(uploaded.id)).toMatchObject({ source: "upload", widthPx: 300, heightPx: 420 });
    expect(storage.originals.listUploads()).toHaveLength(1);
    storage.database.close();
  });

  it("calculates effective DPI against Magic trim dimensions and reports non-blocking quality bands", () => {
    expect(calculateEffectiveDpi(1500, 2100)).toBe(600);
    expect(artworkResolutionQuality(600)).toBe("excellent");
    expect(artworkResolutionQuality(300)).toBe("good");
    expect(artworkResolutionQuality(250)).toBe("warning");
    expect(artworkResolutionQuality(199)).toBe("low");
    expect(artworkResolutionQuality(undefined)).toBe("unknown");
  });
});
