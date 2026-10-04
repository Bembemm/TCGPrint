import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ArtworkOriginalStore } from "../../artwork/storage/original-store";
import { appDataPaths } from "../../artwork/storage/paths";
import { ArtworkRepository } from "../../artwork/storage/repository";
import { ArtworkThumbnailStore } from "../../artwork/storage/thumbnail-store";
import { BackLibraryRepository } from "../../persistence/back-library/repository";
import { BackLibraryService } from "../../services/back-library";
import { handleBackLibraryList, handleBackLibraryPreview, handleBackLibraryRetire, handleBackLibraryUpload } from "../../services/back-library-api";

describe("Back Library API", () => {
  let directory: string | undefined;
  let database: Database.Database | undefined;

  afterEach(async () => {
    database?.close();
    database = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function setup() {
    directory = await mkdtemp(join(tmpdir(), "tcgprint-back-api-"));
    const paths = appDataPaths(directory);
    database = new Database(":memory:");
    const artworkRepository = new ArtworkRepository(database);
    const thumbnailStore = new ArtworkThumbnailStore(paths.thumbnailsDirectory, artworkRepository);
    const service = new BackLibraryService(
      new BackLibraryRepository(database),
      new ArtworkOriginalStore(paths.originalsDirectory, artworkRepository),
      {},
      thumbnailStore,
    );
    return service;
  }

  it("accepts a bounded multipart upload and returns metadata without blob or filesystem paths", async () => {
    const service = await setup();
    const bytes = new Uint8Array(await sharp({ create: { width: 30, height: 45, channels: 3, background: "#2970a8" } }).png().toBuffer());
    const form = new FormData();
    form.set("file", new File([bytes], "../Back.png", { type: "image/png" }));
    form.set("metadata", JSON.stringify({ edition: "test" }));

    const uploaded = await handleBackLibraryUpload(new Request("http://localhost/api/back-library", { method: "POST", body: form }), service);
    const body = await uploaded.json();

    expect(uploaded.status).toBe(201);
    expect(body.asset).toMatchObject({ name: "Back.png", format: "png", metadata: { edition: "test" }, retired: false });
    expect(JSON.stringify(body)).not.toMatch(/bytes|blob|originalsDirectory|filesystemPath|localPath/i);
    const listed = await handleBackLibraryList(service);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ assets: [{ assetId: body.asset.assetId, retired: false, selectable: true }] });
  });

  it("retirement exposes a tombstone and preserves the immutable Project reference", async () => {
    const service = await setup();
    const bytes = new Uint8Array(await sharp({ create: { width: 20, height: 30, channels: 3, background: "#aa7330" } }).png().toBuffer());
    const form = new FormData();
    form.set("file", new File([bytes], "Gold.png", { type: "image/png" }));
    const uploaded = await handleBackLibraryUpload(new Request("http://localhost/api/back-library", { method: "POST", body: form }), service);
    const { asset } = await uploaded.json();

    const retired = await handleBackLibraryRetire(asset.assetId, service);

    expect(retired.status).toBe(200);
    expect((await retired.json()).asset.retired).toBe(true);
    expect(await (await handleBackLibraryList(service).then((response) => response.json())).assets).toMatchObject([{ assetId: asset.assetId, sha256: asset.sha256, retired: true, selectable: false }]);
    await expect(service.resolveOriginal({ assetId: asset.assetId, sha256: asset.sha256, format: "png" })).resolves.toMatchObject({ bytes });
  });

  it("serves only the bounded Back Library preview derivative", async () => {
    const service = await setup();
    const bytes = new Uint8Array(await sharp({ create: { width: 1200, height: 1800, channels: 3, background: "#aa7330" } }).png().toBuffer());
    const asset = await service.add({ bytes, filename: "Gold.png" });
    const response = await handleBackLibraryPreview(new Request(`http://localhost/api/back-library/${asset.assetId}/preview`), asset.assetId, service);
    const body = new Uint8Array(await response.arrayBuffer());
    const metadata = await sharp(body).metadata();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tcgprint-artwork-role")).toBe("preview");
    expect(response.headers.get("cache-control")).toContain("max-age");
    expect(body.byteLength).toBeLessThan(bytes.byteLength);
    expect(metadata.width).toBeLessThanOrEqual(640);
    const extendedResponse = await handleBackLibraryPreview(new Request(`http://localhost/api/back-library/${asset.assetId}/preview?bleedMm=1&trimWidthMm=63.5&trimHeightMm=88.9&roundedCorners=false`), asset.assetId, service);
    const extended = await sharp(new Uint8Array(await extendedResponse.arrayBuffer())).metadata();
    expect(extendedResponse.status).toBe(200);
    expect(extendedResponse.headers.get("content-type")).toBe("image/png");
    expect(extended.width).toBeGreaterThan(metadata.width!);
    expect(extended.height).toBeGreaterThan(metadata.height!);
    await expect(handleBackLibraryPreview(new Request("http://localhost"), "back:invalid", service).then((result) => result.status)).resolves.toBe(404);
  });

  it("rejects malformed metadata and unsupported filename payloads with structured errors", async () => {
    const service = await setup();
    const form = new FormData();
    form.set("file", new File(["<svg onload='alert(1)'></svg>"], "bad.svg", { type: "image/svg+xml" }));
    const response = await handleBackLibraryUpload(new Request("http://localhost/api/back-library", { method: "POST", body: form }), service);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "BACK_INVALID_IMAGE" });
  });
});
