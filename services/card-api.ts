import { artworkQualityFromCandidate, type CardWorkbench } from "./card-workbench";
import { CardExportServiceError, exportWorkingCards } from "./card-export";
import type { ArtworkCatalogSource } from "../artwork/types";
import type { ArtworkCandidate, CardFaceSide, CardIdentity, IdentityResolutionCandidate, SelectedArtwork, WorkingCard, WorkingCardMpcReference } from "../core/cards/types";
import type { UniversalImportRequest } from "../import-engine/types";
import { sanitizeRelativeImportPath } from "../import-engine/source-path";
import { ImportFailureError } from "../import-engine/errors";
import { ScryfallError } from "../providers/scryfall/errors";
import { ArtworkStorageError } from "../artwork/storage/types";

const FORBIDDEN_PROPERTIES = new Set(["originalBytes", "bytes", "sourcePath", "localOriginalPath", "originalUri", "previewUri", "filePaths", "absolutePath", "filesystemPath"]);
const SOURCES = new Set(["scryfall", "upload", "mpc", "url", "custom"]);
const RESOLUTION_STATUSES = new Set(["resolved", "suggested", "ambiguous", "unresolved", "custom"]);
const RESOLUTION_METHODS = new Set(["scryfall-id", "set-collector", "name", "filename", "ocr", "fuzzy", "manual", "custom"]);

class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ApiRequestError"; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function rejectPrivate(value: unknown, path = ""): void {
  if (Array.isArray(value)) { value.forEach((item, index) => rejectPrivate(item, `${path}[${index}]`)); return; }
  const item = record(value);
  if (!item) return;
  for (const [key, child] of Object.entries(item)) {
    if (FORBIDDEN_PROPERTIES.has(key)) throw new ApiRequestError(400, "PRIVATE_FIELD_REJECTED", `Request field ${key} is not accepted by this endpoint.`);
    if (key === "imageUrl" && !path.startsWith("jsonMappings")) throw new ApiRequestError(400, "PRIVATE_FIELD_REJECTED", "Request field imageUrl is not accepted by the card workbench.");
    rejectPrivate(child, path ? `${path}.${key}` : key);
  }
}

function requiredString(value: unknown, key: string, maximum = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new ApiRequestError(400, "INVALID_REQUEST", `${key} must be a non-empty string of at most ${maximum} characters.`);
  return value;
}

function optionalString(value: unknown, key: string, maximum = 256): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, key, maximum);
}

