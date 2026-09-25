import type { ArtworkRepository } from "./repository";
import { ArtworkStorageError } from "./types";

export class ArtworkMetadataCache {
  private readonly repository: ArtworkRepository;

  constructor(repository: ArtworkRepository) {
    this.repository = repository;
  }

  putMetadata(key: string, value: unknown, expiresAt: number): void {
    let valueJson: string | undefined;
    try { valueJson = JSON.stringify(value); } catch (error) {
      throw new ArtworkStorageError("ARTWORK_METADATA_INVALID", "Artwork metadata is not JSON serializable.", error);
    }
    if (valueJson === undefined) throw new ArtworkStorageError("ARTWORK_METADATA_INVALID", "Artwork metadata is not JSON serializable.");
    this.repository.putMetadata(key, valueJson, Math.floor(expiresAt));
  }

  getMetadata<T>(key: string, now = Date.now()): T | undefined {
    const record = this.repository.getMetadata(key);
    if (!record) return undefined;
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) {
      this.repository.removeMetadata(key);
      return undefined;
    }
    try { return JSON.parse(record.valueJson) as T; } catch {
      this.repository.removeMetadata(key);
      return undefined;
    }
  }
}
