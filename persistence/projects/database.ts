import { chmodSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { openSqliteDatabase } from "../sqlite";
import { migrateProjectDatabase } from "./migrations";

export { PROJECT_DATABASE_SCHEMA_VERSION } from "./migrations";

/** Resolves Projects storage beneath the app data root selected by the service. */
export function projectDatabasePath(baseDirectory: string): string {
  return resolve(baseDirectory, ".tcgprint", "projects.sqlite");
}

export const DEFAULT_PROJECT_DATABASE_PATH = projectDatabasePath(process.env.TCGPRINT_DATA_DIR ?? process.cwd());

/** Opens only the durable projects database and applies its project-owned schema. */
export function openProjectDatabase(databasePath = DEFAULT_PROJECT_DATABASE_PATH) {
  if (databasePath !== ":memory:") {
    const databaseDirectory = dirname(resolve(databasePath));
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
    if (basename(databaseDirectory) === ".tcgprint" && process.platform !== "win32") {
      chmodSync(databaseDirectory, 0o700);
    }
  }
  const database = openSqliteDatabase(databasePath === ":memory:" ? databasePath : join(resolve(databasePath)));
  try {
    migrateProjectDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
