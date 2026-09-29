import { handleProjectDiscardRecovery, handleProjectStageRecovery } from "../../../../../../services/project-api";
import { getProjectRepository } from "../../../../../../services/project-repository";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await context.params;
  return handleProjectStageRecovery(request, projectId, getProjectRepository());
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await context.params;
  return handleProjectDiscardRecovery(request, projectId, getProjectRepository());
}
