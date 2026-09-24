import Database from "better-sqlite3";

/** Opens a local SQLite database with relational constraints enabled. */
export function openSqliteDatabase(databasePath: string) {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  return database;
}
