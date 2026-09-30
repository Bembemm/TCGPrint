import { handleTemplateFileDownload } from "../../../../../../services/template-api";
import { getTemplateLibraryService } from "../../../../../../services/template-library-repository";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { readonly params: Promise<{ readonly fileId: string }> }): Promise<Response> {
  const { fileId } = await context.params;
  return handleTemplateFileDownload(_request, fileId, getTemplateLibraryService());
}
