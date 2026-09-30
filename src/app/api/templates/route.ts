import { handleTemplateImport, handleTemplateList } from "../../../../services/template-api";
import { getTemplateLibraryService } from "../../../../services/template-library-repository";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleTemplateList(request, getTemplateLibraryService());
}

export async function POST(request: Request): Promise<Response> {
  return handleTemplateImport(request, getTemplateLibraryService());
}
