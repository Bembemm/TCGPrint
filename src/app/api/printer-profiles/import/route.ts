import { handlePrinterProfileImport } from "../../../../../services/printer-profile-api";
import { getPrinterProfileRepository } from "../../../../../services/printer-profile-repository";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handlePrinterProfileImport(request, getPrinterProfileRepository());
}
