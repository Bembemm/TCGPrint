import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ArtworkOriginalStore } from "../../artwork/storage/original-store";
import { appDataPaths } from "../../artwork/storage/paths";
import { ArtworkRepository } from "../../artwork/storage/repository";
import { openArtworkDatabase } from "../../persistence/sqlite";
import { BackLibraryRepository } from "../../persistence/back-library/repository";
import { BackLibraryService } from "../../services/back-library";

const directories: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeService(options: { maximumBytes?: number; maximumDimensionPixels?: number; maximumPixels?: number } = {}) {
  const base = await mkdtemp(join(tmpdir(), "tcgprint-back-library-"));
  directories.push(base);
  const paths = appDataPaths(base);
  await mkdir(paths.rootDirectory, { recursive: true });
  const database = openArtworkDatabase(paths.databaseFile);
  databases.push(database);
  const artworkRepository = new ArtworkRepository(database);
  const originals = new ArtworkOriginalStore(paths.originalsDirectory, artworkRepository, { maximumBytes: options.maximumBytes ?? 20 * 1024 * 1024 });
  return { service: new BackLibraryService(new BackLibraryRepository(database), originals, options), database, paths };
}

async function png(width = 64, height = 96) {
  return new Uint8Array(await sharp({ create: { width, height, channels: 4, background: { r: 8, g: 90, b: 170, alpha: 1 } } }).png().toBuffer());
}

describe("Back Library", () => {
  it("validates real PNG bytes, keeps original bytes, and returns path-free immutable metadata", async () => {
    const { service } = await makeService();
    const bytes = await png();
    const record = await service.add({ bytes, filename: "../../Forest\n Back.png", metadata: { artist: "Ada", edition: 2 } });
    const hash = createHash("sha256").update(bytes).digest("hex");

    expect(record).toMatchObject({
      assetId: `back:${hash}`,
      sha256: hash,
      format: "png",
      widthPx: 64,
      heightPx: 96,
      name: "Forest Back.png",
      metadata: { artist: "Ada", edition: 2 },
      retired: false,
    });
    expect(JSON.stringify(record)).not.toMatch(/path|blob|bytes|filesystem/i);
    await expect(service.resolveOriginal({ assetId: record.assetId, sha256: hash, format: "png" })).resolves.toMatchObject({ bytes, contentHash: hash });
  });

  it("deduplicates by byte hash and preserves the first asset identity and metadata", async () => {
    const { service } = await makeService();
    const bytes = await png();
    const first = await service.add({ bytes, filename: "Forest.png", metadata: { artist: "Ada" } });
    const duplicate = await service.add({ bytes, filename: "Different name.png", metadata: { artist: "Other" } });

    expect(duplicate).toMatchObject({ assetId: first.assetId, sha256: first.sha256, format: "png", widthPx: 64, heightPx: 96, name: "Forest.png", metadata: { artist: "Ada" }, retired: false, createdAt: first.createdAt });
    expect(await service.list()).toEqual([duplicate]);
  });

  it("keeps retired asset ID plus SHA resolvable for existing Projects and hides it from selection", async () => {
    const { service, database, paths } = await makeService();
    const bytes = await png();
    const added = await service.add({ bytes, filename: "Project back.png" });
    const reference = { assetId: added.assetId, sha256: added.sha256, format: added.format } as const;

    const retired = await service.retire(added.assetId);

    expect(retired).toMatchObject({ assetId: added.assetId, sha256: added.sha256, format: added.format, name: added.name, retired: true });
    expect(await service.list()).toEqual([]);
    await expect(service.resolveOriginal(reference)).resolves.toMatchObject({ bytes, contentHash: added.sha256 });
    await expect(service.resolveOriginal({ ...reference, sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "BACK_REFERENCE_MISMATCH" });

    databases.splice(databases.indexOf(database), 1);
    database.close();
    const reopenedDatabase = openArtworkDatabase(paths.databaseFile);
    databases.push(reopenedDatabase);
    const reopenedArtworkRepository = new ArtworkRepository(reopenedDatabase);
    const reopened = new BackLibraryService(
      new BackLibraryRepository(reopenedDatabase),
      new ArtworkOriginalStore(paths.originalsDirectory, reopenedArtworkRepository),
    );
    expect(await reopened.list()).toEqual([]);
    await expect(reopened.resolveOriginal(reference)).resolves.toMatchObject({ bytes, contentHash: added.sha256 });
  });

  it("rejects unsupported bytes, oversized uploads, and excessive image dimensions", async () => {
    const { service } = await makeService({ maximumBytes: 1024, maximumDimensionPixels: 80, maximumPixels: 5_000 });
    await expect(service.add({ bytes: new Uint8Array(Buffer.from("<svg><script>alert(1)</script></svg>")), filename: "bad.svg" }))
      .rejects.toMatchObject({ code: "BACK_INVALID_IMAGE" });
    await expect(service.add({ bytes: new Uint8Array(1025), filename: "large.png" }))
      .rejects.toMatchObject({ code: "BACK_TOO_LARGE" });
    const tooWide = await png(81, 20);
    await expect(service.add({ bytes: tooWide, filename: "wide.png" }))
      .rejects.toMatchObject({ code: "BACK_DIMENSIONS_EXCEEDED" });
  });

  it("rejects pathless name violations and metadata values outside the safe JSON allowlist", async () => {
    const { service } = await makeService();
    const bytes = await png();
    await expect(service.add({ bytes, filename: "../\u0000" })).rejects.toMatchObject({ code: "BACK_INVALID_FILENAME" });
    await expect(service.add({ bytes, filename: "safe.png", metadata: { nested: { path: "/etc/passwd" } } }))
      .rejects.toMatchObject({ code: "BACK_INVALID_METADATA" });
  });
});
