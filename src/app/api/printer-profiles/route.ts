import { handlePrinterProfileCollection } from "../../../../services/printer-profile-api";
import { getPrinterProfileRepository } from "../../../../services/printer-profile-repository";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handlePrinterProfileCollection(request, getPrinterProfileRepository());
}

export async function POST(request: Request): Promise<Response> {
  return handlePrinterProfileCollection(request, getPrinterProfileRepository());
}
