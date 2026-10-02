import { getCardWorkbench } from "../../../../../../services/card-workbench";
import { handleMpcArtworkBatchRevalidation } from "../../../../../../services/card-api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleMpcArtworkBatchRevalidation(request, await getCardWorkbench());
}
