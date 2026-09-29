import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openSqliteDatabase } from "../sqlite";
import { migrateProjectDatabase } from "./migrations";

export { PROJECT_DATABASE_SCHEMA_VERSION } from "./migrations";

export const DEFAULT_PROJECT_DATABASE_PATH = resolve(process.cwd(), ".tcgprint", "projects.sqlite");

/** Opens only the durable projects database and applies its project-owned schema. */
export function openProjectDatabase(databasePath = DEFAULT_PROJECT_DATABASE_PATH) {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = openSqliteDatabase(databasePath === ":memory:" ? databasePath : join(resolve(databasePath)));
  try {
    migrateProjectDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
