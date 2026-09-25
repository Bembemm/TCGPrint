import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { migrateArtworkDatabase } from "../../artwork/storage/migrations";
import { appDataPaths, originalPathForHash } from "../../artwork/storage/paths";
import { ArtworkRepository } from "../../artwork/storage/repository";
import { ArtworkOriginalStore } from "../../artwork/storage/original-store";
import { ArtworkThumbnailStore } from "../../artwork/storage/thumbnail-store";
import { ArtworkMetadataCache } from "../../artwork/storage/metadata-cache";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "tcgprint-artwork-storage-"));
  temporaryDirectories.push(path);
  return path;
}

async function png(color: { r: number; g: number; b: number }) {
  return new Uint8Array(await sharp({ create: { width: 12, height: 18, channels: 3, background: color } }).png().toBuffer());
}

async function dbAt(path: string) {
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const database = new Database(path);
  const repository = new ArtworkRepository(database);
  return { database, repository };
}

describe("artwork storage", () => {
  it("migrates schema zero transactionally and idempotently without project tables", async () => {
    const database = new Database(":memory:");
    expect(migrateArtworkDatabase(database)).toBe(1);
    expect(migrateArtworkDatabase(database)).toBe(1);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["artwork_metadata_cache", "artwork_originals", "artwork_provenance", "artwork_thumbnails", "artwork_identity_links"]));
    expect(tables.some((name) => /project|autosave/i.test(name))).toBe(false);
    database.close();
  });

  it("rolls schema changes and user_version back when a migration fails", () => {
    const database = new Database(":memory:");
    database.exec("CREATE TABLE artwork_originals (wrong TEXT)");
    expect(() => migrateArtworkDatabase(database)).toThrow();
    expect(database.pragma("user_version", { simple: true })).toBe(0);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='artwork_metadata_cache'").get()).toBeUndefined();
    database.close();
  });

  it("derives originals and app paths only from hashes, validates filenames as metadata, and preserves bytes", async () => {
    const base = await directory();
    const paths = appDataPaths(base);
    const bytes = await png({ r: 12, g: 80, b: 220 });
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(originalPathForHash(paths.originalsDirectory, hash, "png")).toBe(join(paths.originalsDirectory, hash.slice(0, 2), `${hash}.png`));
    expect(() => originalPathForHash(paths.originalsDirectory, "../../outside", "png")).toThrow();
    const { database, repository } = await dbAt(paths.databaseFile);
    const store = new ArtworkOriginalStore(paths.originalsDirectory, repository);
    const stored = await store.addOriginal(bytes, { provider: "upload", originalFilename: "../../../../outside.png" });
    expect(stored.contentHash).toBe(hash);
    expect(stored.provenance[0].originalFilename).toBe("../../../../outside.png");
    expect(resolve(originalPathForHash(paths.originalsDirectory, stored.contentHash, stored.extension))).toContain(resolve(paths.originalsDirectory));
    expect(stored.format).toBe("png");
    expect(stored.widthPx).toBe(12);
    expect(stored.heightPx).toBe(18);
    expect(await store.getOriginal(stored.artworkId)).toEqual(expect.objectContaining({ bytes, contentHash: hash }));
    database.close();
  });

  it("deduplicates identical local uploads physically while retaining provenance", async () => {
    const base = await directory();
    const paths = appDataPaths(base);
    const bytes = await png({ r: 1, g: 2, b: 3 });
    const { database, repository } = await dbAt(paths.databaseFile);
    const store = new ArtworkOriginalStore(paths.originalsDirectory, repository);
    const first = await store.addOriginal(bytes, { provider: "upload", originalFilename: "first.png", sourcePath: "Deck/first.png" });
    const second = await store.addOriginal(bytes, { provider: "upload", originalFilename: "second.png", sourcePath: "Deck/second.png" });
    expect(second.artworkId).toBe(first.artworkId);
    expect(second.provenance).toHaveLength(2);
    expect(await readdir(join(paths.originalsDirectory, first.contentHash.slice(0, 2)))).toEqual([`${first.contentHash}.png`]);
    expect(await store.listUploads()).toHaveLength(1);
    database.close();
  });

  it("keeps metadata TTL independent from permanent original artwork and treats malformed rows as misses", async () => {
    const { database, repository } = await dbAt(":memory:");
    const cache = new ArtworkMetadataCache(repository);
    cache.putMetadata("scryfall:sol-ring", { name: "Sol Ring" }, 2_000);
    expect(cache.getMetadata("scryfall:sol-ring", 1_999)).toEqual({ name: "Sol Ring" });
    expect(cache.getMetadata("scryfall:sol-ring", 2_000)).toBeUndefined();
    database.prepare("INSERT INTO artwork_metadata_cache(cache_key, value_json, expires_at, updated_at) VALUES (?, ?, ?, ?)").run("broken", "{", 99_999, 1);
    expect(cache.getMetadata("broken", 2)).toBeUndefined();
    database.close();
  });

  it("separates thumbnails from originals and never falls back when a thumbnail is absent", async () => {
    const base = await directory();
    const paths = appDataPaths(base);
    const { database, repository } = await dbAt(paths.databaseFile);
    const bytes = await png({ r: 210, g: 70, b: 4 });
    const originals = new ArtworkOriginalStore(paths.originalsDirectory, repository);
    const thumbnails = new ArtworkThumbnailStore(paths.thumbnailsDirectory, repository);
    const original = await originals.addOriginal(bytes, { provider: "upload" });
    expect(await thumbnails.getThumbnail("candidate-one")).toBeUndefined();
    await expect(originals.getOriginal("candidate-one")).rejects.toMatchObject({ code: "ARTWORK_MISSING" });
    const thumbnail = await thumbnails.putThumbnail("candidate-one", bytes, { sourceArtworkId: original.artworkId, widthPx: 12, heightPx: 18 });
    expect(thumbnail.thumbnailId).not.toBe(original.artworkId);
    expect(await thumbnails.getThumbnail("candidate-one")).toMatchObject({ bytes, sourceArtworkId: original.artworkId });
    await expect(originals.getOriginal(thumbnail.thumbnailId)).rejects.toMatchObject({ code: "ARTWORK_MISSING" });
    database.close();
  });

  it("rejects tampered content-addressed originals instead of overwriting them", async () => {
    const base = await directory();
    const paths = appDataPaths(base);
    const { database, repository } = await dbAt(paths.databaseFile);
    const store = new ArtworkOriginalStore(paths.originalsDirectory, repository);
    const bytes = await png({ r: 200, g: 2, b: 6 });
    const stored = await store.addOriginal(bytes, { provider: "upload" });
    const filePath = originalPathForHash(paths.originalsDirectory, stored.contentHash, stored.extension);
    const tampered = new Uint8Array(await readFile(filePath));
    tampered[tampered.length - 1] ^= 0xff;
    await writeFile(filePath, tampered);
    await expect(store.getOriginal(stored.artworkId)).rejects.toMatchObject({ code: "ARTWORK_CONTENT_CORRUPT" });
    await expect(store.addOriginal(bytes, { provider: "upload" })).rejects.toMatchObject({ code: "ARTWORK_CONTENT_CORRUPT" });
    await expect(stat(filePath)).resolves.toBeDefined();
    database.close();
  });
});
