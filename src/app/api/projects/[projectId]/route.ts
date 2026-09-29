import { handleProjectDelete, handleProjectOpen, handleProjectSave } from "../../../../../services/project-api";
import { getProjectRepository } from "../../../../../services/project-repository";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await context.params;
  return handleProjectOpen(request, projectId, getProjectRepository());
}

export async function PUT(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await context.params;
  return handleProjectSave(request, projectId, getProjectRepository());
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await context.params;
  return handleProjectDelete(request, projectId, getProjectRepository());
}
