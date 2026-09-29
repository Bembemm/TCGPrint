import type { ProjectDto, ProjectOpenDto } from "../../services/project-api";
import type { ProjectSnapshotV1 } from "../../persistence/projects/serializer";
import { projectSnapshotValue } from "./project-session";

export interface ProjectAutosaveRecoveryApi {
  stageRecovery(projectId: string, expectedRevision: number, snapshot: ProjectSnapshotV1): Promise<unknown>;
  promoteRecovery(projectId: string): Promise<ProjectDto>;
  open(projectId: string): Promise<ProjectOpenDto>;
}

/** Stages before CAS promotion and reconciles a response lost after a successful commit. */
export async function saveProjectWithRecovery(
  api: ProjectAutosaveRecoveryApi,
  projectId: string,
  expectedRevision: number,
  snapshot: ProjectSnapshotV1,
): Promise<ProjectDto> {
  const snapshotKey = projectSnapshotValue(snapshot);
  const reconcileCommittedSave = async (): Promise<ProjectDto | null> => {
    try {
      const latest = await api.open(projectId);
      if (latest.revision === expectedRevision + 1 && projectSnapshotValue(latest.snapshot) === snapshotKey) return latest;
    } catch { /* The queue can retry while retaining this snapshot. */ }
    return null;
  };

  try {
    await api.stageRecovery(projectId, expectedRevision, snapshot);
  } catch (stageError) {
    const reconciled = await reconcileCommittedSave();
    if (reconciled) return reconciled;
    throw stageError;
  }
  try {
    return await api.promoteRecovery(projectId);
  } catch (promotionError) {
    const reconciled = await reconcileCommittedSave();
    if (reconciled) return reconciled;
    throw promotionError;
  }
}