function safeIdentity(value: unknown): CardIdentity | null {
  if (value === null || value === undefined) return null;
  const input = record(value);
  if (!input) throw new ApiRequestError(400, "INVALID_REQUEST", "identity must be an object or null.");
  const method = requiredString(input.resolutionMethod, "identity.resolutionMethod", 32);
  if (!RESOLUTION_METHODS.has(method)) throw new ApiRequestError(400, "INVALID_REQUEST", "identity resolution method is invalid.");
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new ApiRequestError(400, "INVALID_REQUEST", "identity confidence must be between 0 and 1.");
  const rawMetadata = record(input.metadata) ?? {};
  const metadata: Record<string, unknown> = {};
  for (const key of ["layout", "digital", "promo", "fullArt", "imageStatus"]) {
    const item = rawMetadata[key];
    if (typeof item === "string" || typeof item === "boolean") metadata[key] = item;
  }
  if (Array.isArray(rawMetadata.faces)) {
    metadata.faces = rawMetadata.faces.slice(0, 2).flatMap((face) => {
      const item = record(face);
      return item && typeof item.name === "string" ? [{ name: item.name.slice(0, 200) }] : [];
    });
  }
  if (Array.isArray(rawMetadata.relatedCards)) {
    metadata.relatedCards = rawMetadata.relatedCards.slice(0, 50).flatMap((related) => {
      const item = record(related);
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.component !== "string") return [];
      return [{ id: item.id.slice(0, 80), name: item.name.slice(0, 200), component: item.component.slice(0, 40), ...(typeof item.typeLine === "string" ? { typeLine: item.typeLine.slice(0, 200) } : {}) }];
    });
  }
  return {
    id: requiredString(input.id, "identity.id", 180),
    provider: requiredString(input.provider, "identity.provider", 40),
    name: requiredString(input.name, "identity.name", 200),
    ...(optionalString(input.scryfallId, "identity.scryfallId", 80) ? { scryfallId: input.scryfallId as string } : {}),
    ...(optionalString(input.oracleId, "identity.oracleId", 80) ? { oracleId: input.oracleId as string } : {}),
    ...(optionalString(input.setCode, "identity.setCode", 12) ? { setCode: input.setCode as string } : {}),
    ...(optionalString(input.collectorNumber, "identity.collectorNumber", 40) ? { collectorNumber: input.collectorNumber as string } : {}),
    ...(optionalString(input.lang, "identity.lang", 12) ? { lang: input.lang as string } : {}),
    resolutionMethod: method as CardIdentity["resolutionMethod"],
    confidence,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

function safeSelection(value: unknown, side: CardFaceSide): SelectedArtwork | undefined {
  if (value === undefined || value === null) return undefined;
  const input = record(value);
  if (!input) throw new ApiRequestError(400, "INVALID_REQUEST", `selected artwork for ${side} must be an object.`);
  const source = requiredString(input.source, "selected artwork source", 16);
  const faceId = requiredString(input.faceId, "selected artwork face", 8);
  const candidateId = requiredString(input.candidateId, "selected artwork candidate", 128);
  if (!SOURCES.has(source) || faceId !== side || !/^(upload:[a-f0-9]{64}|scryfall:[a-f0-9-]{36}:(front|back)|mpc:[a-f0-9]{64})$/.test(candidateId)) {
    throw new ApiRequestError(400, "INVALID_REQUEST", "selected artwork reference is invalid.");
  }
  return {
    candidateId,
    source: source as SelectedArtwork["source"],
    identityId: typeof input.identityId === "string" ? input.identityId.slice(0, 180) : null,
    faceId: side,
    ...(optionalString(input.providerAssetId, "providerAssetId", 200) ? { providerAssetId: input.providerAssetId as string } : {}),
    ...(optionalString(input.selectedArtworkId, "selectedArtworkId", 200) ? { selectedArtworkId: input.selectedArtworkId as string } : {}),
    ...(optionalString(input.selectionPolicy, "selectionPolicy", 80) ? { selectionPolicy: input.selectionPolicy as string } : {}),
  };
}

function safeResolution(value: unknown, identity: CardIdentity | null): WorkingCard["identityResolution"] {
  const input = record(value) ?? {};
  const status = typeof input.status === "string" && RESOLUTION_STATUSES.has(input.status) ? input.status as WorkingCard["identityResolution"]["status"] : "unresolved";
  const method = typeof input.method === "string" && RESOLUTION_METHODS.has(input.method) ? input.method as WorkingCard["identityResolution"]["method"] : undefined;
  const candidates = Array.isArray(input.candidates) ? input.candidates.slice(0, 20).flatMap((item): IdentityResolutionCandidate[] => {
    const candidate = record(item);
    const candidateIdentity = safeIdentity(candidate?.identity);
    if (!candidate || !candidateIdentity) return [];
    const score = Number(candidate.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) return [];
    return [{ identity: candidateIdentity, score, reason: typeof candidate.reason === "string" ? candidate.reason.slice(0, 300) : "suggested" }];
  }) : [];
  return {
    status,
    ...(method ? { method } : {}),
    ...(optionalString(input.query, "identityResolution.query", 200) ? { query: input.query as string } : {}),
    ...(Number.isFinite(Number(input.confidence)) ? { confidence: Math.max(0, Math.min(1, Number(input.confidence))) } : {}),
    candidates,
    confirmed: input.confirmed === true && Boolean(identity),
  };
}

export function parseWorkingCards(value: unknown): WorkingCard[] {
  rejectPrivate(value);
  if (!Array.isArray(value) || value.length > 500) throw new ApiRequestError(400, "INVALID_REQUEST", "cards must be an array containing at most 500 entries.");
  const cards = value.map((entry, index): WorkingCard => {
    const input = record(entry);
    if (!input) throw new ApiRequestError(400, "INVALID_REQUEST", `cards[${index}] must be an object.`);
    const quantity = Number(input.quantity);
    const order = Number(input.order);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || !Number.isInteger(order) || order < 0) throw new ApiRequestError(400, "INVALID_REQUEST", `cards[${index}] has an invalid quantity or order.`);
    const source = record(input.importSource) ?? {};
    const hints = record(input.identityHints) ?? {};
    const faceItems = Array.isArray(input.faces) ? input.faces.slice(0, 2) : [];
    const faces = faceItems.map((faceValue): WorkingCard["faces"][number] => {
      const face = record(faceValue);
      const side = face?.side;
      if (side !== "front" && side !== "back") throw new ApiRequestError(400, "INVALID_REQUEST", "card face side is invalid.");
      return {
        id: side,
        side,
        ...(optionalString(face?.name, "face.name", 200) ? { name: face!.name as string } : {}),
        ...(optionalString(face?.importedAssetId, "face.importedAssetId", 128) ? { importedAssetId: face!.importedAssetId as string } : {}),
        ...(Array.isArray(face?.slots) ? { slots: face!.slots.slice(0, 100).filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 64)) } : {}),
      };
    });
    if (!faces.some((face) => face.side === "front")) throw new ApiRequestError(400, "INVALID_REQUEST", `cards[${index}] requires a front face.`);
    const identity = safeIdentity(input.identity);
    const selections = record(input.selectedArtworkByFace) ?? {};
    const selectedArtworkByFace: WorkingCard["selectedArtworkByFace"] = {
      ...(safeSelection(selections.front, "front") ? { front: safeSelection(selections.front, "front") } : {}),
      ...(safeSelection(selections.back, "back") ? { back: safeSelection(selections.back, "back") } : {}),
    };
    const localArtworkIds = Array.isArray(input.localArtworkIds) ? [...new Set(input.localArtworkIds.slice(0, 200).map((id) => requiredString(id, "localArtworkId", 80)))].filter((id) => /^upload:[a-f0-9]{64}$/.test(id)) : [];
    const mpcReferences: WorkingCardMpcReference[] = Array.isArray(input.mpcReferences) ? input.mpcReferences.slice(0, 200).flatMap((item): WorkingCardMpcReference[] => {
      const ref = record(item);
      if (!ref || (ref.faceId !== "front" && ref.faceId !== "back")) return [];
      return [{
        faceId: ref.faceId,
        importedAssetId: requiredString(ref.importedAssetId, "mpc importedAssetId", 180),
        ...(optionalString(ref.providerAssetId, "mpc providerAssetId", 200) ? { providerAssetId: ref.providerAssetId as string } : {}),
        ...(optionalString(ref.selectedArtworkId, "mpc selectedArtworkId", 200) ? { selectedArtworkId: ref.selectedArtworkId as string } : {}),
        slots: Array.isArray(ref.slots) ? ref.slots.filter((slot): slot is string => typeof slot === "string").slice(0, 100).map((slot) => slot.slice(0, 64)) : [],
        availableLocally: ref.availableLocally === true,
      }];
    }) : [];
    const cardback = record(input.sharedMpcCardback);
    const cardbackProvenance = record(cardback?.provenance);
    const sharedMpcCardback: WorkingCard["sharedMpcCardback"] = cardback ? {
      importedAssetId: requiredString(cardback.importedAssetId, "shared MPC cardback importedAssetId", 180),
      ...(optionalString(cardback.providerAssetId, "shared MPC cardback providerAssetId", 200) ? { providerAssetId: cardback.providerAssetId as string } : {}),
      ...(optionalString(cardback.selectedArtworkId, "shared MPC cardback selectedArtworkId", 200) ? { selectedArtworkId: cardback.selectedArtworkId as string } : {}),
      originalFormat: requiredString(cardback.originalFormat, "shared MPC cardback originalFormat", 80),
      availableLocally: cardback.availableLocally === true,
      provenance: {
        sourceId: requiredString(cardbackProvenance?.sourceId, "shared MPC cardback provenance sourceId", 180),
        ...(optionalString(cardbackProvenance?.sourceFilename, "shared MPC cardback provenance sourceFilename", 240) ? { sourceFilename: cardbackProvenance!.sourceFilename as string } : {}),
      },
    } : undefined;
    const associations = Array.isArray(input.faceAssociations) ? input.faceAssociations.slice(0, 200).flatMap((item) => {
      const association = record(item);
      if (!association) return [];
      return [{
        slot: requiredString(association.slot, "face association slot", 80),
        ...(optionalString(association.frontAssetId, "frontAssetId", 180) ? { frontAssetId: association.frontAssetId as string } : {}),
        ...(optionalString(association.backAssetId, "backAssetId", 180) ? { backAssetId: association.backAssetId as string } : {}),
        ...(Number.isFinite(Number(association.confidence)) && Number(association.confidence) >= 0 && Number(association.confidence) <= 1 ? { confidence: Number(association.confidence) } : {}),
        ...(optionalString(association.reason, "face association reason", 300) ? { reason: association.reason as string } : {}),
        ...(typeof association.accepted === "boolean" ? { accepted: association.accepted } : {}),
      }];
    }) : [];
    return {
      id: requiredString(input.id, "card.id", 180),
      quantity,
      order,
      ...(optionalString(input.section, "card.section", 80) ? { section: input.section as string } : {}),
      importSource: {
        sourceId: requiredString(source.sourceId, "importSource.sourceId", 180),
        ...(optionalString(source.filename, "importSource.filename", 240) ? { filename: source.filename as string } : {}),
        importKind: requiredString(source.importKind, "importSource.importKind", 60),
        entryKind: requiredString(source.entryKind, "importSource.entryKind", 60),
      },
      identityHints: {
        ...(optionalString(hints.name, "identityHints.name", 200) ? { name: hints.name as string } : {}),
        ...(optionalString(hints.setCode, "identityHints.setCode", 12) ? { setCode: hints.setCode as string } : {}),
        ...(optionalString(hints.collectorNumber, "identityHints.collectorNumber", 40) ? { collectorNumber: hints.collectorNumber as string } : {}),
        ...(optionalString(hints.scryfallId, "identityHints.scryfallId", 80) ? { scryfallId: hints.scryfallId as string } : {}),
        ...(optionalString(hints.language, "identityHints.language", 12) ? { language: hints.language as string } : {}),
      },
      identity,
      identityResolution: safeResolution(input.identityResolution, identity),
      faces,
      selectedArtworkByFace,
      localArtworkIds,
      mpcReferences,
      ...(sharedMpcCardback ? { sharedMpcCardback } : {}),
      faceAssociations: associations,
    };
  });
  return cards;
}

