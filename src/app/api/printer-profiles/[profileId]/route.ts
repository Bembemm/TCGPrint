import { handlePrinterProfileDetail } from "../../../../../services/printer-profile-api";
import { getPrinterProfileRepository } from "../../../../../services/printer-profile-repository";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ profileId: string }> }): Promise<Response> {
  const { profileId } = await context.params;
  return handlePrinterProfileDetail(request, profileId, getPrinterProfileRepository());
}

export async function PATCH(request: Request, context: { params: Promise<{ profileId: string }> }): Promise<Response> {
  const { profileId } = await context.params;
  return handlePrinterProfileDetail(request, profileId, getPrinterProfileRepository());
}
