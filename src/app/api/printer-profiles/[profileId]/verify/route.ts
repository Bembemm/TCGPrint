import { handlePrinterProfileVerification } from "../../../../../../services/printer-profile-api";
import { getPrinterProfileRepository } from "../../../../../../services/printer-profile-repository";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ profileId: string }> }): Promise<Response> {
  const { profileId } = await context.params;
  return handlePrinterProfileVerification(request, profileId, getPrinterProfileRepository());
}
