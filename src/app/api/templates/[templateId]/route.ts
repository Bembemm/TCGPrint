import { handleTemplateDelete } from "../../../../../services/template-api";
import { getTemplateLibraryService } from "../../../../../services/template-library-repository";

export const runtime = "nodejs";

export async function DELETE(_request: Request, context: { readonly params: Promise<{ readonly templateId: string }> }): Promise<Response> {
  const { templateId } = await context.params;
  return handleTemplateDelete(_request, templateId, getTemplateLibraryService());
}
