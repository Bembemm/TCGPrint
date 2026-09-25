import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { thumbnailPathForHash } from "./paths";
import type { ArtworkRepository } from "./repository";
import { ArtworkStorageError } from "./types";
import { validateImageBytes } from "./image-validation";

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ArtworkThumbnailStore {
  private readonly thumbnailsDirectory: string;
  private readonly repository: ArtworkRepository;

  constructor(thumbnailsDirectory: string, repository: ArtworkRepository) {
    this.thumbnailsDirectory = thumbnailsDirectory;
    this.repository = repository;
  }

  async putThumbnail(candidateId: string, bytes: Uint8Array, metadata: { sourceArtworkId?: string; widthPx?: number; heightPx?: number; [key: string]: unknown }) {
    const image = await validateImageBytes(bytes, 10 * 1024 * 1024);
    const contentHash = digest(bytes);
    const thumbnailId = digest(`${candidateId}\0${contentHash}`);
    const path = thumbnailPathForHash(this.thumbnailsDirectory, contentHash, image.extension);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const stored = await readFile(path);
      if (digest(stored) !== contentHash) throw new ArtworkStorageError("ARTWORK_CONTENT_CORRUPT", "Cached thumbnail bytes do not match their content hash.");
    }
    this.repository.putThumbnail({
      candidateId,
      thumbnailId,
      contentHash,
      extension: image.extension,
      byteLength: bytes.byteLength,
      widthPx: metadata.widthPx ?? image.widthPx,
      heightPx: metadata.heightPx ?? image.heightPx,
      sourceArtworkId: metadata.sourceArtworkId,
      metadataJson: JSON.stringify(metadata),
    });
    return { thumbnailId, contentHash, extension: image.extension, byteLength: bytes.byteLength, widthPx: metadata.widthPx ?? image.widthPx, heightPx: metadata.heightPx ?? image.heightPx };
  }

  async getThumbnail(candidateId: string) {
    const record = this.repository.getThumbnail(candidateId);
    if (!record) return undefined;
    const path = thumbnailPathForHash(this.thumbnailsDirectory, record.contentHash, record.extension);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await readFile(path)); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
    if (digest(bytes) !== record.contentHash || bytes.byteLength !== record.byteLength) throw new ArtworkStorageError("ARTWORK_CONTENT_CORRUPT", "Cached thumbnail failed its SHA-256 validation.");
    return { ...record, bytes, metadata: JSON.parse(record.metadataJson) as Record<string, unknown> };
  }
}
