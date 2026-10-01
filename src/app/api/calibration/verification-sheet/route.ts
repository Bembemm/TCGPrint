import { handleVerificationSheet } from "../../../../../services/printer-profile-api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleVerificationSheet(request);
}
