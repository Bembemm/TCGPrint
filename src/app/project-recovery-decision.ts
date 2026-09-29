import type { ProjectDto, ProjectOpenDto } from "../../services/project-api";

export type ProjectRecoveryChoice = "restore" | "copy" | "discard";

export interface ProjectRecoveryOperations {
  open(projectId: string): Promise<ProjectOpenDto>;
  promoteRecovery(projectId: string): Promise<ProjectDto>;
  discardRecovery(projectId: string): Promise<unknown>;
  copyRecovery(projectId: string): Promise<ProjectDto>;
}

/** Resolves a recovery decision before the caller replaces the current Working Set. */
export async function resolveProjectRecoveryChoice(
  opened: ProjectOpenDto,
  choice: ProjectRecoveryChoice,
  operations: ProjectRecoveryOperations,
): Promise<ProjectDto> {
  const recovery = opened.recovery;
  if (!recovery) return opened;

  const current = recovery.baseRevision === opened.revision;
  if (choice === "discard") {
    await operations.discardRecovery(opened.id);
    const latest = await operations.open(opened.id);
    if (latest.recovery) throw new Error("A new recovery candidate was staged while this decision was pending.");
    return latest;
  }
  if (choice === "restore" && current) return operations.promoteRecovery(opened.id);
  if (choice === "copy" && !current) return operations.copyRecovery(opened.id);

  throw new Error(current
    ? "A current recovery must be restored or discarded."
    : "An obsolete recovery must be copied or discarded.");
}
