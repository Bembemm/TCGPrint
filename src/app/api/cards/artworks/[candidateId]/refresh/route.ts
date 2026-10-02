import { getCardWorkbench } from "../../../../../../../services/card-workbench";
import { handleMpcArtworkRefresh } from "../../../../../../../services/card-api";

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext<"/api/cards/artworks/[candidateId]/refresh">): Promise<Response> {
  const { candidateId } = await context.params;
  return handleMpcArtworkRefresh(request, candidateId, await getCardWorkbench());
}
