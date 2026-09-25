import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { migrateArtworkDatabase } from "./migrations";
import type { ArtworkOriginalRecord, ArtworkProvenance } from "./types";

interface StoredOriginalRow {
  artwork_id: string;
  content_hash: string;
  format: string;
  extension: string;
  byte_length: number;
  width_px: number;
  height_px: number;
  created_at: string;
}

interface StoredProvenanceRow {
  provider: string;
  provider_asset_id: string | null;
  scryfall_id: string | null;
  oracle_id: string | null;
  source_url: string | null;
  downloaded_at: string | null;
  content_type: string | null;
  original_filename: string | null;
  source_path: string | null;
  import_metadata_json: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function provenanceKey(artworkId: string, provenance: ArtworkProvenance): string {
  return createHash("sha256").update(`${artworkId}\0${canonicalJson(provenance)}`).digest("hex");
}

function mapRecord(row: StoredOriginalRow, provenanceRows: readonly StoredProvenanceRow[]): ArtworkOriginalRecord {
  return {
    artworkId: row.artwork_id,
    contentHash: row.content_hash,
    format: row.format,
    extension: row.extension,
    byteLength: row.byte_length,
    widthPx: row.width_px,
    heightPx: row.height_px,
    createdAt: row.created_at,
    provenance: provenanceRows.map((item) => ({
      provider: item.provider,
      ...(item.provider_asset_id ? { providerAssetId: item.provider_asset_id } : {}),
      ...(item.scryfall_id ? { scryfallId: item.scryfall_id } : {}),
      ...(item.oracle_id ? { oracleId: item.oracle_id } : {}),
      ...(item.source_url ? { sourceUrl: item.source_url } : {}),
      ...(item.downloaded_at ? { downloadedAt: item.downloaded_at } : {}),
      ...(item.content_type ? { contentType: item.content_type } : {}),
      ...(item.original_filename ? { originalFilename: item.original_filename } : {}),
      ...(item.source_path ? { sourcePath: item.source_path } : {}),
      importMetadata: JSON.parse(item.import_metadata_json) as Record<string, unknown>,
    })),
  };
}

export class ArtworkRepository {
  private readonly database: Database.Database;

  constructor(database: Database.Database) {
    this.database = database;
    migrateArtworkDatabase(database);
  }

  getOriginal(artworkId: string): ArtworkOriginalRecord | undefined {
    const row = this.database.prepare("SELECT * FROM artwork_originals WHERE artwork_id = ?").get(artworkId) as StoredOriginalRow | undefined;
    if (!row) return undefined;
    const provenance = this.database.prepare("SELECT * FROM artwork_provenance WHERE artwork_id = ? ORDER BY created_at, provenance_id").all(artworkId) as StoredProvenanceRow[];
    return mapRecord(row, provenance);
  }

  findOriginalByProviderSource(provider: string, providerAssetId: string, sourceUrl: string): ArtworkOriginalRecord | undefined {
    const row = this.database.prepare(`
      SELECT o.* FROM artwork_originals o
      INNER JOIN artwork_provenance p ON p.artwork_id = o.artwork_id
      WHERE p.provider = ? AND p.provider_asset_id = ? AND p.source_url = ?
      ORDER BY p.created_at, p.provenance_id
      LIMIT 1
    `).get(provider, providerAssetId, sourceUrl) as StoredOriginalRow | undefined;
    return row ? this.getOriginal(row.artwork_id) : undefined;
  }

