import { getCardWorkbench } from "../../../../../../../services/card-workbench";
import { handleArtworkPrepare } from "../../../../../../../services/card-api";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ candidateId: string }> }): Promise<Response> {
  const { candidateId } = await context.params;
  return handleArtworkPrepare(request, candidateId, await getCardWorkbench());
}
