import type Database from "better-sqlite3";

export const PROJECT_DATABASE_SCHEMA_VERSION = 1;

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
  });
  migrate.immediate();
  return version;
}
