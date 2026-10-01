import { handleCutSvgExport } from "../../../../../../services/cut-api";
import { getProjectRepository } from "../../../../../../services/project-repository";
import { getTemplateLibraryService } from "../../../../../../services/template-library-repository";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleCutSvgExport(request, getProjectRepository(), getTemplateLibraryService());
}
