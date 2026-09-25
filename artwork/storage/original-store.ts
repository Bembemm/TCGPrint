import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { originalPathForHash } from "./paths";
import type { ArtworkRepository } from "./repository";
import type { ArtworkOriginal, ArtworkProvenance } from "./types";
import { ArtworkStorageError } from "./types";
import { validateImageBytes } from "./image-validation";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function verifyExisting(path: string, contentHash: string): Promise<boolean> {
  try {
    const existing = await readFile(path);
    if (sha256(existing) !== contentHash) throw new ArtworkStorageError("ARTWORK_CONTENT_CORRUPT", "A content-addressed artwork file does not match its SHA-256 path.");
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function writeCreateOnly(path: string, bytes: Uint8Array, contentHash: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      await verifyExisting(path, contentHash);
      return;
    }
    throw error;
  }
}

export class ArtworkOriginalStore {
  private readonly originalsDirectory: string;
  private readonly repository: ArtworkRepository;
  private readonly maximumBytes: number;

  constructor(originalsDirectory: string, repository: ArtworkRepository, options: { maximumBytes?: number } = {}) {
    this.originalsDirectory = originalsDirectory;
    this.repository = repository;
    this.maximumBytes = options.maximumBytes ?? 100 * 1024 * 1024;
  }

  async addOriginal(bytes: Uint8Array, provenance: ArtworkProvenance): Promise<ArtworkOriginal> {
    const contentHash = sha256(bytes);
    const existingRecord = this.repository.getOriginal(contentHash);
    if (existingRecord) {
      const existingPath = originalPathForHash(this.originalsDirectory, existingRecord.contentHash, existingRecord.extension);
      if (await verifyExisting(existingPath, contentHash)) {
        const record = this.repository.addOriginal({
          artworkId: existingRecord.artworkId,
          contentHash: existingRecord.contentHash,
          format: existingRecord.format,
          extension: existingRecord.extension,
          byteLength: existingRecord.byteLength,
          widthPx: existingRecord.widthPx,
          heightPx: existingRecord.heightPx,
        }, provenance);
        return { ...record, bytes: new Uint8Array(bytes) };
      }
    }
    const image = await validateImageBytes(bytes, this.maximumBytes);
    const artworkId = contentHash;
    const path = originalPathForHash(this.originalsDirectory, contentHash, image.extension);
    if (!await verifyExisting(path, contentHash)) await writeCreateOnly(path, bytes, contentHash);
    const record = this.repository.addOriginal({
      artworkId,
      contentHash,
      format: image.format,
      extension: image.extension,
      byteLength: bytes.byteLength,
      widthPx: image.widthPx,
      heightPx: image.heightPx,
    }, provenance);
    return { ...record, bytes: new Uint8Array(bytes) };
  }

  async getOriginal(artworkId: string): Promise<ArtworkOriginal> {
    if (!/^[a-f0-9]{64}$/.test(artworkId)) throw new ArtworkStorageError("ARTWORK_MISSING", "Artwork ID is invalid or missing.");
    const record = this.repository.getOriginal(artworkId);
    if (!record) throw new ArtworkStorageError("ARTWORK_MISSING", "Original artwork is not present in the local cache.");
    const path = originalPathForHash(this.originalsDirectory, record.contentHash, record.extension);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await readFile(path)); } catch (error) {
      if (isMissing(error)) throw new ArtworkStorageError("ARTWORK_MISSING", "Cached original artwork file is missing.", error);
      throw error;
    }
    if (sha256(bytes) !== record.contentHash || bytes.byteLength !== record.byteLength) throw new ArtworkStorageError("ARTWORK_CONTENT_CORRUPT", "Cached original artwork failed its byte-for-byte SHA-256 validation.");
    return { ...record, bytes };
  }

  listUploads() {
    return this.repository.listUploads();
  }
}
