import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openProjectDatabase } from "../../persistence/projects/database";
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

  it("creates the version-one relational schema in a real SQLite database", () => {
    database = openProjectDatabase(":memory:");

    expect(database.pragma("user_version", { simple: true })).toBe(1);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual([{ name: "project_recovery" }, { name: "projects" }]);
  });

  it("rejects a future database schema without modifying its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgprint-project-future-db-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "projects.sqlite");
    const futureDatabase = new Database(path);
    futureDatabase.exec("CREATE TABLE future_marker (value TEXT NOT NULL); INSERT INTO future_marker VALUES ('preserve'); PRAGMA user_version = 2;");
    futureDatabase.close();

    expect(() => openProjectDatabase(path)).toThrow(/newer than this application supports/);

    const unchanged = new Database(path);
    expect(unchanged.pragma("user_version", { simple: true })).toBe(2);
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
