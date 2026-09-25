import type Database from "better-sqlite3";

export interface ArtworkProvenance {
  readonly provider: string;
  readonly providerAssetId?: string;
  readonly scryfallId?: string;
  readonly oracleId?: string;
  readonly sourceUrl?: string;
  readonly downloadedAt?: string;
  readonly contentType?: string;
  readonly originalFilename?: string;
  readonly sourcePath?: string;
  readonly importMetadata?: Readonly<Record<string, unknown>>;
}

export interface ArtworkOriginalRecord {
  readonly artworkId: string;
  readonly contentHash: string;
  readonly format: string;
  readonly extension: string;
  readonly byteLength: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly provenance: readonly ArtworkProvenance[];
  readonly createdAt: string;
}

export interface ArtworkOriginal extends ArtworkOriginalRecord {
  readonly bytes: Uint8Array;
}

export class ArtworkStorageError extends Error {
  readonly code: "ARTWORK_MISSING" | "ARTWORK_CONTENT_CORRUPT" | "ARTWORK_INVALID_IMAGE" | "ARTWORK_TOO_LARGE" | "ARTWORK_UNSUPPORTED_FORMAT" | "ARTWORK_METADATA_INVALID";

  constructor(code: ArtworkStorageError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtworkStorageError";
    this.code = code;
  }
}

export type ArtworkDatabase = Database.Database;
