import { getCardWorkbench } from "../../../../../services/card-workbench";
import { handleCardExport } from "../../../../../services/card-api";
import { getProjectRepository } from "../../../../../services/project-repository";
import { getTemplateLibraryService } from "../../../../../services/template-library-repository";
import { getBackLibraryService } from "../../../../../services/back-library-repository";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleCardExport(request, await getCardWorkbench(), getProjectRepository(), getTemplateLibraryService(), getBackLibraryService());
}
