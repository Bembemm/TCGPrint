import { TemplateFileStoreError } from "../templates/file-store";
import { TemplateValidationError } from "../templates/validation";
import type { TemplateSelection } from "../templates/types";
import { TemplateLibraryError, TemplateLibraryService } from "./template-library";
import { TemplateRepositoryError } from "../persistence/templates/repository";

export const MAX_TEMPLATE_MULTIPART_BODY_BYTES = 102 * 1024 * 1024;

class TemplateApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "TemplateApiRequestError";
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof TemplateApiRequestError) {
    return Response.json({ code: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof TemplateValidationError) {
    const status = error.code === "TEMPLATE_FILE_TOO_LARGE" ? 413 : 400;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  if (error instanceof TemplateLibraryError) {
    const status = error.code === "TEMPLATE_UPLOAD_LIMIT" ? 413
      : error.code === "TEMPLATE_NOT_FOUND" ? 404 : 400;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  if (error instanceof TemplateFileStoreError) {
    const status = error.code === "TEMPLATE_FILE_MISSING" ? 410
      : error.code === "TEMPLATE_FILE_CORRUPT" ? 409
        : error.code === "TEMPLATE_FILE_TOO_LARGE" ? 413
          : error.code === "TEMPLATE_FILE_INVALID" ? 400 : 500;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  if (error instanceof TemplateRepositoryError) {
    const status = error.code === "TEMPLATE_NOT_FOUND" ? 404
      : error.code === "TEMPLATE_REFERENCED" || error.code === "TEMPLATE_VERSION_CONFLICT" || error.code === "TEMPLATE_IDENTITY_MISMATCH" ? 409
        : error.code === "TEMPLATE_INVALID" ? 400 : 500;
    return Response.json({ code: error.code, message: error.message, ...(error.referenceCount === undefined ? {} : { referenceCount: error.referenceCount }) }, { status });
  }
  return Response.json({ code: "TEMPLATE_API_FAILED", message: "The template request failed." }, { status: 500 });
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TemplateApiRequestError(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.");
    if (parsed > MAX_TEMPLATE_MULTIPART_BODY_BYTES) throw new TemplateApiRequestError(413, "TEMPLATE_REQUEST_TOO_LARGE", "Template upload request exceeds the multipart body limit.");
  }
  if (!request.body) throw new TemplateApiRequestError(400, "INVALID_TEMPLATE_UPLOAD", "Template upload request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TEMPLATE_MULTIPART_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* The body size limit remains the relevant failure. */ }
        throw new TemplateApiRequestError(413, "TEMPLATE_REQUEST_TOO_LARGE", "Template upload request exceeds the multipart body limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TemplateApiRequestError) throw error;
    throw new TemplateApiRequestError(400, "INVALID_TEMPLATE_UPLOAD", "Template upload body could not be read.");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function parseMultipart(request: Request): Promise<FormData> {
  const bytes = await readBoundedBody(request);
  try {
    const bodyBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(bodyBuffer).set(bytes);
    return await new Request(request.url, { method: "POST", headers: request.headers, body: new Blob([bodyBuffer]) }).formData();
  } catch {
    throw new TemplateApiRequestError(400, "INVALID_TEMPLATE_UPLOAD", "Template upload must use valid multipart form data.");
  }
}

function validTemplateId(value: string): boolean {
  return value.length > 0 && value.length <= 180 && !/[\u0000-\u001f]/.test(value);
}

function validVersion(value: string): boolean {
  return value.length > 0 && value.length <= 80 && !/[\u0000-\u001f]/.test(value);
}

export async function handleTemplateList(_request: Request, library: TemplateLibraryService): Promise<Response> {
  try { return Response.json({ templates: library.list() }); }
  catch (error) { return errorResponse(error); }
}

export async function handleTemplateImport(request: Request, library: TemplateLibraryService): Promise<Response> {
  try {
    const form = await parseMultipart(request);
    const allowedFields = new Set(["metadata", "templateId", "files"]);
    for (const key of new Set(Array.from(form.keys()))) {
      if (!allowedFields.has(key)) throw new TemplateApiRequestError(400, "INVALID_TEMPLATE_UPLOAD", `Unsupported template upload field ${key}.`);
    }
    const metadataValues = form.getAll("metadata");
    if (metadataValues.length !== 1 || typeof metadataValues[0] !== "string") {
      throw new TemplateApiRequestError(400, "INVALID_TEMPLATE_METADATA", "Upload must include one JSON metadata field.");
    }
    const metadataText = metadataValues[0];
    if (new TextEncoder().encode(metadataText).byteLength > 64 * 1024) {
      throw new TemplateApiRequestError(413, "TEMPLATE_METADATA_TOO_LARGE", "Template metadata exceeds 65536 bytes.");
    }
    let metadata: unknown;
    try { metadata = JSON.parse(metadataText) as unknown; }
    catch { throw new TemplateApiRequestError(400, "INVALID_TEMPLATE_METADATA", "Template metadata must be valid JSON."); }

    const idValues = form.getAll("templateId");
    if (idValues.length > 1 || (idValues.length === 1 && typeof idValues[0] !== "string")) {
      throw new TemplateApiRequestError(400, "INVALID_TEMPLATE_ID", "Template ID must be a single text field.");
    }
    const templateId = typeof idValues[0] === "string" ? idValues[0] : undefined;
    if (templateId !== undefined && !validTemplateId(templateId)) throw new TemplateApiRequestError(400, "INVALID_TEMPLATE_ID", "Template ID is invalid.");

    const values = form.getAll("files");
    if (values.length === 0 || values.length > 32 || values.some((value) => typeof value === "string")) {
      throw new TemplateApiRequestError(400, "INVALID_TEMPLATE_FILES", "Upload must contain between 1 and 32 binary files.");
    }
    const files = await Promise.all(values.map(async (value) => {
      const file = value as File;
      return { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    }));
    const result = await library.importTemplate(metadata, files, templateId);
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) { return errorResponse(error); }
}

export async function handleTemplateDelete(_request: Request, templateId: string, library: TemplateLibraryService): Promise<Response> {
  if (!validTemplateId(templateId)) return Response.json({ code: "INVALID_TEMPLATE_ID", message: "Template ID is invalid." }, { status: 400 });
  try {
    library.remove(templateId);
    return Response.json({ deleted: true, id: templateId });
  } catch (error) { return errorResponse(error); }
}

export async function handleTemplateVerify(
  _request: Request,
  templateId: string,
  version: string,
  library: TemplateLibraryService,
  expectedPackageHash?: string | null,
): Promise<Response> {
  if (!validTemplateId(templateId) || !validVersion(version)
    || (expectedPackageHash !== undefined && expectedPackageHash !== null && !/^[a-f0-9]{64}$/.test(expectedPackageHash))) {
    return Response.json({ code: "INVALID_TEMPLATE_SELECTION", message: "Template ID or version is invalid." }, { status: 400 });
  }
  try {
    const selectedVersion = library.getVersion(templateId, version);
    if (!selectedVersion) return Response.json({ code: "TEMPLATE_NOT_FOUND", message: "Template version was not found." }, { status: 404 });
    const selection: TemplateSelection = {
      templateId,
      version,
      packageHash: expectedPackageHash ?? selectedVersion.packageHash,
    };
    return Response.json(await library.inspectSelection(selection));
  } catch (error) { return errorResponse(error); }
}

export async function handleTemplateFileDownload(_request: Request, fileId: string, library: TemplateLibraryService): Promise<Response> {
  if (!validTemplateId(fileId)) return Response.json({ code: "INVALID_TEMPLATE_FILE_ID", message: "Template file ID is invalid." }, { status: 400 });
  try {
    const metadata = library.getFileMetadata(fileId);
    if (!metadata) return Response.json({ code: "TEMPLATE_NOT_FOUND", message: "Template file was not found." }, { status: 404 });
    const bytes = await library.readFile(fileId);
    const asciiFallback = metadata.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encodedName = encodeURIComponent(metadata.fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const responseBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(responseBuffer).set(bytes);
    return new Response(new Blob([responseBuffer]), {
      headers: {
        "Content-Type": metadata.mediaType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return errorResponse(error); }
}
