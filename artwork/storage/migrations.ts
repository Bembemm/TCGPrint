import type Database from "better-sqlite3";

export const ARTWORK_SCHEMA_VERSION = 1;

function migrateToV1(database: Database.Database): void {
  database.exec(`
    CREATE TABLE artwork_metadata_cache (
      cache_key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE artwork_originals (
      artwork_id TEXT PRIMARY KEY NOT NULL CHECK(length(artwork_id) = 64),
      content_hash TEXT NOT NULL UNIQUE CHECK(length(content_hash) = 64),
      format TEXT NOT NULL,
      extension TEXT NOT NULL CHECK(extension IN ('jpg','png','webp','avif','gif','svg','tif')),
      byte_length INTEGER NOT NULL CHECK(byte_length > 0),
      width_px INTEGER NOT NULL CHECK(width_px > 0),
      height_px INTEGER NOT NULL CHECK(height_px > 0),
      created_at TEXT NOT NULL
    );

    CREATE TABLE artwork_provenance (
      provenance_id TEXT PRIMARY KEY NOT NULL,
      artwork_id TEXT NOT NULL REFERENCES artwork_originals(artwork_id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_asset_id TEXT,
      scryfall_id TEXT,
      oracle_id TEXT,
      source_url TEXT,
      downloaded_at TEXT,
      content_type TEXT,
      original_filename TEXT,
      source_path TEXT,
      import_metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(artwork_id, provenance_id)
    );

    CREATE TABLE artwork_identity_links (
      identity_id TEXT NOT NULL,
      artwork_id TEXT NOT NULL REFERENCES artwork_originals(artwork_id) ON DELETE CASCADE,
      face_id TEXT NOT NULL CHECK(face_id IN ('front','back')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(identity_id, artwork_id, face_id)
    );

    CREATE TABLE artwork_thumbnails (
      candidate_id TEXT PRIMARY KEY NOT NULL,
      thumbnail_id TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
      extension TEXT NOT NULL CHECK(extension IN ('jpg','png','webp','avif','gif','svg','tif')),
      byte_length INTEGER NOT NULL CHECK(byte_length > 0),
      width_px INTEGER NOT NULL CHECK(width_px > 0),
      height_px INTEGER NOT NULL CHECK(height_px > 0),
      source_artwork_id TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX artwork_provenance_provider_idx ON artwork_provenance(provider, artwork_id);
    CREATE INDEX artwork_provenance_scryfall_idx ON artwork_provenance(scryfall_id);
    CREATE INDEX artwork_identity_links_artwork_idx ON artwork_identity_links(artwork_id);
  `);
}

/** Applies all cache schema migrations in a deterministic transaction. */
export function migrateArtworkDatabase(database: Database.Database): number {
  let version = Number(database.pragma("user_version", { simple: true }));
  if (version > ARTWORK_SCHEMA_VERSION) throw new Error(`Artwork database schema ${version} is newer than this application supports (${ARTWORK_SCHEMA_VERSION}).`);
  if (version === ARTWORK_SCHEMA_VERSION) return version;
  const migrate = database.transaction(() => {
    if (version < 1) {
      migrateToV1(database);
      database.pragma("user_version = 1");
      version = 1;
    }
  });
  migrate.immediate();
  return version;
}
