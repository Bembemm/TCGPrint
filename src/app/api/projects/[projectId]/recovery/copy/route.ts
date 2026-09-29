import { handleProjectCopyRecovery } from "../../../../../../../services/project-api";
import { getProjectRepository } from "../../../../../../../services/project-repository";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await context.params;
  return handleProjectCopyRecovery(request, projectId, getProjectRepository());
}
