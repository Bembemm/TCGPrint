import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ArtworkDisplayStore } from "../../artwork/storage/display-store";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function store(options?: ConstructorParameters<typeof ArtworkDisplayStore>[1]) {
  const root = await mkdtemp(join(tmpdir(), "tcgprint-display-store-"));
  roots.push(root);
  return new ArtworkDisplayStore(root, options);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("artwork compositor display store", () => {
  it("derives requested width directly from the source, preserves aspect ratio, and reuses its cache", async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 1500, height: 2100, channels: 3, background: "#246" } }).png().toBuffer());
    const displayStore = await store();

    const first = await displayStore.getOrCreate("upload:asset-one", hash(bytes), bytes, 1024);
    const cached = await displayStore.getOrCreate("upload:asset-one", hash(bytes), bytes, 1024);
    const metadata = await sharp(Buffer.from(first.bytes)).metadata();

    expect(first).toMatchObject({ widthPx: 1024, heightPx: 1434, contentType: "image/png" });
    expect(metadata.width).toBe(1024);
    expect(cached.bytes).toEqual(first.bytes);
  });

  it("never enlarges a source to the requested bucket", async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 500, height: 700, channels: 3, background: "#642" } }).png().toBuffer());
    const result = await (await store()).getOrCreate("upload:small-source", hash(bytes), bytes, 1024);
    expect(result.widthPx).toBe(500);
    expect(result.heightPx).toBe(700);
  });

  it("coalesces concurrent generations by source and bucket", async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 900, height: 1260, channels: 3, background: "#426" } }).png().toBuffer());
    const generated: number[] = [];
    const displayStore = await store({ generateDerivative: async (source, bucket) => {
      generated.push(bucket);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const output = await sharp(Buffer.from(source)).resize({ width: bucket, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
      return { bytes: new Uint8Array(output.data), contentType: "image/png", widthPx: output.info.width, heightPx: output.info.height };
    } });

    await Promise.all([
      displayStore.getOrCreate("upload:coalesced", hash(bytes), bytes, 768),
      displayStore.getOrCreate("upload:coalesced", hash(bytes), bytes, 768),
      displayStore.getOrCreate("upload:coalesced", hash(bytes), bytes, 1024),
    ]);

    expect(generated.sort((left, right) => left - right)).toEqual([768, 1024]);
  });

  it("separates cache entries by asset identity and by source hash", async () => {
    const firstBytes = new Uint8Array(await sharp({ create: { width: 900, height: 1260, channels: 3, background: "#426" } }).png().toBuffer());
    const secondBytes = new Uint8Array(await sharp({ create: { width: 900, height: 1260, channels: 3, background: "#642" } }).png().toBuffer());
    let generationCount = 0;
    const displayStore = await store({ generateDerivative: async (source, bucket) => {
      generationCount += 1;
      const output = await sharp(Buffer.from(source)).resize({ width: bucket, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
      return { bytes: new Uint8Array(output.data), contentType: "image/png", widthPx: output.info.width, heightPx: output.info.height };
    } });

    await displayStore.getOrCreate("upload:one", hash(firstBytes), firstBytes, 512);
    await displayStore.getOrCreate("upload:two", hash(firstBytes), firstBytes, 512);
    await displayStore.getOrCreate("upload:one", hash(secondBytes), secondBytes, 512);

    expect(generationCount).toBe(3);
  });

  it("rejects arbitrary buckets and source hashes that do not match the bytes", async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 20, height: 30, channels: 3, background: "#246" } }).png().toBuffer());
    const displayStore = await store();
    await expect(displayStore.getOrCreate("upload:invalid", hash(bytes), bytes, 513 as 512)).rejects.toThrow(/bucket/i);
    await expect(displayStore.getOrCreate("upload:invalid", "0".repeat(64), bytes, 512)).rejects.toThrow(/hash/i);
  });

  it("rasterizes a validated SVG into a PNG display derivative", async () => {
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840"><rect width="600" height="840" fill="#246"/></svg>');
    const result = await (await store()).getOrCreate("mpc:svg-card", hash(bytes), bytes, 1024);
    expect(result).toMatchObject({ widthPx: 600, heightPx: 840, contentType: "image/png" });
    expect((await sharp(Buffer.from(result.bytes)).metadata()).format).toBe("png");
  });

  it("does not retain a shared generation when every consumer aborts", async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 900, height: 1260, channels: 3, background: "#426" } }).png().toBuffer());
    let generationCount = 0;
    const displayStore = await store({ generateDerivative: async (_source, _bucket, signal) => {
      generationCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return { bytes, contentType: "image/png", widthPx: 900, heightPx: 1260 };
    } });
    const controller = new AbortController();
    const pending = displayStore.getOrCreate("upload:cancelled", hash(bytes), bytes, 768, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(generationCount).toBe(0);
  });
});
