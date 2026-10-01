import { handleCalibrationSheet } from "../../../../../services/printer-profile-api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleCalibrationSheet(request);
}
