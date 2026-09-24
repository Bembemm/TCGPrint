import { afterEach, describe, expect, it } from "vitest";
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
});
