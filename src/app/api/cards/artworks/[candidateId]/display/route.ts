import { getCardWorkbench } from "../../../../../../../services/card-workbench";
import { handleArtworkDisplay } from "../../../../../../../services/card-api";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ candidateId: string }> }): Promise<Response> {
  const { candidateId } = await context.params;
  return handleArtworkDisplay(request, candidateId, await getCardWorkbench());
}
