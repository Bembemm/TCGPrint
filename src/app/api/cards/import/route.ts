import { getCardWorkbench } from "../../../../../services/card-workbench";
import { handleCardImport } from "../../../../../services/card-api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleCardImport(request, await getCardWorkbench());
}
