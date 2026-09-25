import Database from "better-sqlite3";
import { migrateArtworkDatabase } from "../../artwork/storage/migrations";

/** Opens a local SQLite database with relational constraints enabled. */
export function openSqliteDatabase(databasePath: string) {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  return database;
}

/** Opens the server-side artwork cache database and applies deterministic user_version migrations. */
export function openArtworkDatabase(databasePath: string) {
  const database = openSqliteDatabase(databasePath);
  try {
    migrateArtworkDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
