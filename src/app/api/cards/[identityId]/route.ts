import { getCardWorkbench } from "../../../../../services/card-workbench";
import { handleIdentityDetails } from "../../../../../services/card-api";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ identityId: string }> }): Promise<Response> {
  const { identityId } = await context.params;
  return handleIdentityDetails(request, identityId, await getCardWorkbench());
}
