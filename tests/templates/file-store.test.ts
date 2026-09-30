import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateFileStore } from "../../templates/file-store";

describe("immutable template file store", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("stores and retrieves opaque studio3 bytes byte-for-byte by SHA-256", async () => {
    root = await mkdtemp(join(tmpdir(), "tcgprint-template-store-"));
    const store = new TemplateFileStore(root);
    const original = new Uint8Array([0, 255, 83, 84, 85, 68, 73, 79, 51]);
    const hash = createHash("sha256").update(original).digest("hex");

    const stored = await store.put(original);

    expect(stored).toEqual({ contentHash: hash, byteLength: original.byteLength });
    expect(await store.get(hash)).toEqual(original);
  });

  it("deduplicates identical bytes regardless of the associated template filename", async () => {
    root = await mkdtemp(join(tmpdir(), "tcgprint-template-store-"));
    const store = new TemplateFileStore(root);
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const first = await store.put(bytes);
    const second = await store.put(new Uint8Array(bytes));

    expect(second).toEqual(first);
    expect(await readFile(join(root, first.contentHash.slice(0, 2), first.contentHash))).toEqual(Buffer.from(bytes));
  });

  it("rejects empty and oversized originals before writing them", async () => {
    root = await mkdtemp(join(tmpdir(), "tcgprint-template-store-"));
    const store = new TemplateFileStore(root, { maximumBytes: 3 });

    await expect(store.put(new Uint8Array())).rejects.toMatchObject({ code: "TEMPLATE_FILE_INVALID" });
    await expect(store.put(new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ code: "TEMPLATE_FILE_TOO_LARGE" });
  });

  it("reports a missing original and never repairs a corrupted immutable blob silently", async () => {
    root = await mkdtemp(join(tmpdir(), "tcgprint-template-store-"));
    const store = new TemplateFileStore(root);
    const bytes = new Uint8Array([9, 8, 7]);
    const hash = createHash("sha256").update(bytes).digest("hex");

    await expect(store.get(hash)).rejects.toMatchObject({ code: "TEMPLATE_FILE_MISSING" });

    const path = join(root, hash.slice(0, 2), hash);
    await mkdir(join(root, hash.slice(0, 2)), { recursive: true });
    await writeFile(path, new Uint8Array([9, 8, 6]));
    await expect(store.get(hash)).rejects.toMatchObject({ code: "TEMPLATE_FILE_CORRUPT" });
    await expect(store.put(bytes)).rejects.toMatchObject({ code: "TEMPLATE_FILE_CORRUPT" });
    expect(await readFile(path)).toEqual(Buffer.from([9, 8, 6]));
  });

  it("rejects an unexpectedly oversized corrupted blob before serving it", async () => {
    root = await mkdtemp(join(tmpdir(), "tcgprint-template-store-"));
    const store = new TemplateFileStore(root, { maximumBytes: 1024 });
    const original = new Uint8Array([1, 2, 3]);
    const hash = createHash("sha256").update(original).digest("hex");
    const shard = join(root, hash.slice(0, 2));
    await mkdir(shard, { recursive: true });
    await writeFile(join(shard, hash), new Uint8Array(1025).fill(9));

    await expect(store.get(hash, original.byteLength)).rejects.toMatchObject({ code: "TEMPLATE_FILE_CORRUPT" });
  });

  it.skipIf(process.platform === "win32")("refuses to follow a symlink from a content-addressed blob path", async () => {
    root = await mkdtemp(join(tmpdir(), "tcgprint-template-store-"));
    const store = new TemplateFileStore(root);
    const bytes = new Uint8Array([5, 5, 5]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const shard = join(root, hash.slice(0, 2));
    await mkdir(shard, { recursive: true });
    const outside = join(root, "outside");
    await writeFile(outside, bytes);
    await symlink(outside, join(shard, hash));

    await expect(store.get(hash)).rejects.toMatchObject({ code: "TEMPLATE_FILE_CORRUPT" });
    await expect(store.put(bytes)).rejects.toMatchObject({ code: "TEMPLATE_FILE_CORRUPT" });
    expect(await readFile(outside)).toEqual(Buffer.from(bytes));
  });
});
