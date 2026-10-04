import { handleBackLibraryPreview } from "../../../../../../services/back-library-api";
import { getBackLibraryService } from "../../../../../../services/back-library-repository";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }): Promise<Response> {
  const { assetId } = await context.params;
  return handleBackLibraryPreview(request, assetId, getBackLibraryService());
}
