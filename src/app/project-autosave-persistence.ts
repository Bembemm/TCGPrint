import type { ProjectDto, ProjectOpenDto, ProjectSaveState } from "../../services/project-api";
import { projectSnapshotValue } from "./project-session";

export interface ProjectAutosaveRecoveryApi {
  stageRecovery(projectId: string, expectedRevision: number, snapshot: ProjectSaveState["snapshot"], templateSelection: ProjectSaveState["templateSelection"]): Promise<unknown>;
  promoteRecovery(projectId: string): Promise<ProjectDto>;
  open(projectId: string): Promise<ProjectOpenDto>;
}

/** Stages before CAS promotion and reconciles a response lost after a successful commit. */
export async function saveProjectWithRecovery(
  api: ProjectAutosaveRecoveryApi,
  projectId: string,
  expectedRevision: number,
  state: ProjectSaveState,
): Promise<ProjectDto> {
  const snapshotKey = projectSnapshotValue(state.snapshot, state.templateSelection);
  const reconcileCommittedSave = async (): Promise<ProjectDto | null> => {
    try {
      const latest = await api.open(projectId);
      if (latest.revision === expectedRevision + 1
        && projectSnapshotValue(latest.snapshot, latest.templateSelection) === snapshotKey) return latest;
    } catch { /* The queue can retry while retaining this snapshot. */ }
    return null;
  };

  try {
    await api.stageRecovery(projectId, expectedRevision, state.snapshot, state.templateSelection);
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
