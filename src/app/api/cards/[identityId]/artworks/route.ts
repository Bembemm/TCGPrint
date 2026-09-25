import { getCardWorkbench } from "../../../../../../services/card-workbench";
import { handleArtworkList } from "../../../../../../services/card-api";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ identityId: string }> }): Promise<Response> {
  const { identityId } = await context.params;
  return handleArtworkList(request, identityId, await getCardWorkbench());
}
