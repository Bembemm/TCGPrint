import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BleedCache } from "./types";

function assertCacheKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new TypeError("Bleed cache keys must be lowercase SHA-256 hex digests.");
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** Process-local cache. Values are copied so previews cannot mutate cached data. */
export class MemoryBleedCache implements BleedCache {
  private readonly entries = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    assertCacheKey(key);
    const bytes = this.entries.get(key);
    return bytes ? copyBytes(bytes) : undefined;
  }

  async set(key: string, bytes: Uint8Array): Promise<void> {
    assertCacheKey(key);
    this.entries.set(key, copyBytes(bytes));
  }
}

/** Disk cache for local application data; originals are never written here. */
export class FileBleedCache implements BleedCache {
  constructor(private readonly directory: string) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    assertCacheKey(key);

    try {
      return new Uint8Array(await readFile(join(this.directory, `${key}.png`)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async set(key: string, bytes: Uint8Array): Promise<void> {
    assertCacheKey(key);
    await mkdir(this.directory, { recursive: true });

    const destination = join(this.directory, `${key}.png`);
    const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
