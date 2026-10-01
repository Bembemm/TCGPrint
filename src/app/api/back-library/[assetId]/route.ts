import { handleBackLibraryRetire } from "../../../../../services/back-library-api";
import { getBackLibraryService } from "../../../../../services/back-library-repository";

export const runtime = "nodejs";

export async function DELETE(_request: Request, context: { params: Promise<{ assetId: string }> }): Promise<Response> {
  const { assetId } = await context.params;
  return handleBackLibraryRetire(assetId, getBackLibraryService());
}
