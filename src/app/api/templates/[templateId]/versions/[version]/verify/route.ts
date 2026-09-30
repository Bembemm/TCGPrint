import { handleTemplateVerify } from "../../../../../../../../services/template-api";
import { getTemplateLibraryService } from "../../../../../../../../services/template-library-repository";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { readonly params: Promise<{ readonly templateId: string; readonly version: string }> }): Promise<Response> {
  const { templateId, version } = await context.params;
  const expectedHash = new URL(_request.url).searchParams.get("hash");
  return handleTemplateVerify(_request, templateId, version, getTemplateLibraryService(), expectedHash);
}
