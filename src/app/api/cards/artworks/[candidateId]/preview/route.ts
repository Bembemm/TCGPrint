import { getCardWorkbench } from "../../../../../../../services/card-workbench";
import { handleArtworkPreview } from "../../../../../../../services/card-api";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ candidateId: string }> }): Promise<Response> {
  const { candidateId } = await context.params;
  return handleArtworkPreview(request, candidateId, await getCardWorkbench());
}
