import { handleProjectCreate, handleProjectList } from "../../../../services/project-api";
import { getProjectRepository } from "../../../../services/project-repository";
import { getBackLibraryService } from "../../../../services/back-library-repository";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleProjectList(request, getProjectRepository());
}

export async function POST(request: Request): Promise<Response> {
  return handleProjectCreate(request, getProjectRepository(), getBackLibraryService());
}