async function parseJsonRequest(request: Request, maximumBytes = 1_000_000): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new ApiRequestError(413, "REQUEST_TOO_LARGE", "Request body exceeds the endpoint size limit.");
  const text = await request.text();
  if (Buffer.byteLength(text) > maximumBytes) throw new ApiRequestError(413, "REQUEST_TOO_LARGE", "Request body exceeds the endpoint size limit.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ApiRequestError(400, "INVALID_JSON", "Request body must be valid JSON."); }
  rejectPrivate(value);
  const input = record(value);
  if (!input) throw new ApiRequestError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  return input;
}

function respondError(error: unknown): Response {
  if (error instanceof ApiRequestError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
  if (error instanceof ImportFailureError && error.code === "INVALID_SOURCE_PATH") return Response.json({ code: error.code, message: error.message }, { status: 400 });
  if (error instanceof CardExportServiceError) {
    const status = error.code === "INVALID_BLEED" ? 400 : error.code === "ARTWORK_REQUIRED" ? 422 : error.code === "UNSUPPORTED_FORMAT" ? 415 : error.code === "ARTWORK_ORIGINAL_UNAVAILABLE" ? 422 : error.code === "EXPORT_TOO_LARGE" ? 413 : 500;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  if (error instanceof ScryfallError) {
    const status = error.kind === "not-found" ? 404 : error.kind === "rate-limited" ? 429 : error.kind === "aborted" ? 499 : error.kind === "timeout" || error.kind === "server" || error.kind === "network" ? 503 : 502;
    return Response.json({ code: `SCRYFALL_${error.kind.toUpperCase().replaceAll("-", "_")}`, message: error.message }, { status });
  }
  if (error instanceof ArtworkStorageError) {
    const status = error.code === "ARTWORK_MISSING" ? 404 : error.code === "ARTWORK_TOO_LARGE" ? 413 : 422;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  return Response.json({ code: "CARD_API_FAILED", message: error instanceof Error ? error.message : "The card request failed." }, { status: 500 });
}

function candidateDto(candidate: ArtworkCandidate) {
  const metadata = candidate.metadata ?? {};
  const safeMetadata: Record<string, unknown> = {};
  for (const key of ["layout", "digital", "promo", "fullArt", "imageStatus", "borderColor", "referenceOnly", "slots", "importedAssetId", "originalFilename", "originalFormat", "contentHash", "provenanceCount"]) {
    if (metadata[key] !== undefined) safeMetadata[key] = metadata[key];
  }
  const safeFilename = typeof safeMetadata.originalFilename === "string" ? safeMetadata.originalFilename.split(/[\\/]/).pop() : undefined;
  if (safeFilename) safeMetadata.originalFilename = safeFilename.replace(/[\u0000-\u001f]/g, "");
  const candidateId = encodeURIComponent(candidate.id);
  return {
    id: candidate.id,
    source: candidate.source,
    identityId: candidate.identityId,
    faceId: candidate.faceId,
    ...(candidate.faceName ? { faceName: candidate.faceName } : {}),
    ...(candidate.previewUri || candidate.source === "upload" ? { previewUri: `/api/cards/artworks/${candidateId}/preview` } : {}),
    ...(candidate.providerAssetId ? { providerAssetId: candidate.providerAssetId } : {}),
    ...(candidate.selectedArtworkId ? { selectedArtworkId: candidate.selectedArtworkId } : {}),
    ...(candidate.scryfallId ? { scryfallId: candidate.scryfallId } : {}),
    ...(candidate.oracleId ? { oracleId: candidate.oracleId } : {}),
    ...(candidate.widthPx ? { widthPx: candidate.widthPx } : {}),
    ...(candidate.heightPx ? { heightPx: candidate.heightPx } : {}),
    ...(candidate.effectiveDpi ? { effectiveDpi: candidate.effectiveDpi } : {}),
    ...(candidate.effectiveDpi ? { resolutionQuality: artworkQualityFromCandidate(candidate) } : {}),
    ...(candidate.setCode ? { setCode: candidate.setCode } : {}),
    ...(candidate.collectorNumber ? { collectorNumber: candidate.collectorNumber } : {}),
    ...(candidate.language ? { language: candidate.language } : {}),
    ...(candidate.releasedAt ? { releasedAt: candidate.releasedAt } : {}),
    originalAvailable: candidate.originalAvailable,
    metadata: safeMetadata,
  };
}

function safeProviderHealth(value: Readonly<Record<string, { available: boolean; degraded: boolean; message?: string }>>) {
  return Object.fromEntries(Object.entries(value).map(([key, health]) => [key, { available: health.available, degraded: health.degraded, ...(health.message ? { message: health.message.slice(0, 300) } : {}) }]));
}

export async function handleCardImport(request: Request, workbench: CardWorkbench): Promise<Response> {
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = await parseJsonRequest(request, 2_000_000);
      const text = requiredString(body.text, "text", 1_500_000);
      const result = await workbench.importForWorkingSet({ text }, { signal: request.signal });
      return Response.json(result);
    }
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 110 * 1024 * 1024) throw new ApiRequestError(413, "REQUEST_TOO_LARGE", "Import request exceeds the server size limit.");
    const form = await request.formData();
    if ([...form.keys()].some((key) => (FORBIDDEN_PROPERTIES.has(key) && key !== "filePaths") || ["sourcePath", "path"].includes(key))) throw new ApiRequestError(400, "PRIVATE_FIELD_REJECTED", "Filesystem paths and internal byte fields are not accepted by card import.");
    const files = form.getAll("files").filter((item): item is File => item instanceof File);
    if (files.length > 200) throw new ApiRequestError(413, "TOO_MANY_FILES", "At most 200 uploaded files may be imported at once.");
    let total = 0;
    for (const file of files) {
      total += file.size;
      if (file.size > 30 * 1024 * 1024 || total > 100 * 1024 * 1024) throw new ApiRequestError(413, "UPLOAD_TOO_LARGE", "Imported files exceed the upload limit.");
    }
    const filePathsField = form.get("filePaths");
    let filePaths: unknown[] = Array.from({ length: files.length }, () => undefined);
    if (filePathsField !== null) {
      if (typeof filePathsField !== "string" || filePathsField.length > 200_000) throw new ApiRequestError(400, "INVALID_FILE_PATHS", "filePaths must be a small JSON array of relative paths.");
      let parsedPaths: unknown;
      try { parsedPaths = JSON.parse(filePathsField); } catch { throw new ApiRequestError(400, "INVALID_FILE_PATHS", "filePaths must contain valid JSON."); }
      if (!Array.isArray(parsedPaths) || parsedPaths.length !== files.length) throw new ApiRequestError(400, "INVALID_FILE_PATHS", "filePaths must contain one path for each uploaded file.");
      filePaths = parsedPaths.map((path) => {
        try { return sanitizeRelativeImportPath(path); }
        catch { throw new ApiRequestError(400, "INVALID_FILE_PATHS", "Each file path must be a safe relative path of at most 1024 characters."); }
      });
    }
    const fileInputs = await Promise.all(files.map(async (file, index) => {
      const sourcePath = filePaths[index] as string | undefined;
      return {
        filename: file.name.split(/[\\/]/).pop() || "upload",
        bytes: new Uint8Array(await file.arrayBuffer()),
        ...(sourcePath ? { sourcePath, kind: "folder-file" as const } : {}),
      };
    }));
    const text = form.get("text");
    const formJson = (key: string): unknown => {
      const field = form.get(key);
      if (typeof field !== "string" || !field.length) return undefined;
      if (field.length > 200_000) throw new ApiRequestError(413, "MAPPING_TOO_LARGE", `${key} exceeds the form mapping limit.`);
      let value: unknown;
      try { value = JSON.parse(field); } catch { throw new ApiRequestError(400, "INVALID_JSON_FIELD", `${key} must contain valid JSON.`); }
      rejectPrivate(value, key);
      return value;
    };
    const selections = formJson("selections");
    const csvMappings = formJson("csvMappings");
    const jsonMappings = formJson("jsonMappings");
    const result = await workbench.importForWorkingSet({
      files: fileInputs,
      ...(typeof text === "string" && text.length ? { text } : {}),
      ...(record(selections) ? { selections: selections as Readonly<Record<string, string>> as UniversalImportRequest["selections"] } : {}),
      ...(record(csvMappings) ? { csvMappings: csvMappings as UniversalImportRequest["csvMappings"] } : {}),
      ...(record(jsonMappings) ? { jsonMappings: jsonMappings as UniversalImportRequest["jsonMappings"] } : {}),
    }, { signal: request.signal });
    return Response.json(result);
  } catch (error) { return respondError(error); }
}

