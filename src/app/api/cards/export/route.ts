import { getCardWorkbench } from "../../../../../services/card-workbench";
import { handleCardExport } from "../../../../../services/card-api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleCardExport(request, await getCardWorkbench());
}
