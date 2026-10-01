import type Database from "better-sqlite3";

export const PROJECT_DATABASE_SCHEMA_VERSION = 5;

function migrateToV1(database: Database.Database): void {
  database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      project_schema_version INTEGER NOT NULL CHECK (project_schema_version >= 1),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      autosaved_at TEXT NOT NULL
    );

    CREATE TABLE project_recovery (
      project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
      project_schema_version INTEGER NOT NULL CHECK (project_schema_version >= 1),
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function migrateToV2(database: Database.Database): void {
  database.exec(`
    CREATE TABLE templates (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 180),
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
      source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 240),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE template_versions (
      template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      version TEXT NOT NULL CHECK (length(trim(version)) BETWEEN 1 AND 80),
      package_hash TEXT NOT NULL CHECK (length(package_hash) = 64 AND package_hash NOT GLOB '*[^0-9a-f]*'),
      paper TEXT NOT NULL CHECK (paper IN ('a4','a3','letter','legal','tabloid','custom')),
      card_format TEXT NOT NULL CHECK (card_format IN ('standard','poker','bridge','tarot','custom')),
      orientation TEXT NOT NULL CHECK (orientation IN ('portrait','landscape')),
      recommended_bleed_mm REAL CHECK (recommended_bleed_mm >= 0 AND recommended_bleed_mm <= 3),
      registration_type TEXT NOT NULL CHECK (registration_type IN ('three-point','four-point','custom','none')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (template_id, version),
      UNIQUE (template_id, version, package_hash)
    );

    CREATE TABLE template_files (
      file_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(file_id)) BETWEEN 1 AND 180),
      template_id TEXT NOT NULL,
      version TEXT NOT NULL,
      relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 1024),
      file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
      extension TEXT NOT NULL CHECK (extension IN ('studio3','dxf','svg','json','zip')),
      media_type TEXT NOT NULL CHECK (
        (extension = 'studio3' AND media_type = 'application/octet-stream' AND lower(file_name) GLOB '*.studio3') OR
        (extension = 'dxf' AND media_type = 'application/dxf' AND lower(file_name) GLOB '*.dxf') OR
        (extension = 'svg' AND media_type = 'image/svg+xml' AND lower(file_name) GLOB '*.svg') OR
        (extension = 'json' AND media_type = 'application/json' AND lower(file_name) GLOB '*.json') OR
        (extension = 'zip' AND media_type = 'application/zip' AND lower(file_name) GLOB '*.zip')
      ),
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      created_at TEXT NOT NULL,
      UNIQUE (template_id, version, relative_path),
      FOREIGN KEY (template_id, version) REFERENCES template_versions(template_id, version) ON DELETE CASCADE
    );

    CREATE INDEX template_files_version_idx ON template_files(template_id, version, relative_path);

    CREATE TABLE project_template_selections (
      project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      template_id TEXT NOT NULL,
      version TEXT NOT NULL,
      package_hash TEXT NOT NULL,
      FOREIGN KEY (template_id, version, package_hash)
        REFERENCES template_versions(template_id, version, package_hash) ON DELETE RESTRICT
    );

    CREATE TABLE project_recovery_template_selections (
      project_id TEXT PRIMARY KEY NOT NULL REFERENCES project_recovery(project_id) ON DELETE CASCADE,
      template_id TEXT NOT NULL,
      version TEXT NOT NULL,
      package_hash TEXT NOT NULL,
      FOREIGN KEY (template_id, version, package_hash)
        REFERENCES template_versions(template_id, version, package_hash) ON DELETE RESTRICT
    );
  `);
}

function migrateToV3(database: Database.Database): void {
  database.exec(`ALTER TABLE template_versions ADD COLUMN registration_config_json TEXT;`);
}

function migrateToV4(database: Database.Database): void {
  database.exec(`ALTER TABLE template_versions ADD COLUMN template_geometry_json TEXT;`);
}

function migrateToV5(database: Database.Database): void {
  database.exec(`
    CREATE TABLE printer_profiles (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 128),
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
      current_version INTEGER NOT NULL CHECK (current_version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE printer_profile_versions (
      profile_id TEXT NOT NULL REFERENCES printer_profiles(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version >= 1),
      profile_hash TEXT NOT NULL CHECK (length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'),
      profile_json TEXT NOT NULL CHECK (length(CAST(profile_json AS BLOB)) <= 65536),
      created_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, version),
      UNIQUE (profile_id, version, profile_hash)
    );

    CREATE INDEX printer_profile_versions_hash_idx ON printer_profile_versions(profile_hash);
    CREATE TRIGGER printer_profile_versions_immutable_update
      BEFORE UPDATE ON printer_profile_versions
      BEGIN SELECT RAISE(ABORT, 'printer profile versions are immutable'); END;
    CREATE TRIGGER printer_profile_versions_immutable_delete
      BEFORE DELETE ON printer_profile_versions
      BEGIN SELECT RAISE(ABORT, 'printer profile versions are immutable'); END;
  `);
}

/** Applies deterministic, transactional migrations for the separate projects database. */
export function migrateProjectDatabase(database: Database.Database): number {
  let version = Number(database.pragma("user_version", { simple: true }));
  if (version > PROJECT_DATABASE_SCHEMA_VERSION) {
    throw new Error(`Project database schema ${version} is newer than this application supports (${PROJECT_DATABASE_SCHEMA_VERSION}).`);
  }
  if (version === PROJECT_DATABASE_SCHEMA_VERSION) return version;

  const migrate = database.transaction(() => {
    version = Number(database.pragma("user_version", { simple: true }));
    if (version > PROJECT_DATABASE_SCHEMA_VERSION) {
      throw new Error(`Project database schema ${version} is newer than this application supports (${PROJECT_DATABASE_SCHEMA_VERSION}).`);
    }
    if (version === PROJECT_DATABASE_SCHEMA_VERSION) return;
    if (version < 1) {
      migrateToV1(database);
      database.pragma("user_version = 1");
      version = 1;
    }
    if (version < 2) {
      migrateToV2(database);
      database.pragma("user_version = 2");
      version = 2;
    }
    if (version < 3) {
      migrateToV3(database);
      database.pragma("user_version = 3");
      version = 3;
    }
    if (version < 4) {
      migrateToV4(database);
      database.pragma("user_version = 4");
      version = 4;
    }
    if (version < 5) {
      migrateToV5(database);
      database.pragma("user_version = 5");
      version = 5;
    }
  });
  migrate.immediate();
  return version;
}
