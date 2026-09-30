import { openProjectDatabase } from "../persistence/projects/database";
import type Database from "better-sqlite3";
import { ProjectRepository } from "../persistence/projects/repository";

let defaultProjectDatabase: Database.Database | undefined;
let defaultProjectRepository: ProjectRepository | undefined;

/** Opens the separate project database once so Projects and Templates share one FK domain. */
export function getProjectDatabase(): Database.Database {
  defaultProjectDatabase ??= openProjectDatabase();
  return defaultProjectDatabase;
}

export function getProjectRepository(): ProjectRepository {
  defaultProjectRepository ??= new ProjectRepository(getProjectDatabase());
  return defaultProjectRepository;
}
