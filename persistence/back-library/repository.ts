import type Database from "better-sqlite3";
import { migrateArtworkDatabase } from "../../artwork/storage/migrations";

export interface BackLibraryAssetRecord {
  readonly assetId: string;
  readonly sha256: string;
  readonly format: "jpeg" | "png";
  readonly name: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly retired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BackLibraryAssetRow {
  asset_id: string;
  sha256: string;
  format: string;
  name: string;
  width_px: number;
  height_px: number;
  metadata_json: string;
  retired: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: BackLibraryAssetRow): BackLibraryAssetRecord {
  if (row.format !== "jpeg" && row.format !== "png") throw new Error("Back Library database contains an unsupported format.");
  let metadata: unknown;
  try { metadata = JSON.parse(row.metadata_json) as unknown; } catch { throw new Error("Back Library database contains invalid metadata JSON."); }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Back Library database contains invalid metadata.");
  return {
    assetId: row.asset_id,
    sha256: row.sha256,
    format: row.format,
    name: row.name,
    widthPx: row.width_px,
    heightPx: row.height_px,
    metadata: metadata as BackLibraryAssetRecord["metadata"],
    retired: row.retired === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Durable byte-free Back Library metadata; retired records remain resolvable by immutable ID/hash. */
export class BackLibraryRepository {
  private readonly database: Database.Database;

  constructor(database: Database.Database) {
    this.database = database;
    migrateArtworkDatabase(database);
  }

  get(assetId: string): BackLibraryAssetRecord | undefined {
    const row = this.database.prepare("SELECT * FROM back_library_assets WHERE asset_id = ?").get(assetId) as BackLibraryAssetRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  getByHash(sha256: string): BackLibraryAssetRecord | undefined {
    const row = this.database.prepare("SELECT * FROM back_library_assets WHERE sha256 = ?").get(sha256) as BackLibraryAssetRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listActive(): readonly BackLibraryAssetRecord[] {
    const rows = this.database.prepare("SELECT * FROM back_library_assets WHERE retired = 0 ORDER BY name COLLATE NOCASE, asset_id").all() as BackLibraryAssetRow[];
    return rows.map(mapRow);
  }

  /** Inserts immutable ID/hash metadata, or explicitly revives the same bytes after a re-upload. */
  add(record: Omit<BackLibraryAssetRecord, "retired" | "createdAt" | "updatedAt">, now = new Date().toISOString()): BackLibraryAssetRecord {
    this.database.prepare(`
      INSERT INTO back_library_assets(asset_id, sha256, format, name, width_px, height_px, metadata_json, retired, created_at, updated_at)
      VALUES (@assetId, @sha256, @format, @name, @widthPx, @heightPx, @metadataJson, 0, @now, @now)
      ON CONFLICT(asset_id) DO UPDATE SET retired = 0, updated_at = excluded.updated_at
      WHERE back_library_assets.sha256 = excluded.sha256 AND back_library_assets.format = excluded.format
        AND back_library_assets.width_px = excluded.width_px AND back_library_assets.height_px = excluded.height_px
    `).run({ ...record, metadataJson: JSON.stringify(record.metadata), now });
    const added = this.get(record.assetId);
    if (!added || added.sha256 !== record.sha256) throw new Error("Back Library immutable asset identity conflict.");
    return added;
  }

  retire(assetId: string, now = new Date().toISOString()): BackLibraryAssetRecord | undefined {
    this.database.prepare("UPDATE back_library_assets SET retired = 1, updated_at = ? WHERE asset_id = ?").run(now, assetId);
    return this.get(assetId);
  }
}
