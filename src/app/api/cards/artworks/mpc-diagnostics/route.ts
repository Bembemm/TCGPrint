import { getCardWorkbench } from "../../../../../../services/card-workbench";
import { handleMpcArtworkDiagnostics } from "../../../../../../services/card-api";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return handleMpcArtworkDiagnostics(await getCardWorkbench());
}
