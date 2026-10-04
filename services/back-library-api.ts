import { BackLibraryError, MAX_BACK_LIBRARY_UPLOAD_BYTES, type BackLibraryService } from "./back-library";
import { extendPreviewBleed } from "./preview-bleed";

const MAX_MULTIPART_OVERHEAD_BYTES = 1_048_576;

function responseError(error: unknown): Response {
  if (error instanceof BackLibraryError) {
    const status = error.code === "BACK_ASSET_NOT_FOUND" ? 404
      : error.code === "BACK_TOO_LARGE" ? 413
        : error.code === "BACK_ORIGINAL_UNAVAILABLE" ? 503
          : 400;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  return Response.json({ code: "BACK_LIBRARY_FAILED", message: "Back Library request failed." }, { status: 500 });
}

async function boundedMultipartRequest(request: Request): Promise<Request> {
  const maximumBytes = MAX_BACK_LIBRARY_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new BackLibraryError("BACK_TOO_LARGE", "Back upload request exceeds the multipart size limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new BackLibraryError("BACK_INVALID_IMAGE", "Back upload request has no body.");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new BackLibraryError("BACK_TOO_LARGE", "Back upload request exceeds the multipart size limit.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return new Request(request.url, { method: "POST", headers: request.headers, body: new Blob([body]) });
}

export async function handleBackLibraryList(service: BackLibraryService): Promise<Response> {
  try { return Response.json({ assets: service.listAll().map((asset) => ({ ...asset, selectable: !asset.retired })) }); }
  catch { return Response.json({ code: "BACK_LIBRARY_FAILED", message: "Back Library could not be read." }, { status: 500 }); }
}

export async function handleBackLibraryPreview(request: Request, assetId: string, service: BackLibraryService): Promise<Response> {
  try {
    if (!/^back:[a-f0-9]{64}$/.test(assetId)) throw new BackLibraryError("BACK_ASSET_NOT_FOUND", "Back Library asset ID is invalid.");
    const record = service.listAll().find((asset) => asset.assetId === assetId);
    if (!record) throw new BackLibraryError("BACK_ASSET_NOT_FOUND", "Back Library asset does not exist.");
    const preview = await service.resolvePreview({ assetId: record.assetId, sha256: record.sha256, format: record.format });
    const url = new URL(request.url);
    const bleedValue = url.searchParams.get("bleedMm");
    const trimWidthValue = url.searchParams.get("trimWidthMm");
    const trimHeightValue = url.searchParams.get("trimHeightMm");
    const roundedValue = url.searchParams.get("roundedCorners");
    const cornerRadiusValue = url.searchParams.get("cornerRadiusMm");
    let bytes = preview.bytes;
    let contentType = preview.contentType;
    if (bleedValue !== null || trimWidthValue !== null || trimHeightValue !== null || roundedValue !== null || cornerRadiusValue !== null) {
      if (bleedValue === null || trimWidthValue === null || trimHeightValue === null) {
        throw new BackLibraryError("BACK_INVALID_IMAGE", "Preview bleed requires bleed and physical trim dimensions.");
      }
      if (roundedValue !== null && roundedValue !== "true" && roundedValue !== "false") {
        throw new BackLibraryError("BACK_INVALID_IMAGE", "Preview roundedCorners must be true or false.");
      }
      if (cornerRadiusValue !== null && (roundedValue !== "true" || !Number.isFinite(Number(cornerRadiusValue)))) {
        throw new BackLibraryError("BACK_INVALID_IMAGE", "A physical corner radius requires rounded corners.");
      }
      let extended;
      try {
        extended = await extendPreviewBleed(preview.bytes, preview.contentType, {
          bleedMm: Number(bleedValue),
          trimWidthMm: Number(trimWidthValue),
          trimHeightMm: Number(trimHeightValue),
          roundedCorners: roundedValue === "true",
          ...(cornerRadiusValue !== null ? { cornerRadiusMm: Number(cornerRadiusValue) } : {}),
        });
      } catch (error) {
        if (error instanceof RangeError) throw new BackLibraryError("BACK_INVALID_IMAGE", "Preview bleed geometry is invalid.", error);
        throw error;
      }
      bytes = extended.bytes;
      contentType = extended.contentType;
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
        "X-TCGPrint-Artwork-Role": "preview",
      },
    });
  } catch (error) { return responseError(error); }
}

export async function handleBackLibraryUpload(request: Request, service: BackLibraryService): Promise<Response> {
  try {
    const bounded = await boundedMultipartRequest(request);
    const form = await bounded.formData();
    const file = form.get("file");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function" || typeof file.name !== "string") {
      throw new BackLibraryError("BACK_INVALID_IMAGE", "Upload must contain an image field named file.");
    }
    if (file.size > MAX_BACK_LIBRARY_UPLOAD_BYTES) throw new BackLibraryError("BACK_TOO_LARGE", "Back image exceeds the upload byte limit.");
    let metadata: Readonly<Record<string, unknown>> | undefined;
    const metadataField = form.get("metadata");
    if (metadataField !== null) {
      if (typeof metadataField !== "string" || metadataField.length > 8192) throw new BackLibraryError("BACK_INVALID_METADATA", "Back metadata must be a small JSON object.");
      let parsed: unknown;
      try { parsed = JSON.parse(metadataField) as unknown; } catch { throw new BackLibraryError("BACK_INVALID_METADATA", "Back metadata must be valid JSON."); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BackLibraryError("BACK_INVALID_METADATA", "Back metadata must be a JSON object.");
      metadata = parsed as Readonly<Record<string, unknown>>;
    }
    const asset = await service.add({ bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, ...(metadata ? { metadata } : {}) });
    return Response.json({ asset }, { status: 201 });
  } catch (error) { return responseError(error); }
}

export async function handleBackLibraryRetire(assetId: string, service: BackLibraryService): Promise<Response> {
  try { return Response.json({ asset: service.retire(assetId) }); }
  catch (error) { return responseError(error); }
}
