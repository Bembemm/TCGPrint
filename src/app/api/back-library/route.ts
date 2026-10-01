import { handleBackLibraryList, handleBackLibraryUpload } from "../../../../services/back-library-api";
import { getBackLibraryService } from "../../../../services/back-library-repository";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return handleBackLibraryList(getBackLibraryService());
}

export async function POST(request: Request): Promise<Response> {
  return handleBackLibraryUpload(request, getBackLibraryService());
}
