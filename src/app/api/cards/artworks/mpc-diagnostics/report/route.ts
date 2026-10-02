import { getCardWorkbench } from "../../../../../../../services/card-workbench";
import { handleMpcArtworkDiagnosticsReport } from "../../../../../../../services/card-api";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return handleMpcArtworkDiagnosticsReport(await getCardWorkbench());
}
