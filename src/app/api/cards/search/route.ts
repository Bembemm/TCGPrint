import { getCardWorkbench } from "../../../../../services/card-workbench";
import { handleCardSearch } from "../../../../../services/card-api";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleCardSearch(request, await getCardWorkbench());
}
