import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openProjectDatabase, projectDatabasePath } from "../../persistence/projects/database";
import { migrateProjectDatabase } from "../../persistence/projects/migrations";

describe("project database", () => {
  let database: ReturnType<typeof openProjectDatabase> | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates the version-two relational schema in a real SQLite database", () => {
    database = openProjectDatabase(":memory:");

    expect(database.pragma("user_version", { simple: true })).toBe(2);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual([
        { name: "project_recovery" },
        { name: "project_recovery_template_selections" },
        { name: "project_template_selections" },
        { name: "projects" },
        { name: "template_files" },
        { name: "template_versions" },
        { name: "templates" },
      ]);
  });

  it("upgrades a populated version-one Projects database without replacing Projects or recoveries", () => {
    database = new Database(":memory:");
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
      INSERT INTO projects VALUES ('project-1', 'Preservado', 1, 3, '{"projectSchemaVersion":1}', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO project_recovery VALUES ('project-1', 3, 1, '{"projectSchemaVersion":1,"recovery":true}', '2026-01-03T00:00:00.000Z');
      PRAGMA user_version = 1;
    `);

    expect(migrateProjectDatabase(database)).toBe(2);
    expect(database.pragma("user_version", { simple: true })).toBe(2);
    expect(database.prepare("SELECT id, name, revision, snapshot_json FROM projects").get())
      .toEqual({ id: "project-1", name: "Preservado", revision: 3, snapshot_json: '{"projectSchemaVersion":1}' });
    expect(database.prepare("SELECT project_id, base_revision, snapshot_json FROM project_recovery").get())
      .toEqual({ project_id: "project-1", base_revision: 3, snapshot_json: '{"projectSchemaVersion":1,"recovery":true}' });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("resolves the projects database beneath an explicit application data directory", () => {
    const dataDirectory = join(tmpdir(), "tcgprint-custom-data-root");

    expect(projectDatabasePath(dataDirectory)).toBe(join(dataDirectory, ".tcgprint", "projects.sqlite"));
  });

  it.skipIf(process.platform === "win32")("restricts the projects database directory to owner-only access", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "tcgprint-project-private-dir-"));
    temporaryDirectories.push(dataDirectory);
    const databasePath = projectDatabasePath(dataDirectory);
    const databaseDirectory = dirname(databasePath);
    mkdirSync(databaseDirectory, { recursive: true });
    chmodSync(databaseDirectory, 0o755);

    database = openProjectDatabase(databasePath);

    expect(statSync(databaseDirectory).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("does not change permissions on an explicitly supplied external database directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgprint-project-external-dir-"));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o755);

    database = openProjectDatabase(join(directory, "projects.sqlite"));

    expect(statSync(directory).mode & 0o777).toBe(0o755);
  });

  it("rejects a future database schema without modifying its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgprint-project-future-db-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "projects.sqlite");
    const futureDatabase = new Database(path);
    futureDatabase.exec("CREATE TABLE future_marker (value TEXT NOT NULL); INSERT INTO future_marker VALUES ('preserve'); PRAGMA user_version = 3;");
    futureDatabase.close();

    expect(() => openProjectDatabase(path)).toThrow(/newer than this application supports/);

    const unchanged = new Database(path);
    expect(unchanged.pragma("user_version", { simple: true })).toBe(3);
    expect(unchanged.prepare("SELECT value FROM future_marker").get()).toEqual({ value: "preserve" });
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()).toBeUndefined();
    unchanged.close();
  });

  it("cascades project deletion to its recovery row", () => {
    database = openProjectDatabase(":memory:");
    database.prepare("INSERT INTO projects (id, name, project_schema_version, revision, snapshot_json, created_at, updated_at, autosaved_at) VALUES (?, ?, 1, 1, ?, ?, ?, ?)")
      .run("project-1", "Deck", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.prepare("INSERT INTO project_recovery (project_id, base_revision, project_schema_version, snapshot_json, created_at) VALUES (?, 1, 1, ?, ?)")
      .run("project-1", "{}", "2026-01-01T00:00:00.000Z");

    database.prepare("DELETE FROM projects WHERE id = ?").run("project-1");

    expect(database.prepare("SELECT project_id FROM project_recovery").all()).toEqual([]);
  });

  it("rechecks the schema version after another connection migrates before the write lock is acquired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgprint-project-migration-race-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "projects.sqlite");
    const competingDatabase = new Database(path);
    const migratingDatabase = new Database(path);
    const originalTransaction = migratingDatabase.transaction.bind(migratingDatabase);
    const transactionSpy = vi.spyOn(migratingDatabase, "transaction").mockImplementation((callback) => {
      migrateProjectDatabase(competingDatabase);
      return originalTransaction(callback);
    });

    try {
      expect(migrateProjectDatabase(migratingDatabase)).toBe(2);
      expect(migratingDatabase.pragma("user_version", { simple: true })).toBe(2);
      expect(migratingDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
        .toContainEqual({ name: "templates" });
    } finally {
      transactionSpy.mockRestore();
      migratingDatabase.close();
      competingDatabase.close();
    }
  });

  it("rolls back partial DDL and user_version when a migration fails", () => {
    const broken = new Database(":memory:");
    broken.exec("CREATE TABLE project_recovery (marker TEXT NOT NULL)");

    try {
      expect(() => migrateProjectDatabase(broken)).toThrow(/already exists/);
      expect(broken.pragma("user_version", { simple: true })).toBe(0);
      expect(broken.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()).toBeUndefined();
      expect(broken.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_recovery'").get()).toEqual({ name: "project_recovery" });
    } finally {
      broken.close();
    }
  });
});