  addOriginal(record: Omit<ArtworkOriginalRecord, "provenance" | "createdAt">, provenance: ArtworkProvenance): ArtworkOriginalRecord {
    const createdAt = new Date().toISOString();
    const key = provenanceKey(record.artworkId, provenance);
    const add = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO artwork_originals(artwork_id, content_hash, format, extension, byte_length, width_px, height_px, created_at)
        VALUES (@artworkId, @contentHash, @format, @extension, @byteLength, @widthPx, @heightPx, @createdAt)
        ON CONFLICT(artwork_id) DO NOTHING
      `).run({ ...record, createdAt });
      this.database.prepare(`
        INSERT INTO artwork_provenance(provenance_id, artwork_id, provider, provider_asset_id, scryfall_id, oracle_id, source_url, downloaded_at, content_type, original_filename, source_path, import_metadata_json, created_at)
        VALUES (@provenanceId, @artworkId, @provider, @providerAssetId, @scryfallId, @oracleId, @sourceUrl, @downloadedAt, @contentType, @originalFilename, @sourcePath, @importMetadataJson, @createdAt)
        ON CONFLICT(provenance_id) DO NOTHING
      `).run({
        provenanceId: key,
        artworkId: record.artworkId,
        provider: provenance.provider,
        providerAssetId: provenance.providerAssetId ?? null,
        scryfallId: provenance.scryfallId ?? null,
        oracleId: provenance.oracleId ?? null,
        sourceUrl: provenance.sourceUrl ?? null,
        downloadedAt: provenance.downloadedAt ?? null,
        contentType: provenance.contentType ?? null,
        originalFilename: provenance.originalFilename ?? null,
        sourcePath: provenance.sourcePath ?? null,
        importMetadataJson: canonicalJson(provenance.importMetadata ?? {}),
        createdAt,
      });
    });
    add.immediate();
    const stored = this.getOriginal(record.artworkId);
    if (!stored) throw new Error("Original artwork record was not persisted.");
    if (stored.contentHash !== record.contentHash || stored.byteLength !== record.byteLength || stored.extension !== record.extension) throw new Error("Artwork ID collides with incompatible stored metadata.");
    return stored;
  }

  listUploads(): readonly ArtworkOriginalRecord[] {
    const rows = this.database.prepare(`
      SELECT DISTINCT o.* FROM artwork_originals o
      INNER JOIN artwork_provenance p ON p.artwork_id = o.artwork_id
      WHERE p.provider = 'upload'
      ORDER BY o.created_at, o.artwork_id
    `).all() as StoredOriginalRow[];
    return rows.map((row) => this.getOriginal(row.artwork_id)!).filter(Boolean);
  }

  linkIdentityArtwork(identityId: string, artworkId: string, faceId: "front" | "back"): void {
    this.database.prepare("INSERT INTO artwork_identity_links(identity_id, artwork_id, face_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(identityId, artworkId, faceId, new Date().toISOString());
  }

  putMetadata(key: string, valueJson: string, expiresAt: number, now = Date.now()): void {
    this.database.prepare(`
      INSERT INTO artwork_metadata_cache(cache_key, value_json, expires_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json, expires_at=excluded.expires_at, updated_at=excluded.updated_at
    `).run(key, valueJson, expiresAt, now);
  }

  getMetadata(key: string): { valueJson: string; expiresAt: number } | undefined {
    const row = this.database.prepare("SELECT value_json, expires_at FROM artwork_metadata_cache WHERE cache_key = ?").get(key) as { value_json: string; expires_at: number } | undefined;
    return row ? { valueJson: row.value_json, expiresAt: row.expires_at } : undefined;
  }

  removeMetadata(key: string): void {
    this.database.prepare("DELETE FROM artwork_metadata_cache WHERE cache_key = ?").run(key);
  }

  putThumbnail(record: { candidateId: string; thumbnailId: string; contentHash: string; extension: string; byteLength: number; widthPx: number; heightPx: number; sourceArtworkId?: string; metadataJson: string }): void {
    this.database.prepare(`
      INSERT INTO artwork_thumbnails(candidate_id, thumbnail_id, content_hash, extension, byte_length, width_px, height_px, source_artwork_id, metadata_json, created_at)
      VALUES (@candidateId, @thumbnailId, @contentHash, @extension, @byteLength, @widthPx, @heightPx, @sourceArtworkId, @metadataJson, @createdAt)
      ON CONFLICT(candidate_id) DO UPDATE SET thumbnail_id=excluded.thumbnail_id, content_hash=excluded.content_hash, extension=excluded.extension, byte_length=excluded.byte_length, width_px=excluded.width_px, height_px=excluded.height_px, source_artwork_id=excluded.source_artwork_id, metadata_json=excluded.metadata_json, created_at=excluded.created_at
    `).run({ ...record, sourceArtworkId: record.sourceArtworkId ?? null, createdAt: new Date().toISOString() });
  }

  getThumbnail(candidateId: string): { thumbnailId: string; contentHash: string; extension: string; byteLength: number; widthPx: number; heightPx: number; sourceArtworkId?: string; metadataJson: string } | undefined {
    const row = this.database.prepare("SELECT * FROM artwork_thumbnails WHERE candidate_id = ?").get(candidateId) as {
      thumbnail_id: string; content_hash: string; extension: string; byte_length: number; width_px: number; height_px: number; source_artwork_id: string | null; metadata_json: string;
    } | undefined;
    if (!row) return undefined;
    return {
      thumbnailId: row.thumbnail_id,
      contentHash: row.content_hash,
      extension: row.extension,
      byteLength: row.byte_length,
      widthPx: row.width_px,
      heightPx: row.height_px,
      ...(row.source_artwork_id ? { sourceArtworkId: row.source_artwork_id } : {}),
      metadataJson: row.metadata_json,
    };
  }
}
