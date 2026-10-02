import { getCardWorkbench } from "../../../../../../services/card-workbench";
import { handleMpcArtworkCatalogs } from "../../../../../../services/card-api";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleMpcArtworkCatalogs(request, await getCardWorkbench());
}
