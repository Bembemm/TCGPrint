import { getCardWorkbench } from "../../../../../services/card-workbench";
import { handleResolve } from "../../../../../services/card-api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleResolve(request, await getCardWorkbench());
}
