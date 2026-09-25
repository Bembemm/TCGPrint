import { getCardWorkbench } from "../../../../../services/card-workbench";
import { handleAutocomplete } from "../../../../../services/card-api";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleAutocomplete(request, await getCardWorkbench());
}