export async function handleAutocomplete(request: Request, workbench: CardWorkbench): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    if (query.length > 100) throw new ApiRequestError(400, "QUERY_TOO_LONG", "Autocomplete query is limited to 100 characters.");
    const names = await workbench.autocompleteCards(query, { signal: request.signal });
    return Response.json({ names });
  } catch (error) { return respondError(error); }
}

export async function handleCardSearch(request: Request, workbench: CardWorkbench): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    if (query.length > 100) throw new ApiRequestError(400, "QUERY_TOO_LONG", "Search query is limited to 100 characters.");
    const identities = await workbench.searchCardIdentities(query, { signal: request.signal });
    return Response.json({ identities });
  } catch (error) { return respondError(error); }
}

export async function handleResolve(request: Request, workbench: CardWorkbench): Promise<Response> {
  try {
    const body = await parseJsonRequest(request);
    const action = typeof body.action === "string" ? body.action : "resolve";
    if (action === "confirm") {
      const card = parseWorkingCards([body.card])[0];
      const scryfallId = requiredString(body.scryfallId, "scryfallId", 80);
      const updated = await workbench.confirmWorkingCardIdentity(card, scryfallId, { signal: request.signal });
      return Response.json({ workingCards: [updated], providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    }
    if (action === "select") {
      const card = parseWorkingCards([body.card])[0];
      const faceId = body.faceId === "back" ? "back" : body.faceId === "front" ? "front" : undefined;
      if (!faceId) throw new ApiRequestError(400, "INVALID_FACE", "Face must be front or back.");
      const candidateId = requiredString(body.candidateId, "candidateId", 128);
      const candidate = await workbench.getArtworkCandidate(candidateId, { mpcReferences: card.mpcReferences });
      if (!candidate) throw new ApiRequestError(404, "ARTWORK_CANDIDATE_NOT_FOUND", "Artwork candidate is not available in the local catalog.");
      const updated = workbench.selectArtwork(card, faceId, candidate);
      return Response.json({ workingCards: [updated], providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    }
    const cards = parseWorkingCards(body.cards);
    if (action === "custom") return Response.json({ workingCards: cards.map((card) => workbench.keepWorkingCardCustom(card)), providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    if (action !== "resolve") throw new ApiRequestError(400, "INVALID_ACTION", "Action must be resolve, confirm, select or custom.");
    const result = await workbench.resolveWorkingCards(cards, { signal: request.signal });
    return Response.json({ ...result, providerHealth: safeProviderHealth(result.providerHealth) });
  } catch (error) { return respondError(error); }
}

export async function handleIdentityDetails(request: Request, identityId: string, workbench: CardWorkbench): Promise<Response> {
  try {
    requiredString(identityId, "identityId", 180);
    if (identityId.includes("/") || identityId.includes("..")) throw new ApiRequestError(400, "INVALID_ID", "Identity ID is invalid.");
    return Response.json({ identity: await workbench.getIdentityDetails(identityId, { signal: request.signal }) });
  } catch (error) { return respondError(error); }
}

export async function handleArtworkList(request: Request, identityId: string, workbench: CardWorkbench): Promise<Response> {
  try {
    if (identityId.includes("/") || identityId.includes("..")) throw new ApiRequestError(400, "INVALID_ID", "Identity ID is invalid.");
    const body = await parseJsonRequest(request);
    const faceId = body.faceId === "back" ? "back" : body.faceId === "front" || body.faceId === undefined ? "front" : undefined;
    if (!faceId) throw new ApiRequestError(400, "INVALID_FACE", "Face must be front or back.");
    const sourceValue = body.source === undefined ? "all" : body.source;
    if (typeof sourceValue !== "string" || !["all", ...SOURCES].includes(sourceValue)) throw new ApiRequestError(400, "INVALID_SOURCE", "Artwork source filter is invalid.");
    const references: WorkingCardMpcReference[] = Array.isArray(body.mpcReferences) ? body.mpcReferences.slice(0, 100).flatMap((value): WorkingCardMpcReference[] => {
      const ref = record(value);
      if (!ref || (ref.faceId !== "front" && ref.faceId !== "back")) return [];
      return [{ faceId: ref.faceId, importedAssetId: requiredString(ref.importedAssetId, "MPC importedAssetId", 180), ...(optionalString(ref.providerAssetId, "MPC providerAssetId", 200) ? { providerAssetId: ref.providerAssetId as string } : {}), ...(optionalString(ref.selectedArtworkId, "MPC selectedArtworkId", 200) ? { selectedArtworkId: ref.selectedArtworkId as string } : {}), slots: Array.isArray(ref.slots) ? ref.slots.filter((slot): slot is string => typeof slot === "string").slice(0, 100) : [], availableLocally: ref.availableLocally === true }];
    }) : [];
    const candidates = await workbench.listArtworkCandidates(identityId, faceId, sourceValue as ArtworkCatalogSource, { mpcReferences: references, signal: request.signal });
    return Response.json({ candidates: candidates.map(candidateDto), providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
  } catch (error) { return respondError(error); }
}

export async function handleArtworkPreview(request: Request, candidateId: string, workbench: CardWorkbench): Promise<Response> {
  try {
    if (!/^(upload:[a-f0-9]{64}|scryfall:[a-f0-9-]{36}:(front|back)|mpc:[a-f0-9]{64})$/.test(candidateId)) throw new ApiRequestError(400, "INVALID_ID", "Artwork ID is invalid.");
    const preview = await workbench.getArtworkPreview(candidateId, request.signal);
    if (!preview) return Response.json({ code: "PREVIEW_UNAVAILABLE", message: "No local preview is available for this reference." }, { status: 404 });
    return new Response(new Uint8Array(preview.bytes), {
      headers: { "Content-Type": preview.contentType, "Cache-Control": "private, max-age=3600", "X-TCGPrint-Artwork-Role": "preview" },
    });
  } catch (error) { return respondError(error); }
}

export async function handleArtworkPrepare(request: Request, candidateId: string, workbench: CardWorkbench): Promise<Response> {
  try {
    if (!/^(upload:[a-f0-9]{64}|scryfall:[a-f0-9-]{36}:(front|back)|mpc:[a-f0-9]{64})$/.test(candidateId)) throw new ApiRequestError(400, "INVALID_ID", "Artwork ID is invalid.");
    const candidate = await workbench.getArtworkCandidate(candidateId);
    if (!candidate?.originalAvailable) throw new ApiRequestError(404, "ARTWORK_ORIGINAL_UNAVAILABLE", "This reference has no validated original artwork.");
    await workbench.getArtworkOriginal(candidateId, request.signal);
    const updated = await workbench.getArtworkCandidate(candidateId);
    if (!updated) throw new ApiRequestError(404, "ARTWORK_CANDIDATE_NOT_FOUND", "Artwork candidate is not available in the local catalog.");
    return Response.json({ candidate: candidateDto(updated), resolutionQuality: artworkQualityFromCandidate(updated) });
  } catch (error) { return respondError(error); }
}

export async function handleArtworkDownload(request: Request, candidateId: string, workbench: CardWorkbench): Promise<Response> {
  try {
    if (!/^(upload:[a-f0-9]{64}|scryfall:[a-f0-9-]{36}:(front|back)|mpc:[a-f0-9]{64})$/.test(candidateId)) throw new ApiRequestError(400, "INVALID_ID", "Artwork ID is invalid.");
    const candidate = await workbench.getArtworkCandidate(candidateId);
    if (!candidate?.originalAvailable) throw new ApiRequestError(404, "ARTWORK_ORIGINAL_UNAVAILABLE", "This reference has no validated original artwork.");
    const original = await workbench.getArtworkOriginal(candidateId, request.signal);
    const provenance = original.provenance.find((item) => item.provider === candidate.source);
    const contentType = original.format === "jpeg" ? "image/jpeg" : original.format === "svg" ? "image/svg+xml" : `image/${original.format}`;
    return new Response(new Uint8Array(original.bytes), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(original.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${original.contentHash}.${original.extension}"`,
        "Cache-Control": "private, immutable, max-age=31536000",
        "X-TCGPrint-Asset-Role": "validated-original",
        "X-TCGPrint-SHA256": original.contentHash,
        ...(provenance?.provider ? { "X-TCGPrint-Provider": provenance.provider } : {}),
        ...(provenance?.providerAssetId ? { "X-TCGPrint-Provider-Asset-Id": provenance.providerAssetId.replace(/[\r\n]/g, "").slice(0, 200) } : {}),
        ...(provenance?.scryfallId ? { "X-TCGPrint-Scryfall-Id": provenance.scryfallId } : {}),
        ...(provenance?.oracleId ? { "X-TCGPrint-Oracle-Id": provenance.oracleId } : {}),
        ...(provenance?.sourceUrl ? { "X-TCGPrint-Source-URL": encodeURI(provenance.sourceUrl).replace(/[\r\n]/g, "").slice(0, 500) } : {}),
        ...(provenance?.originalFilename ? { "X-TCGPrint-Original-Filename": encodeURIComponent(provenance.originalFilename.split(/[\\/]/).pop() ?? "upload") } : {}),
        ...(provenance?.downloadedAt ? { "X-TCGPrint-Downloaded-At": provenance.downloadedAt } : {}),
      },
    });
  } catch (error) { return respondError(error); }
}

export async function handleCardExport(request: Request, workbench: CardWorkbench): Promise<Response> {
  try {
    const body = await parseJsonRequest(request, 4_000_000);
    const cards = parseWorkingCards(body.cards);
    const options = record(body.options) ?? {};
    const bleedMm = options.bleedMm === undefined ? 0.625 : Number(options.bleedMm);
    const cutGuides = options.cutGuides === "none" ? "none" : options.cutGuides === undefined || options.cutGuides === "full" ? "full" : undefined;
    if (cutGuides === undefined) throw new ApiRequestError(400, "INVALID_CUT_GUIDES", "Cut guides mode must be full or none.");
    const pdf = await exportWorkingCards(workbench, cards, { bleedMm, cutGuides }, request.signal);
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="tcgprint-cards.pdf"', "Cache-Control": "no-store" },
    });
  } catch (error) { return respondError(error); }
}
