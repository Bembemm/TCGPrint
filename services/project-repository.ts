import { openProjectDatabase } from "../persistence/projects/database";
import { ProjectRepository } from "../persistence/projects/repository";

let defaultProjectRepository: ProjectRepository | undefined;

/** Opens the project's separate durable database once for this server process. */
export function getProjectRepository(): ProjectRepository {
  defaultProjectRepository ??= new ProjectRepository(openProjectDatabase());
  return defaultProjectRepository;
}
