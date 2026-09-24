import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "../../persistence/sqlite";

describe("SQLite foundation", () => {
  let database: ReturnType<typeof openSqliteDatabase> | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("opens an in-memory SQLite database", () => {
    database = openSqliteDatabase(":memory:");

    expect(database.prepare("SELECT sqlite_version() AS version").get()).toMatchObject({
      version: expect.any(String),
    });
  });

  it("enforces SQLite foreign key constraints", () => {
    database = openSqliteDatabase(":memory:");
    database.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (
        parent_id INTEGER NOT NULL REFERENCES parent(id)
      );
    `);

    expect(() => database?.prepare("INSERT INTO child (parent_id) VALUES (?)").run(1)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("persists data after closing and reopening a file-backed database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgprint-sqlite-"));
    const databasePath = join(directory, "persistence.sqlite");
    let fileDatabase: ReturnType<typeof openSqliteDatabase> | undefined;

    try {
      fileDatabase = openSqliteDatabase(databasePath);
      fileDatabase.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      fileDatabase.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "paper",
        "A4",
      );
      fileDatabase.close();
      fileDatabase = undefined;

      fileDatabase = openSqliteDatabase(databasePath);
      expect(fileDatabase.prepare("SELECT value FROM settings WHERE key = ?").get("paper"))
        .toEqual({ value: "A4" });
    } finally {
      try {
        fileDatabase?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
