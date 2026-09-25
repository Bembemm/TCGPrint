import { ImportFailureError, importFiles } from "../../../../../import-engine";
import { toImportPreview } from "../../../../../import-engine/preview";
import type { CsvImportMapping, ImportKind, ImportFileInput, JsonImportMapping } from "../../../../../import-engine/types";

export const runtime = "nodejs";

function parseJsonField<T>(form: FormData, key: string): T | undefined {
  const value = form.get(key);
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new ImportFailureError(`Request field ${key} is not valid JSON.`, "MAPPING_INVALID", undefined, undefined, { cause: error });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    const paths = parseJsonField<string[]>(form, "filePaths") ?? [];
    const fileInputs: ImportFileInput[] = await Promise.all(files.map(async (file, index) => {
      const sourcePath = paths[index] || undefined;
      return {
        filename: file.name.split(/[\\/]/).pop() || file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        ...(sourcePath ? { sourcePath, kind: "folder-file" as const } : {}),
      };
    }));
    const textField = form.get("text");
    const text = typeof textField === "string" && textField.length > 0 ? textField : undefined;
    const result = await importFiles({
      files: fileInputs,
      ...(text !== undefined ? { text } : {}),
      selections: parseJsonField<Readonly<Record<string, ImportKind>>>(form, "selections"),
      csvMappings: parseJsonField<Readonly<Record<string, CsvImportMapping>>>(form, "csvMappings"),
      jsonMappings: parseJsonField<Readonly<Record<string, JsonImportMapping>>>(form, "jsonMappings"),
    }, { signal: request.signal });
    return Response.json(toImportPreview(result));
  } catch (error) {
    const failure = error instanceof ImportFailureError
      ? error
      : new ImportFailureError(error instanceof Error ? error.message : "Import preview failed.", "UNSUPPORTED_INPUT", undefined, undefined, error instanceof Error ? { cause: error } : undefined);
    const status = failure.code === "CANCELLED" ? 499
      : failure.code === "MAPPING_INVALID" ? 400
        : 500;
    return Response.json({ code: failure.code, message: failure.message }, { status });
  }
}
