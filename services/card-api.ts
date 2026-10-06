import { artworkQualityFromCandidate, type CardWorkbench } from "./card-workbench";
import { CardExportServiceError, exportWorkingCardsByContentMode, exportWorkingCardsWithDiagnostics, type BackExportPreflight, type CardExportBleedDiagnostic } from "./card-export";
import type { ArtworkCatalogSource } from "../artwork/types";
import type { ArtworkCandidate, BackLibraryAssetReference, CardFaceSide, CardIdentity, IdentityResolutionCandidate, SelectedArtwork, WorkingCard, WorkingCardBackMode, WorkingCardBackModeSelectionPolicy, WorkingCardMpcReference } from "../core/cards/types";
import { isSafeArtworkCandidateId } from "../core/cards/ids";
import { MAX_PHYSICAL_CARDS_PER_EXPORT } from "../core/cards/limits";
import { createPhysicalOrder, validatePhysicalOrder, type PhysicalOrder } from "../core/cards/physical-instance-order";
import { BackSelectionPolicyError, isDoubleFacedIdentity, isEligibleGenericPhysicalBack, isEligibleIdentityFaceSelection } from "../core/cards/back-selection";
import { applyArtworkSelectionScope, applyArtworkSelectionScopeInPhysicalOrder, applyGenericBackScope, applyGenericBackScopeInPhysicalOrder, ArtworkSelectionScopeError, validateArtworkCandidateForCard, type ArtworkSelectionScope, type GenericBackSelectionScope, type GenericBackChoice } from "../core/cards/artwork-selection-scope";
import { sanitizeCardIdentityMetadata } from "../core/cards/safe-identity-metadata";
import type { UniversalImportRequest } from "../import-engine/types";
import { sanitizeRelativeImportPath } from "../import-engine/source-path";
import { ImportFailureError } from "../import-engine/errors";
import { ScryfallError } from "../providers/scryfall/errors";
import { ArtworkStorageError } from "../artwork/storage/types";
import { MpcArtworkProviderError } from "../artwork/mpc-provider";
import { normalizeMpcArtworkFilters, MpcArtworkFilterValidationError } from "../artwork/mpc-contract";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS, parseCutGuideConfig, parseTemplateLayoutGeometry, type CardFormat, type CutGuideConfig, type PageOrientation, type PaperFormat, type TemplateLayoutGeometryMm } from "../core/geometry";
import type { PageMarginsMm } from "../core/geometry";
import { parseRegistrationConfig } from "../core/registration";
import { ProjectRepository, ProjectRepositoryError } from "../persistence/projects/repository";
import type { TemplateLibraryService } from "./template-library";
import { CutSourceError } from "./cut-geometry/errors";
import { resolveProjectCutLayout } from "./cut-geometry/service";
import type { ExportContentMode, MissingBackPolicy } from "../persistence/projects/serializer";
import type { DuplexFlipMode } from "../core/duplex";
import type { BackLibraryOriginalSource } from "./card-export";
import { createSeparatePdfArchive } from "./separate-pdf-archive";
import { CalibrationError, checkPrinterProfileCompatibility, type PrinterProfileSnapshot } from "../core/calibration";
import { verifyPrinterProfileSnapshot } from "../persistence/printer-profiles/hash";
import { MPC_MAX_REVALIDATION_CANDIDATES, type MpcCandidateRevalidationResult } from "../artwork/mpc-provider";
import { createMpcDiagnosticReport } from "../artwork/mpc-diagnostic-report";
import { extendPreviewBleed } from "./preview-bleed";
import { compositorDisplayResponse, DisplayRequestError, parseDisplayWidth } from "./compositor-display-response";

const FORBIDDEN_PROPERTIES = new Set(["originalBytes", "bytes", "sourcePath", "localOriginalPath", "originalUri", "previewUri", "filePaths", "absolutePath", "filesystemPath"]);
const SOURCES = new Set(["scryfall", "upload", "mpc", "url", "custom"]);
const RESOLUTION_STATUSES = new Set(["resolved", "suggested", "ambiguous", "unresolved", "custom"]);
const RESOLUTION_METHODS = new Set(["scryfall-id", "set-collector", "name", "filename", "ocr", "fuzzy", "manual", "custom"]);
const BACK_MODES = new Set<WorkingCardBackMode>(["auto", "project-default", "manual", "none"]);
const BACK_MODE_SELECTION_POLICIES = new Set<WorkingCardBackModeSelectionPolicy>(["automatic", "explicit"]);
const EXPORT_CONTENT_MODES = new Set<ExportContentMode>(["front-only", "back-only", "front-back-separated", "duplex"]);
const MISSING_BACK_POLICIES = new Set<MissingBackPolicy>(["use-project-default", "blank", "warn-and-continue", "block"]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const input = record(value);
  if (input) return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

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

function parseBackLibraryReference(value: unknown, fieldName = "manualBackAsset"): BackLibraryAssetReference | undefined {
  if (value === undefined || value === null) return undefined;
  const input = record(value);
  if (!input) throw new ApiRequestError(400, "INVALID_REQUEST", `${fieldName} must be an immutable Back Library reference.`);
  const sha256 = requiredString(input.sha256, `${fieldName}.sha256`, 64);
  if (!/^[a-f0-9]{64}$/.test(sha256) || input.assetId !== `back:${sha256}` || (input.format !== "jpeg" && input.format !== "png")) {
    throw new ApiRequestError(400, "INVALID_REQUEST", `${fieldName} must include a content-addressed asset ID, SHA-256, and supported format.`);
  }
  return { assetId: input.assetId, sha256, format: input.format };
}

function optionalOrientation(value: unknown, key: string): PageOrientation | undefined {
  if (value === undefined) return undefined;
  if (value !== "portrait" && value !== "landscape") throw new ApiRequestError(400, "INVALID_LAYOUT", `${key} must be portrait or landscape.`);
  return value;
}

function optionalLayoutMm(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2_000) {
    throw new ApiRequestError(400, "INVALID_LAYOUT", `${key} must be a finite millimeter value from 0 to 2000.`);
  }
  return value;
}

function optionalMargins(value: unknown): PageMarginsMm | undefined {
  if (value === undefined) return undefined;
  const margins = record(value);
  const sides = ["top", "right", "bottom", "left"] as const;
  if (!margins || Object.keys(margins).length !== sides.length || sides.some((side) => !Object.hasOwn(margins, side))) {
    throw new ApiRequestError(400, "INVALID_LAYOUT", "marginsMm must contain top, right, bottom, and left values.");
  }
  return Object.fromEntries(sides.map((side) => [side, optionalLayoutMm(margins[side], `marginsMm.${side}`)])) as unknown as PageMarginsMm;
}

function optionalPhysicalFormat(value: unknown, key: string, card: false): PaperFormat | undefined;
function optionalPhysicalFormat(value: unknown, key: string, card: true): CardFormat | undefined;
function optionalPhysicalFormat(value: unknown, key: string, card: boolean): PaperFormat | CardFormat | undefined {
  if (value === undefined) return undefined;
  const source = record(value);
  const fields = card ? ["id", "name", "widthMm", "heightMm", "cornerRadiusMm"] : ["id", "name", "widthMm", "heightMm"];
  const requiredFields = card ? fields.filter((field) => field !== "cornerRadiusMm") : ["name", "widthMm", "heightMm"];
  if (!source || Object.keys(source).some((field) => !fields.includes(field))
    || requiredFields.some((field) => !Object.hasOwn(source, field))) {
    throw new ApiRequestError(400, "INVALID_LAYOUT", `${key} must contain valid physical format metadata.`);
  }
  const name = requiredString(source.name, `${key}.name`, 100);
  if (!card && source.id !== undefined) requiredString(source.id, `${key}.id`, 100);
  const widthMm = optionalLayoutMm(source.widthMm, `${key}.widthMm`);
  const heightMm = optionalLayoutMm(source.heightMm, `${key}.heightMm`);
  if (widthMm === undefined || heightMm === undefined || widthMm <= 0 || heightMm <= 0) {
    throw new ApiRequestError(400, "INVALID_LAYOUT", `${key} dimensions must be greater than zero and at most 2000 mm.`);
  }
  if (!card) return { name, widthMm, heightMm };
  const id = requiredString(source.id, `${key}.id`, 100);
  const cornerRadiusMm = source.cornerRadiusMm === undefined ? undefined : optionalLayoutMm(source.cornerRadiusMm, `${key}.cornerRadiusMm`);
  if (cornerRadiusMm !== undefined && (cornerRadiusMm <= 0 || cornerRadiusMm * 2 > Math.min(widthMm, heightMm))) {
    throw new ApiRequestError(400, "INVALID_LAYOUT", `${key}.cornerRadiusMm exceeds half the smaller card dimension.`);
  }
  return { id, name, widthMm, heightMm, ...(cornerRadiusMm === undefined ? {} : { cornerRadiusMm }) };
}

function optionalGridDimension(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_128) {
    throw new ApiRequestError(400, "INVALID_LAYOUT", `${key} must be an integer from 1 to 1128.`);
  }
  return value as number;
}

function safeIdentity(value: unknown): CardIdentity | null {
  if (value === null || value === undefined) return null;
  const input = record(value);
  if (!input) throw new ApiRequestError(400, "INVALID_REQUEST", "identity must be an object or null.");
  const method = requiredString(input.resolutionMethod, "identity.resolutionMethod", 32);
  if (!RESOLUTION_METHODS.has(method)) throw new ApiRequestError(400, "INVALID_REQUEST", "identity resolution method is invalid.");
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new ApiRequestError(400, "INVALID_REQUEST", "identity confidence must be between 0 and 1.");
  const metadata = sanitizeCardIdentityMetadata(input.metadata);
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
    ...(metadata ? { metadata } : {}),
  };
}

function safeSelection(value: unknown, side: CardFaceSide | undefined, fieldName = "selected artwork"): SelectedArtwork | undefined {
  if (value === undefined || value === null) return undefined;
  const input = record(value);
  if (!input) throw new ApiRequestError(400, "INVALID_REQUEST", `${fieldName} must be an object.`);
  const source = requiredString(input.source, "selected artwork source", 16);
  const faceId = requiredString(input.faceId, "selected artwork face", 8);
  const candidateId = requiredString(input.candidateId, "selected artwork candidate", 128);
  if (!SOURCES.has(source) || (faceId !== "front" && faceId !== "back") || (side !== undefined && faceId !== side) || !isSafeArtworkCandidateId(candidateId)) {
    throw new ApiRequestError(400, "INVALID_REQUEST", "selected artwork reference is invalid.");
  }
  return {
    candidateId,
    source: source as SelectedArtwork["source"],
    identityId: typeof input.identityId === "string" ? input.identityId.slice(0, 180) : null,
    faceId,
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
    const identityHintOrigin = optionalString(source.identityHintOrigin, "importSource.identityHintOrigin", 32);
    if (identityHintOrigin !== undefined && identityHintOrigin !== "explicit-card-hint") throw new ApiRequestError(400, "INVALID_REQUEST", "importSource.identityHintOrigin is invalid.");
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
    const manualBackAsset = parseBackLibraryReference(input.manualBackAsset);
    const manualBackArtwork = safeSelection(input.manualBackArtwork, undefined, "manualBackArtwork");
    if (manualBackArtwork && manualBackArtwork.selectionPolicy !== "user-selected") {
      throw new ApiRequestError(400, "INVALID_BACK_MODE", `cards[${index}].manualBackArtwork must preserve a user-selected override lock.`);
    }
    if (manualBackAsset && manualBackArtwork) throw new ApiRequestError(400, "INVALID_BACK_MODE", `cards[${index}] cannot select both a Back Library asset and provider artwork as its manual back.`);
    const backModeValue = input.backMode;
    if (backModeValue !== undefined && (typeof backModeValue !== "string" || !BACK_MODES.has(backModeValue as WorkingCardBackMode))) {
      throw new ApiRequestError(400, "INVALID_BACK_MODE", `cards[${index}].backMode is invalid.`);
    }
    const legacyManualSelection = backModeValue === undefined && selectedArtworkByFace.back?.selectionPolicy === "user-selected";
    const backMode: WorkingCardBackMode = backModeValue as WorkingCardBackMode | undefined
      ?? (manualBackAsset || manualBackArtwork || legacyManualSelection ? "manual" : isDoubleFacedIdentity(identity) ? "auto" : "project-default");
    const selectionPolicyValue = input.backModeSelectionPolicy;
    if (selectionPolicyValue !== undefined && (typeof selectionPolicyValue !== "string" || !BACK_MODE_SELECTION_POLICIES.has(selectionPolicyValue as WorkingCardBackModeSelectionPolicy))) {
      throw new ApiRequestError(400, "INVALID_BACK_MODE", `cards[${index}].backModeSelectionPolicy is invalid.`);
    }
    const backModeSelectionPolicy: WorkingCardBackModeSelectionPolicy = selectionPolicyValue as WorkingCardBackModeSelectionPolicy | undefined
      ?? (manualBackAsset || manualBackArtwork || legacyManualSelection ? "explicit" : "automatic");
    if (backMode === "manual" && !manualBackAsset && !manualBackArtwork && !selectedArtworkByFace.back) {
      throw new ApiRequestError(400, "INVALID_BACK_MODE", `cards[${index}] manual back requires a selected back face, provider artwork, or Back Library asset.`);
    }
    if ((manualBackAsset || manualBackArtwork) && backMode !== "manual") {
      throw new ApiRequestError(400, "INVALID_BACK_MODE", `cards[${index}] manual back references require manual back mode.`);
    }
    const localArtworkIds = Array.isArray(input.localArtworkIds) ? [...new Set(input.localArtworkIds.slice(0, 200).map((id) => requiredString(id, "localArtworkId", 80)))].filter((id) => /^upload:[a-f0-9]{64}$/.test(id)) : [];
    const mpcReferences: WorkingCardMpcReference[] = Array.isArray(input.mpcReferences) ? input.mpcReferences.slice(0, 200).flatMap((item): WorkingCardMpcReference[] => {
      const ref = record(item);
      if (!ref || (ref.faceId !== "front" && ref.faceId !== "back")) return [];
      const providerCardType = optionalString(ref.providerCardType, "mpc providerCardType", 16);
      if (providerCardType !== undefined && providerCardType !== "CARD" && providerCardType !== "CARDBACK") throw new ApiRequestError(400, "INVALID_REQUEST", "MPC providerCardType is invalid.");
      return [{
        faceId: ref.faceId,
        importedAssetId: requiredString(ref.importedAssetId, "mpc importedAssetId", 180),
        ...(optionalString(ref.providerAssetId, "mpc providerAssetId", 200) ? { providerAssetId: ref.providerAssetId as string } : {}),
        ...(optionalString(ref.selectedArtworkId, "mpc selectedArtworkId", 200) ? { selectedArtworkId: ref.selectedArtworkId as string } : {}),
        ...(providerCardType ? { providerCardType: providerCardType as "CARD" | "CARDBACK" } : {}),
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
        ...(identityHintOrigin ? { identityHintOrigin } : {}),
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
      backMode,
      backModeSelectionPolicy,
      ...(manualBackAsset ? { manualBackAsset } : {}),
      ...(manualBackArtwork ? { manualBackArtwork } : {}),
      localArtworkIds,
      mpcReferences,
      ...(sharedMpcCardback ? { sharedMpcCardback } : {}),
      faceAssociations: associations,
    };
  });
  const ids = new Set<string>();
  for (const card of cards) {
    if (ids.has(card.id)) throw new ApiRequestError(400, "INVALID_REQUEST", `Card ID ${card.id} is duplicated in this export request.`);
    ids.add(card.id);
  }
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

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function respondError(error: unknown): Response {
  if (error instanceof ApiRequestError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
  if (error instanceof DisplayRequestError) return Response.json({ code: "INVALID_DISPLAY_REQUEST", message: error.message }, { status: 400 });
  if (error instanceof BackSelectionPolicyError) return Response.json({ code: "INVALID_PHYSICAL_BACK_SELECTION", message: error.message }, { status: 400 });
  if (error instanceof ArtworkSelectionScopeError) return Response.json({ code: error.code, message: error.message }, { status: 400 });
  if (error instanceof MpcArtworkFilterValidationError) return Response.json({ code: "INVALID_MPC_FILTERS", message: error.message }, { status: 400 });
  if (error instanceof CalibrationError) {
    const status = error.code === "PROFILE_NOT_FOUND" ? 404
      : error.code === "PROFILE_VERSION_MISMATCH" || error.code === "PROFILE_INCOMPATIBLE" || error.code === "PROFILE_REVISION_CONFLICT" ? 409
        : error.code === "PROFILE_IMPORT_TOO_LARGE" ? 413 : 400;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  if (error instanceof ImportFailureError && error.code === "INVALID_SOURCE_PATH") return Response.json({ code: error.code, message: error.message }, { status: 400 });
  if (error instanceof CardExportServiceError) {
    const status = error.code === "INVALID_BLEED" || error.code === "INVALID_ROUNDED_CORNERS" || error.code === "INVALID_BACK_MODE" || error.code === "INVALID_DUPLEX_FLIP" || error.code === "INVALID_CARD_ID" ? 400
      : error.code === "ARTWORK_REQUIRED" || error.code === "BACK_REQUIRED" || error.code === "BACK_ORIGINAL_UNAVAILABLE" || error.code === "ARTWORK_ORIGINAL_UNAVAILABLE" ? 422
        : error.code === "UNSUPPORTED_FORMAT" ? 415 : error.code === "EXPORT_TOO_LARGE" ? 413 : 500;
    const preflight = error.cause && typeof error.cause === "object" && "backs" in error.cause ? error.cause as BackExportPreflight : undefined;
    return Response.json({ code: error.code, message: error.message, ...(preflight ? { preflight } : {}) }, { status });
  }
  if (error instanceof CutSourceError) {
    const status = error.code === "CUT_SOURCE_TOO_LARGE" ? 413
      : error.code === "CUT_SOURCE_INTEGRITY_FAILURE" || error.code === "CUT_SOURCE_DIMENSIONS_MISMATCH" || error.code === "CUT_LAYOUT_MISMATCH" ? 409
        : error.code === "CUT_SOURCE_UNSUPPORTED" ? 422 : 400;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  if (error instanceof ProjectRepositoryError) {
    const status = error.code === "PROJECT_NOT_FOUND" ? 404 : error.code === "PROJECT_REVISION_CONFLICT" ? 409 : 400;
    return Response.json({ code: error.code, message: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision }, { status });
  }
  if (error instanceof ScryfallError) {
    const status = error.kind === "not-found" ? 404 : error.kind === "rate-limited" ? 429 : error.kind === "aborted" ? 499 : error.kind === "timeout" || error.kind === "server" || error.kind === "network" ? 503 : 502;
    return Response.json({ code: `SCRYFALL_${error.kind.toUpperCase().replaceAll("-", "_")}`, message: error.message }, { status });
  }
  if (error instanceof MpcArtworkProviderError) {
    const status = error.kind === "aborted" ? 499
      : error.kind === "timeout" ? 504
        : error.kind === "rate-limited" ? 429
        : error.kind === "asset-too-large" ? 413
          : error.kind === "unsafe-source" || error.kind === "invalid-image" ? 422
            : error.kind === "http" && error.status && error.status < 500 ? 502
              : error.kind === "http" || error.kind === "network" ? 503
                : 502;
    const safeMessages: Readonly<Record<MpcArtworkProviderError["kind"], string>> = {
      http: "MPC artwork service returned an error.",
      "rate-limited": "MPC artwork service is rate limited. Try again shortly.",
      protocol: "MPC artwork service returned an invalid response.",
      "unsafe-source": "MPC artwork source failed security validation.",
      "invalid-image": "MPC artwork bytes failed validation.",
      "unsupported-format": "MPC artwork format is unsupported for export.",
      "asset-too-large": "MPC artwork exceeds the configured size limit.",
      timeout: "MPC artwork request timed out.",
      aborted: "MPC artwork request was cancelled.",
      network: "MPC artwork service is unavailable.",
    };
    return Response.json({ code: `MPC_${error.kind.toUpperCase().replaceAll("-", "_")}`, message: safeMessages[error.kind] }, { status });
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
  for (const key of ["layout", "digital", "promo", "fullArt", "imageStatus", "borderColor", "referenceOnly", "slots", "importedAssetId", "originalFilename", "originalFormat", "contentHash", "provenanceCount", "byteLength", "cardType", "name", "sourceType", "sourceId", "sourceName", "extension", "declaredSize", "dpi", "language", "tags", "priority", "providerRank", "dateCreated", "dateModified", "remoteMetadataStatus", "metadataFreshness", "metadataCheckedAt", "originalFormatKnown", "originalFormatExportable"]) {
    if (metadata[key] === undefined) continue;
    const value = candidate.source === "mpc" ? safeMpcMetadataValue(key, metadata[key]) : metadata[key];
    if (value !== undefined) safeMetadata[key] = value;
  }
  for (const key of ["canonicalCard", "canonicalArtist"] as const) {
    const canonical = record(metadata[key]);
    if (!canonical) continue;
    const safe: Record<string, string> = {};
    const allowed = key === "canonicalCard" ? ["name", "expansionCode", "expansionName", "collectorNumber", "rarity", "scryfallId"] : ["name", "scryfallId"];
    for (const field of allowed) if (typeof canonical[field] === "string" && canonical[field].length <= 160 && !/[\u0000-\u001f\u007f]/u.test(canonical[field] as string) && !/^https?:\/\//i.test(canonical[field] as string)) safe[field] = canonical[field] as string;
    if (Object.keys(safe).length) safeMetadata[key] = safe;
  }
  if (typeof metadata.localAvailabilityHint === "boolean") safeMetadata.localAvailabilityHint = metadata.localAvailabilityHint;
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
    qualityStatus: candidate.effectiveDpi ? "verified"
      : !candidate.originalAvailable ? "unavailable"
        : candidate.source === "mpc" && typeof metadata.dpi === "number" && Number.isFinite(metadata.dpi) && metadata.dpi > 0 ? "provider-reported"
          : "unknown",
    ...(candidate.setCode ? { setCode: candidate.setCode } : {}),
    ...(candidate.collectorNumber ? { collectorNumber: candidate.collectorNumber } : {}),
    ...(candidate.language ? { language: candidate.language } : {}),
    ...(candidate.releasedAt ? { releasedAt: candidate.releasedAt } : {}),
    originalAvailable: candidate.originalAvailable,
    ...(candidate.originalCached !== undefined ? { originalCached: candidate.originalCached } : {}),
    metadata: safeMetadata,
  };
}

function safeMpcMetadataValue(key: string, value: unknown): unknown {
  const safeText = (text: unknown, maximum: number) => typeof text === "string" && text.length > 0 && text.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(text) && !/^https?:\/\//i.test(text) ? text : undefined;
  if (["digital", "promo", "fullArt", "referenceOnly", "originalFormatKnown", "originalFormatExportable", "localAvailabilityHint"].includes(key)) return typeof value === "boolean" ? value : undefined;
  if (["sourceId", "priority", "providerRank", "declaredSize", "byteLength", "dpi", "provenanceCount"].includes(key)) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000 ? value : undefined;
  }
  if (["sourceType", "layout", "imageStatus", "borderColor"].includes(key)) return safeText(value, 80);
  if (key === "cardType") return value === "CARD" || value === "CARDBACK" ? value : undefined;
  if (key === "sourceName" || key === "name") return safeText(value, 200);
  if (key === "language") return typeof value === "string" && /^[a-z0-9-]{1,16}$/i.test(value) ? value.toLowerCase() : undefined;
  if (key === "extension" || key === "originalFormat") return typeof value === "string" && /^(png|jpe?g|svg)$/i.test(value) ? value.toLowerCase() : undefined;
  if (key === "importedAssetId") return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined;
  if (key === "contentHash") return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  if (["dateCreated", "dateModified", "metadataCheckedAt"].includes(key)) {
    return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
  }
  if (key === "remoteMetadataStatus") return ["current", "removed", "invalid", "unsupported", "stale"].includes(String(value)) ? value : undefined;
  if (key === "metadataFreshness") return ["fresh", "stale", "revalidated"].includes(String(value)) ? value : undefined;
  if (["tags", "slots"].includes(key) && Array.isArray(value)) return value.slice(0, 100).flatMap((item) => {
    const text = safeText(item, 120);
    return text ? [text] : [];
  });
  if (key === "originalFilename") return typeof value === "string" ? safeText(value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, ""), 200) : undefined;
  return undefined;
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
        ...(file.type ? { mediaType: file.type.slice(0, 128) } : {}),
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

function artworkSelectionScope(value: unknown): ArtworkSelectionScope {
  if (value === "entry" || value === "physical-copy" || value === "same-identity") return value;
  throw new ApiRequestError(400, "INVALID_SCOPE", "Artwork scope must be entry, physical-copy, or same-identity.");
}

function genericBackSelectionScope(value: unknown): GenericBackSelectionScope {
  if (value === "entry" || value === "physical-copy" || value === "same-identity" || value === "all-simple-project") return value;
  throw new ApiRequestError(400, "INVALID_SCOPE", "Back scope must be entry, physical-copy, same-identity, or all-simple-project.");
}

function physicalCardIndex(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= MAX_PHYSICAL_CARDS_PER_EXPORT) {
    throw new ApiRequestError(400, "INVALID_PHYSICAL_INDEX", `physicalCardIndex must be a zero-based index between 0 and ${MAX_PHYSICAL_CARDS_PER_EXPORT - 1}.`);
  }
  return value as number;
}

function submittedPhysicalOrder(cards: readonly WorkingCard[], value: unknown): PhysicalOrder | undefined {
  if (value === undefined) return undefined;
  try {
    return validatePhysicalOrder(cards, value);
  } catch (error) {
    throw new ApiRequestError(400, "INVALID_PHYSICAL_ORDER", error instanceof Error ? error.message : "Physical order is invalid.");
  }
}

async function getSelectableArtworkCandidate(
  workbench: CardWorkbench,
  card: WorkingCard,
  faceId: CardFaceSide,
  candidateId: string,
  signal: AbortSignal,
): Promise<ArtworkCandidate> {
  let candidate = await workbench.getArtworkCandidate(candidateId, {
    mpcReferences: card.mpcReferences,
    ...(card.identity ? { identity: card.identity } : {}),
    signal,
  });
  if (!candidate) throw new ApiRequestError(404, "ARTWORK_CANDIDATE_NOT_FOUND", "Artwork candidate is not available in the local catalog.");
  if (candidate.id !== candidateId) {
    throw new ArtworkSelectionScopeError("INVALID_ARTWORK_IDENTITY", "The resolved artwork candidate does not match the requested candidate ID.");
  }

  if (candidate.source === "upload") {
    const identityId = card.identity?.id ?? "custom:artwork-picker";
    const scopedUploads = await workbench.listArtworkCandidates(identityId, faceId, "upload", {
      mpcReferences: card.mpcReferences,
      signal,
    });
    const associated = scopedUploads.find((item) => item.id === candidateId);
    if (!associated) {
      throw new ArtworkSelectionScopeError("INVALID_ARTWORK_IDENTITY", "The uploaded artwork is not associated with the requested WorkingCard identity and face.");
    }
    candidate = associated;
  }

  return validateArtworkCandidateForCard(card, faceId, candidate);
}

export async function handleResolve(request: Request, workbench: CardWorkbench): Promise<Response> {
  try {
    const body = await parseJsonRequest(request);
    const action = typeof body.action === "string" ? body.action : "resolve";
    if (action === "reresolve") {
      const card = parseWorkingCards([body.card])[0];
      const updated = await workbench.reresolveWorkingCard(card, { signal: request.signal });
      return Response.json({ workingCards: [updated], providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    }
    if (action === "restore-default-artwork") {
      const card = parseWorkingCards([body.card])[0];
      if (!card.identity) throw new ApiRequestError(409, "NO_RESOLVED_IDENTITY", "Não há identidade resolvida para determinar uma artwork padrão.");
      const faceId = body.faceId === "back" ? "back" : body.faceId === "front" ? "front" : undefined;
      if (!faceId) throw new ApiRequestError(400, "INVALID_FACE", "Face must be front or back.");
      if (!isEligibleIdentityFaceSelection(card, faceId)) {
        throw new ApiRequestError(400, "INVALID_PHYSICAL_BACK_SELECTION", "A simple card's back artwork must use Back Library or a verified MPC cardback.");
      }
      if (!card.faces.some((face) => face.side === faceId)) throw new ApiRequestError(409, "FACE_NOT_AVAILABLE", "A face solicitada não existe nesta carta.");
      let updated: WorkingCard | undefined;
      try {
        updated = await workbench.restoreDefaultArtwork(card, faceId, { signal: request.signal });
      } catch (error) {
        if (!(error instanceof ScryfallError)) throw error;
        const response = respondError(error);
        const payload = await response.json() as Record<string, unknown>;
        return Response.json({ ...payload, providerHealth: safeProviderHealth(workbench.getProviderHealth()) }, { status: response.status });
      }
      if (!updated) throw new ApiRequestError(409, "ARTWORK_DEFAULT_UNAVAILABLE", "Não há artwork padrão disponível para esta face; a seleção atual foi preservada.");
      return Response.json({ workingCards: [updated], providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    }
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
      if (!isEligibleIdentityFaceSelection(card, faceId)) {
        throw new ApiRequestError(400, "INVALID_PHYSICAL_BACK_SELECTION", "A simple card's back artwork must use Back Library or a verified MPC cardback.");
      }
      const candidateId = requiredString(body.candidateId, "candidateId", 128);
      const candidate = await getSelectableArtworkCandidate(workbench, card, faceId, candidateId, request.signal);
      const updated = workbench.selectArtwork(card, faceId, candidate);
      return Response.json({ workingCards: [updated], providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    }
    if (action === "select-manual-back-artwork") {
      const card = parseWorkingCards([body.card])[0];
      const candidateId = requiredString(body.candidateId, "candidateId", 128);
      const candidate = await workbench.getArtworkCandidate(candidateId, {
        mpcReferences: card.mpcReferences,
        ...(card.identity ? { identity: card.identity } : {}),
        signal: request.signal,
      });
      if (!candidate) throw new ApiRequestError(404, "ARTWORK_CANDIDATE_NOT_FOUND", "Artwork candidate is not available in the local catalog.");
      if (!isEligibleGenericPhysicalBack(card, candidate)) {
        throw new ApiRequestError(400, "INVALID_PHYSICAL_BACK_SELECTION", "A simple card's physical back must be a verified MPC cardback.");
      }
      const updated = workbench.selectManualBackArtwork(card, candidate);
      return Response.json({ workingCards: [updated], providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    }
    if (action === "apply-artwork-scope") {
      const cards = parseWorkingCards(body.cards);
      const targetCardId = requiredString(body.targetCardId, "targetCardId", 180);
      const target = cards.find((card) => card.id === targetCardId);
      if (!target) throw new ApiRequestError(404, "CARD_NOT_FOUND", "The selected WorkingCard is not present in the submitted project state.");
      const faceId = body.faceId === "back" ? "back" : body.faceId === "front" ? "front" : undefined;
      if (!faceId) throw new ApiRequestError(400, "INVALID_FACE", "Face must be front or back.");
      if (!isEligibleIdentityFaceSelection(target, faceId) || !target.faces.some((face) => face.side === faceId)) {
        throw new ApiRequestError(400, "INVALID_PHYSICAL_BACK_SELECTION", "A simple card's back artwork must use Back Library or a verified MPC cardback.");
      }
      const scope = artworkSelectionScope(body.scope);
      const selectedPhysicalCardIndex = physicalCardIndex(body.physicalCardIndex);
      const physicalOrder = submittedPhysicalOrder(cards, body.physicalOrder);
      const physicalInstanceId = body.physicalInstanceId === undefined ? undefined : requiredString(body.physicalInstanceId, "physicalInstanceId", 32);
      const candidateId = requiredString(body.candidateId, "candidateId", 128);
      const candidate = await getSelectableArtworkCandidate(workbench, target, faceId, candidateId, request.signal);
      const selected = workbench.selectArtwork(target, faceId, candidate).selectedArtworkByFace[faceId];
      if (!selected) throw new ApiRequestError(409, "ARTWORK_SELECTION_FAILED", "The artwork candidate could not be turned into a durable selection reference.");
      const updated = physicalOrder ? applyArtworkSelectionScopeInPhysicalOrder({
        cards,
        physicalOrder,
        targetCardId,
        faceId,
        artwork: selected,
        scope,
        ...(physicalInstanceId ? { physicalInstanceId } : {}),
      }) : {
        cards: applyArtworkSelectionScope({
          cards,
          targetCardId,
          faceId,
          artwork: selected,
          scope,
          ...(selectedPhysicalCardIndex === undefined ? {} : { physicalCardIndex: selectedPhysicalCardIndex }),
        }),
        physicalOrder: undefined,
        selectedCardId: undefined,
      };
      return Response.json({ workingCards: updated.cards, ...(updated.physicalOrder ? { physicalOrder: updated.physicalOrder, selectedCardId: updated.selectedCardId } : {}), providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    }
    if (action === "apply-generic-back-scope") {
      const cards = parseWorkingCards(body.cards);
      const targetCardId = requiredString(body.targetCardId, "targetCardId", 180);
      const target = cards.find((card) => card.id === targetCardId);
      if (!target) throw new ApiRequestError(404, "CARD_NOT_FOUND", "The selected WorkingCard is not present in the submitted project state.");
      if (isDoubleFacedIdentity(target.identity)) throw new ApiRequestError(400, "INVALID_PHYSICAL_BACK_SELECTION", "A double-faced card's Back tab edits its real face and cannot use generic cardback actions.");
      const scope = genericBackSelectionScope(body.scope);
      const choiceMode = body.choiceMode;
      let choice: GenericBackChoice;
      let candidate: ArtworkCandidate | undefined;
      if (choiceMode === "none" || choiceMode === "project-default") {
        choice = { mode: choiceMode };
      } else if (choiceMode === "library") {
        const asset = parseBackLibraryReference(body.asset, "asset");
        if (!asset) throw new ApiRequestError(400, "INVALID_REQUEST", "A library back selection requires an immutable Back Library asset reference.");
        choice = { mode: "library", asset };
      } else if (choiceMode === "mpc") {
        const candidateId = requiredString(body.candidateId, "candidateId", 128);
        candidate = await workbench.getArtworkCandidate(candidateId, {
          mpcReferences: target.mpcReferences,
          ...(target.identity ? { identity: target.identity } : {}),
          signal: request.signal,
        });
        if (!candidate || !isEligibleGenericPhysicalBack(target, candidate)) {
          throw new ApiRequestError(400, "INVALID_PHYSICAL_BACK_SELECTION", "A simple card's physical back must be a verified MPC cardback.");
        }
        choice = { mode: "mpc", candidate };
      } else {
        throw new ApiRequestError(400, "INVALID_BACK_CHOICE", "Generic back choice must be a Back Library asset, MPC cardback, Project Default, or none.");
      }
      const selectedPhysicalCardIndex = physicalCardIndex(body.physicalCardIndex);
      const physicalOrder = submittedPhysicalOrder(cards, body.physicalOrder);
      const physicalInstanceId = body.physicalInstanceId === undefined ? undefined : requiredString(body.physicalInstanceId, "physicalInstanceId", 32);
      const result = physicalOrder ? applyGenericBackScopeInPhysicalOrder({
        cards,
        physicalOrder,
        targetCardId,
        choice,
        scope,
        ...(physicalInstanceId ? { physicalInstanceId } : {}),
      }) : applyGenericBackScope({
        cards,
        targetCardId,
        choice,
        scope,
        ...(selectedPhysicalCardIndex === undefined ? {} : { physicalCardIndex: selectedPhysicalCardIndex }),
      });
      const targetCardIds = new Set(result.targetCardIds);
      const updatedCards = candidate
        ? result.cards.map((card) => targetCardIds.has(card.id) && card.manualBackArtwork?.candidateId === candidate!.id ? workbench.selectManualBackArtwork(card, candidate!) : card)
        : result.cards;
      return Response.json({ workingCards: updatedCards, ...(result.physicalOrder ? { physicalOrder: result.physicalOrder, selectedCardId: result.targetCardIds[0] } : {}), impact: {
        affectedEntries: result.affectedEntries,
        affectedPhysicalCards: result.affectedPhysicalCards,
        preservedDfcEntries: result.preservedDfcEntries,
        preservedDfcPhysicalCards: result.preservedDfcPhysicalCards,
      }, providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    }
    const cards = parseWorkingCards(body.cards);
    if (action === "custom") return Response.json({ workingCards: cards.map((card) => workbench.keepWorkingCardCustom(card)), providerHealth: safeProviderHealth(workbench.getProviderHealth()) });
    if (action !== "resolve") throw new ApiRequestError(400, "INVALID_ACTION", "Action must be resolve, reresolve, confirm, select, select-manual-back-artwork, apply-artwork-scope, apply-generic-back-scope, restore-default-artwork or custom.");
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
    if (body.physicalBackArtwork !== undefined && typeof body.physicalBackArtwork !== "boolean") throw new ApiRequestError(400, "INVALID_REQUEST", "physicalBackArtwork must be a boolean.");
    if (body.forceMpcRefresh !== undefined && typeof body.forceMpcRefresh !== "boolean") throw new ApiRequestError(400, "INVALID_REQUEST", "forceMpcRefresh must be a boolean.");
    const mpcFilters = body.mpcFilters === undefined ? undefined : normalizeMpcArtworkFilters(body.mpcFilters);
    const references: WorkingCardMpcReference[] = Array.isArray(body.mpcReferences) ? body.mpcReferences.slice(0, 100).flatMap((value): WorkingCardMpcReference[] => {
      const ref = record(value);
      if (!ref || (ref.faceId !== "front" && ref.faceId !== "back")) return [];
      const providerCardType = optionalString(ref.providerCardType, "MPC providerCardType", 16);
      if (providerCardType !== undefined && providerCardType !== "CARD" && providerCardType !== "CARDBACK") throw new ApiRequestError(400, "INVALID_REQUEST", "MPC providerCardType is invalid.");
      return [{ faceId: ref.faceId, importedAssetId: requiredString(ref.importedAssetId, "MPC importedAssetId", 180), ...(optionalString(ref.providerAssetId, "MPC providerAssetId", 200) ? { providerAssetId: ref.providerAssetId as string } : {}), ...(optionalString(ref.selectedArtworkId, "MPC selectedArtworkId", 200) ? { selectedArtworkId: ref.selectedArtworkId as string } : {}), ...(providerCardType ? { providerCardType: providerCardType as "CARD" | "CARDBACK" } : {}), slots: Array.isArray(ref.slots) ? ref.slots.filter((slot): slot is string => typeof slot === "string").slice(0, 100) : [], availableLocally: ref.availableLocally === true }];
    }) : [];
    if (body.physicalBackArtwork === true) {
      if (sourceValue !== "all" && sourceValue !== "mpc") throw new ApiRequestError(400, "INVALID_PHYSICAL_BACK_SOURCE", "Generic physical backs are available only from verified MPC cardbacks.");
      const catalogOptions = { ...(mpcFilters ? { mpcFilters } : {}), ...(body.forceMpcRefresh === true ? { forceMpcRefresh: true } : {}), signal: request.signal };
      const catalog = workbench.listMpcCardbackCatalog
        ? await workbench.listMpcCardbackCatalog(catalogOptions)
        : await workbench.listMpcCardbackCandidates(catalogOptions).then((candidates) => ({ candidates, catalogTotal: candidates.length, catalogTotalComplete: true }));
      const candidates = catalog.candidates;
      const verified = candidates.filter((candidate) => candidate.source === "mpc" && candidate.faceId === "back" && candidate.metadata?.cardType === "CARDBACK");
      return Response.json({ candidates: verified.map(candidateDto), catalogTotal: catalog.catalogTotal, catalogTotalComplete: catalog.catalogTotalComplete !== false, providerHealth: safeProviderHealth(workbench.getProviderHealth()), mpcDiagnostic: workbench.getMpcArtworkProviderDiagnostic?.() });
    }
    const catalogOptions = { mpcReferences: references, ...(mpcFilters ? { mpcFilters } : {}), ...(body.forceMpcRefresh === true ? { forceMpcRefresh: true } : {}), signal: request.signal };
    const catalog = workbench.listArtworkCatalog
      ? await workbench.listArtworkCatalog(identityId, faceId, sourceValue as ArtworkCatalogSource, catalogOptions)
      : await workbench.listArtworkCandidates(identityId, faceId, sourceValue as ArtworkCatalogSource, catalogOptions).then((candidates) => ({ candidates, catalogTotal: candidates.length, catalogTotalComplete: true }));
    const candidates = catalog.candidates;
    const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
    return Response.json({ candidates: uniqueCandidates.map(candidateDto), catalogTotal: catalog.catalogTotal, catalogTotalComplete: catalog.catalogTotalComplete !== false, providerHealth: safeProviderHealth(workbench.getProviderHealth()), mpcDiagnostic: workbench.getMpcArtworkProviderDiagnostic?.() });
  } catch (error) { return respondError(error); }
}

export async function handleMpcArtworkCatalogs(request: Request, workbench: CardWorkbench): Promise<Response> {
  try {
    const catalogs = await workbench.getMpcArtworkFilterCatalogs(request.signal);
    return noStore(Response.json({ catalogs, diagnostic: workbench.getMpcArtworkProviderDiagnostic?.() }));
  } catch (error) { return noStore(respondError(error)); }
}

export function handleMpcArtworkDiagnostics(workbench: CardWorkbench): Response {
  const diagnostic = workbench.getMpcArtworkProviderDiagnostic?.();
  return noStore(Response.json({ diagnostic: diagnostic ?? { available: false, degraded: true, lastFailureType: "unavailable" } }));
}

export function handleMpcArtworkDiagnosticsReport(workbench: CardWorkbench): Response {
  return noStore(Response.json(createMpcDiagnosticReport(workbench.getMpcArtworkProviderDiagnostic?.())));
}

export async function handleMpcArtworkRefresh(request: Request, candidateId: string, workbench: CardWorkbench): Promise<Response> {
  try {
    if (!/^mpc:[a-f0-9]{64}$/.test(candidateId)) throw new ApiRequestError(400, "INVALID_ID", "MPC artwork ID is invalid.");
    const candidate = await workbench.refreshMpcArtworkCandidate(candidateId, request.signal);
    if (!candidate) throw new ApiRequestError(404, "ARTWORK_MISSING", "MPC artwork candidate is unavailable for refresh.");
    return Response.json({ candidate: candidateDto(candidate), diagnostic: workbench.getMpcArtworkProviderDiagnostic?.() });
  } catch (error) { return respondError(error); }
}

export async function handleMpcArtworkBatchRevalidation(request: Request, workbench: CardWorkbench): Promise<Response> {
  try {
    const body = await parseJsonRequest(request, 64_000);
    if (!Array.isArray(body.candidateIds) || body.candidateIds.length > MPC_MAX_REVALIDATION_CANDIDATES) throw new ApiRequestError(400, "INVALID_REQUEST", `candidateIds must contain at most ${MPC_MAX_REVALIDATION_CANDIDATES} MPC artwork IDs.`);
    const candidateIds = body.candidateIds.map((value) => requiredString(value, "candidateId", 72));
    if (candidateIds.some((id) => !/^mpc:[a-f0-9]{64}$/.test(id))) throw new ApiRequestError(400, "INVALID_ID", "MPC artwork ID is invalid.");
    const results = await workbench.revalidateMpcArtworkCandidates(candidateIds, request.signal);
    return Response.json({ results: results.map((result: MpcCandidateRevalidationResult) => ({
      candidateId: result.candidateId,
      ...(result.providerAssetId ? { providerAssetId: result.providerAssetId } : {}),
      status: result.status,
      localOriginal: result.localOriginal,
      ...(result.failureKind ? { failureKind: result.failureKind } : {}),
      ...(result.candidate ? { candidate: candidateDto(result.candidate) } : {}),
    })), diagnostic: workbench.getMpcArtworkProviderDiagnostic?.() });
  } catch (error) { return respondError(error); }
}

export async function handleArtworkPreview(request: Request, candidateId: string, workbench: CardWorkbench): Promise<Response> {
  try {
    if (!/^(upload:[a-f0-9]{64}|scryfall:[a-f0-9-]{36}:(front|back)|mpc:[a-f0-9]{64})$/.test(candidateId)) throw new ApiRequestError(400, "INVALID_ID", "Artwork ID is invalid.");
    const preview = await workbench.getArtworkPreview(candidateId, request.signal);
    if (!preview) return Response.json({ code: "PREVIEW_UNAVAILABLE", message: "No local preview is available for this reference." }, { status: 404 });
    const url = new URL(request.url);
    const bleedValue = url.searchParams.get("bleedMm");
    const trimWidthValue = url.searchParams.get("trimWidthMm");
    const trimHeightValue = url.searchParams.get("trimHeightMm");
    const roundedValue = url.searchParams.get("roundedCorners");
    const cornerRadiusValue = url.searchParams.get("cornerRadiusMm");
    let previewBytes = new Uint8Array(preview.bytes);
    let contentType = preview.contentType;
    if (bleedValue !== null || trimWidthValue !== null || trimHeightValue !== null || roundedValue !== null || cornerRadiusValue !== null) {
      if (bleedValue === null || trimWidthValue === null || trimHeightValue === null) {
        throw new ApiRequestError(400, "INVALID_PREVIEW_GEOMETRY", "Preview bleed requires bleed and physical trim dimensions.");
      }
      if (roundedValue !== null && roundedValue !== "true" && roundedValue !== "false") {
        throw new ApiRequestError(400, "INVALID_PREVIEW_GEOMETRY", "roundedCorners must be true or false.");
      }
      if (cornerRadiusValue !== null && (roundedValue !== "true" || !Number.isFinite(Number(cornerRadiusValue)))) {
        throw new ApiRequestError(400, "INVALID_PREVIEW_GEOMETRY", "A physical corner radius requires rounded corners.");
      }
      let result;
      try {
        result = await extendPreviewBleed(preview.bytes, preview.contentType, {
          bleedMm: Number(bleedValue),
          trimWidthMm: Number(trimWidthValue),
          trimHeightMm: Number(trimHeightValue),
          roundedCorners: roundedValue === "true",
          ...(cornerRadiusValue !== null ? { cornerRadiusMm: Number(cornerRadiusValue) } : {}),
        });
      } catch (error) {
        if (error instanceof RangeError) throw new ApiRequestError(400, "INVALID_PREVIEW_GEOMETRY", error.message);
        throw error;
      }
      previewBytes = new Uint8Array(result.bytes);
      contentType = result.contentType;
    }
    return new Response(previewBytes, {
      headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=3600", "X-TCGPrint-Artwork-Role": "preview" },
    });
  } catch (error) { return respondError(error); }
}

export async function handleArtworkDisplay(request: Request, candidateId: string, workbench: CardWorkbench): Promise<Response> {
  try {
    if (!/^(upload:[a-f0-9]{64}|scryfall:[a-f0-9-]{36}:(front|back)|mpc:[a-f0-9]{64})$/.test(candidateId)) throw new ApiRequestError(400, "INVALID_ID", "Artwork ID is invalid.");
    const bucket = parseDisplayWidth(new URL(request.url));
    const display = await workbench.getArtworkDisplay(candidateId, bucket, request.signal);
    if (!display) throw new ApiRequestError(404, "DISPLAY_UNAVAILABLE", "No display image is available for this reference.");
    return await compositorDisplayResponse(request, display, bucket);
  } catch (error) { return respondError(error); }
}

export async function handleArtworkPrepare(request: Request, candidateId: string, workbench: CardWorkbench): Promise<Response> {
  try {
    if (!/^(upload:[a-f0-9]{64}|scryfall:[a-f0-9-]{36}:(front|back)|mpc:[a-f0-9]{64})$/.test(candidateId)) throw new ApiRequestError(400, "INVALID_ID", "Artwork ID is invalid.");
    const candidate = await workbench.getArtworkCandidate(candidateId, { signal: request.signal });
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

const BLEED_DIAGNOSTICS_HEADER_LIMIT = 6_000;

export function encodeBleedDiagnostics(diagnostics: readonly CardExportBleedDiagnostic[], maxHeaderLength = BLEED_DIAGNOSTICS_HEADER_LIMIT): { value: string; mode: "full" | "summary" } {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const compactDiagnostics = diagnostics.map(({ sideDiagnostics, ...diagnostic }) => ({
    ...diagnostic,
    sideDiagnostics: Object.fromEntries(Object.entries(sideDiagnostics).map(([side, result]) => [side, {
      strategy: result.strategy,
    }])),
  }));
  const full = encode({ version: 1, mode: "full", diagnostics: compactDiagnostics });
  if (full.length <= maxHeaderLength) return { value: full, mode: "full" };

  const effectiveModeCounts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    effectiveModeCounts[diagnostic.effectiveMode] = (effectiveModeCounts[diagnostic.effectiveMode] ?? 0) + 1;
  }
  return {
    value: encode({ version: 1, mode: "summary", truncated: true, count: diagnostics.length, effectiveModeCounts }),
    mode: "summary",
  };
}

export async function handleCardExport(
  request: Request,
  workbench: CardWorkbench,
  projects?: ProjectRepository,
  templateLibrary?: TemplateLibraryService,
  backLibrary?: BackLibraryOriginalSource,
): Promise<Response> {
  try {
    const body = await parseJsonRequest(request, 4_000_000);
    const cards = parseWorkingCards(body.cards);
    const physicalCardCount = cards.reduce((sum, card) => sum + card.quantity, 0);
    if (physicalCardCount > MAX_PHYSICAL_CARDS_PER_EXPORT) {
      throw new ApiRequestError(413, "EXPORT_TOO_LARGE", `The first export is limited to ${MAX_PHYSICAL_CARDS_PER_EXPORT} physical cards per PDF.`);
    }
    const options = record(body.options) ?? {};
    let requestedPhysicalOrder: PhysicalOrder;
    try {
      requestedPhysicalOrder = options.physicalOrder === undefined
        ? createPhysicalOrder(cards)
        : validatePhysicalOrder(cards, options.physicalOrder);
    } catch (error) {
      throw new ApiRequestError(400, "INVALID_PHYSICAL_ORDER", error instanceof Error ? error.message : "Physical order is invalid.");
    }
    const exportContentMode = options.exportContentMode === undefined ? "front-only" : options.exportContentMode as ExportContentMode;
    if (!EXPORT_CONTENT_MODES.has(exportContentMode)) throw new ApiRequestError(400, "INVALID_EXPORT_CONTENT_MODE", "exportContentMode must be front-only, back-only, front-back-separated, or duplex.");
    const missingBackPolicy = options.missingBackPolicy === undefined ? "use-project-default" : options.missingBackPolicy as MissingBackPolicy;
    if (!MISSING_BACK_POLICIES.has(missingBackPolicy)) throw new ApiRequestError(400, "INVALID_BACK_MODE", "missingBackPolicy must be use-project-default, blank, warn-and-continue, or block.");
    const duplexFlipMode = options.duplexFlipMode === undefined ? "long-edge" : options.duplexFlipMode as DuplexFlipMode;
    if (duplexFlipMode !== "long-edge" && duplexFlipMode !== "short-edge") throw new ApiRequestError(400, "INVALID_DUPLEX_FLIP", "duplexFlipMode must be long-edge or short-edge.");
    const projectDefaultBack = parseBackLibraryReference(options.projectDefaultBack, "projectDefaultBack") ?? null;
    const bleedMm = options.bleedMm === undefined ? 0.625 : Number(options.bleedMm);
    let cutGuides: CutGuideConfig;
    try {
      cutGuides = parseCutGuideConfig(options.cutGuides);
    } catch (error) {
      throw new ApiRequestError(400, "INVALID_CUT_GUIDES", error instanceof Error ? error.message : "Cut guides configuration is invalid.");
    }
    if (options.bleedMode !== undefined && options.bleedMode !== "edge-extension") {
      throw new ApiRequestError(400, "INVALID_BLEED_MODE", "Legacy bleed modes are retired; only immediate-edge extension is supported.");
    }
    if (options.roundedCorners !== undefined && typeof options.roundedCorners !== "boolean") {
      throw new ApiRequestError(400, "INVALID_ROUNDED_CORNERS", "roundedCorners must be a boolean.");
    }
    let registration;
    try {
      registration = parseRegistrationConfig(options.registration ?? { type: "none", orientation: "portrait" });
    } catch (error) {
      throw new ApiRequestError(400, "INVALID_REGISTRATION", error instanceof Error ? error.message : "Registration configuration is invalid.");
    }
    const pageOrientation = optionalOrientation(options.pageOrientation, "pageOrientation");
    const cardOrientation = optionalOrientation(options.cardOrientation, "cardOrientation");
    const paperFormat = optionalPhysicalFormat(options.paperFormat, "paperFormat", false);
    const cardFormat = optionalPhysicalFormat(options.cardFormat, "cardFormat", true);
    const marginsMm = optionalMargins(options.marginsMm);
    const horizontalGapMm = optionalLayoutMm(options.horizontalGapMm, "horizontalGapMm");
    const verticalGapMm = optionalLayoutMm(options.verticalGapMm, "verticalGapMm");
    let templateGeometry: TemplateLayoutGeometryMm | undefined;
    if (options.templateGeometry !== undefined) {
      try { templateGeometry = parseTemplateLayoutGeometry(options.templateGeometry); }
      catch (error) { throw new ApiRequestError(400, "INVALID_LAYOUT", error instanceof Error ? error.message : "Template layout geometry is invalid."); }
    }
    const layoutRows = optionalGridDimension(options.layoutRows, "layoutRows");
    const layoutColumns = optionalGridDimension(options.layoutColumns, "layoutColumns");
    if ((layoutRows === undefined) !== (layoutColumns === undefined)) {
      throw new ApiRequestError(400, "INVALID_LAYOUT", "layoutRows and layoutColumns must be supplied together.");
    }
    const skippedSlotIndices = options.skippedSlotIndices;
    if (skippedSlotIndices !== undefined && (!Array.isArray(skippedSlotIndices) || skippedSlotIndices.length > 1_128
      || skippedSlotIndices.some((index) => !Number.isSafeInteger(index) || (index as number) < 0)
      || new Set(skippedSlotIndices).size !== skippedSlotIndices.length)) {
      throw new ApiRequestError(400, "INVALID_LAYOUT", "skippedSlotIndices must contain unique non-negative integer slot IDs.");
    }
    if (skippedSlotIndices?.length && layoutRows === undefined && templateGeometry === undefined) {
      throw new ApiRequestError(400, "INVALID_LAYOUT", "Skipped slots require a fixed grid or versioned template geometry.");
    }
    let derivedTemplateGeometry: TemplateLayoutGeometryMm | undefined;
    let exportCards = cards;
    let projectRevision: number | null = null;
    let printerProfileSelection: PrinterProfileSnapshot | null = null;
    if (options.projectId !== undefined || options.expectedProjectRevision !== undefined) {
      if (typeof options.projectId !== "string" || !options.projectId.trim() || options.projectId.length > 180 || /[\u0000-\u001f]/.test(options.projectId)
        || !Number.isSafeInteger(options.expectedProjectRevision) || (options.expectedProjectRevision as number) < 1) {
        throw new ApiRequestError(400, "INVALID_PROJECT_EXPORT_SYNC", "Project export synchronization requires an opaque Project ID and positive expected revision.");
      }
      if (!projects || !templateLibrary) throw new ApiRequestError(503, "PROJECT_EXPORT_SYNC_UNAVAILABLE", "Project export synchronization is unavailable.");
      const project = projects.open(options.projectId);
      if (project.revision !== options.expectedProjectRevision) {
        throw new ProjectRepositoryError("PROJECT_REVISION_CONFLICT", `Project revision ${project.revision} does not match requested revision ${options.expectedProjectRevision}.`, options.expectedProjectRevision as number, project.revision);
      }
      const saved = project.snapshot.settings;
      const expectedLayoutOptions = {
        bleedMm: saved.bleedMm,
        roundedCorners: saved.roundedCorners,
        cutGuides: saved.cutGuides,
        pageOrientation: saved.pageOrientation,
        cardOrientation: saved.cardOrientation,
        paperFormat: saved.paperFormat,
        cardFormat: saved.cardFormat,
        marginsMm: saved.marginsMm,
        horizontalGapMm: saved.horizontalGapMm,
        verticalGapMm: saved.verticalGapMm,
        registration: saved.registration,
        templateGeometry: saved.layout.templateGeometry,
        layoutRows: saved.layout.rows,
        layoutColumns: saved.layout.columns,
        skippedSlotIndices: saved.layout.skippedSlotIndices,
      };
      const requestLayoutOptions = {
        bleedMm,
        roundedCorners: options.roundedCorners ?? false,
        cutGuides,
        pageOrientation: pageOrientation ?? "portrait",
        cardOrientation: cardOrientation ?? "portrait",
        paperFormat: paperFormat ?? { name: PAPER_FORMATS.A4.name, widthMm: PAPER_FORMATS.A4.widthMm, heightMm: PAPER_FORMATS.A4.heightMm },
        cardFormat: cardFormat ?? MAGIC_STANDARD_CARD,
        marginsMm: marginsMm ?? { top: 0, right: 0, bottom: 0, left: 0 },
        horizontalGapMm: horizontalGapMm ?? 0,
        verticalGapMm: verticalGapMm ?? 0,
        registration,
        templateGeometry,
        layoutRows,
        layoutColumns,
        skippedSlotIndices: skippedSlotIndices ?? [],
      };
      const expectedBackOptions = {
        exportContentMode: saved.exportContentMode,
        missingBackPolicy: saved.missingBackPolicy,
        duplexFlipMode: saved.duplexFlipMode,
        projectDefaultBack: saved.projectDefaultBack,
      };
      const requestBackOptions = { exportContentMode, missingBackPolicy, duplexFlipMode, projectDefaultBack };
      const savedCards = parseWorkingCards(project.snapshot.cards);
      if (canonicalJson(expectedLayoutOptions) !== canonicalJson(requestLayoutOptions)) {
        throw new ApiRequestError(409, "PROJECT_CUT_SYNC_STALE", "PDF request does not match the autosaved Project settings used by cut geometry. Save the Project and retry.");
      }
      if (canonicalJson(expectedBackOptions) !== canonicalJson(requestBackOptions)
        || canonicalJson(savedCards) !== canonicalJson(cards)
        || canonicalJson(project.snapshot.physicalOrder) !== canonicalJson(requestedPhysicalOrder)) {
        throw new ApiRequestError(409, "STALE_PROJECT", "PDF request does not match the autosaved Project revision, card order, artwork selections, or duplex settings. Save the Project and retry.");
      }
      const requestedCalibration = {
        printerProfileSelection: options.printerProfileSelection ?? null,
        printerDuplexMode: options.printerDuplexMode ?? "single-sided",
      };
      const savedCalibration = {
        printerProfileSelection: saved.printerProfileSelection,
        printerDuplexMode: saved.printerDuplexMode,
      };
      if (canonicalJson(requestedCalibration) !== canonicalJson(savedCalibration)) {
        throw new ApiRequestError(409, "STALE_PROJECT", "PDF request calibration does not match the exact profile revision saved in the Project. Save the Project and retry.");
      }
      printerProfileSelection = saved.printerProfileSelection
        ? verifyPrinterProfileSnapshot(saved.printerProfileSelection)
        : null;
      if (printerProfileSelection) {
        const exportSides = exportContentMode === "front-only" ? ["front"] as const
          : exportContentMode === "back-only" ? ["back"] as const : ["front", "back"] as const;
        const compatibility = checkPrinterProfileCompatibility(printerProfileSelection, {
          paperSize: saved.paperFormat.name,
          paperWidthMm: saved.paperFormat.widthMm,
          paperHeightMm: saved.paperFormat.heightMm,
          pageOrientation: saved.pageOrientation,
          duplexMode: saved.printerDuplexMode,
          duplexFlipMode: saved.duplexFlipMode,
          exportSides,
        });
        if (!compatibility.compatible) {
          throw new ApiRequestError(409, "PROFILE_INCOMPATIBLE", `Printer profile ${printerProfileSelection.id} v${printerProfileSelection.version} is incompatible with this export: ${compatibility.reasons.join(", ")}.`);
        }
      }
      const resolved = await resolveProjectCutLayout(project.id, project.revision, projects, templateLibrary);
      derivedTemplateGeometry = resolved.layout.derivedTemplateGeometry;
      exportCards = savedCards;
      requestedPhysicalOrder = project.snapshot.physicalOrder;
      projectRevision = project.revision;
    }
    const exportOptions = {
      bleedMm,
      cutGuides,
      roundedCorners: options.roundedCorners ?? false,
      ...(pageOrientation ? { pageOrientation } : {}),
      ...(cardOrientation ? { cardOrientation } : {}),
      ...(paperFormat ? { paperFormat } : {}),
      ...(cardFormat ? { cardFormat } : {}),
      ...(marginsMm ? { marginsMm } : {}),
      ...(horizontalGapMm !== undefined ? { horizontalGapMm } : {}),
      ...(verticalGapMm !== undefined ? { verticalGapMm } : {}),
      registration,
      ...((derivedTemplateGeometry ?? templateGeometry) ? { templateGeometry: derivedTemplateGeometry ?? templateGeometry } : {}),
      ...(layoutRows !== undefined ? { layoutRows, layoutColumns } : {}),
      ...(skippedSlotIndices ? { skippedSlotIndices } : {}),
      exportContentMode,
      duplexFlipMode,
      missingBackPolicy,
      projectDefaultBack,
      physicalOrder: requestedPhysicalOrder,
      printerProfileSelection,
      projectRevision,
    } as const;
    const result = await exportWorkingCardsByContentMode(workbench, backLibrary, exportCards, exportOptions, request.signal);
    const bleedReport = encodeBleedDiagnostics(result.bleedDiagnostics);
    const backPreflight = Buffer.from(JSON.stringify({
      projectRevision: result.preflight.projectRevision,
      totalPhysicalCards: result.preflight.totalPhysicalCards,
      dfcPhysicalCards: result.preflight.dfcPhysicalCards,
      simplePhysicalCards: result.preflight.simplePhysicalCards,
      backs: result.preflight.backs,
      missingCount: result.preflight.missing.length,
      warningCount: result.preflight.warnings.length,
    })).toString("base64url");
    const sharedHeaders = {
      "Cache-Control": "no-store",
      "X-TCGPrint-Bleed-Diagnostics": bleedReport.value,
      "X-TCGPrint-Bleed-Diagnostics-Mode": bleedReport.mode,
      "X-TCGPrint-Back-Preflight": backPreflight,
      "X-TCGPrint-Export-Content-Mode": result.contentMode,
      ...(result.calibration ? {
        "X-TCGPrint-Calibration": Buffer.from(JSON.stringify(result.calibration)).toString("base64url"),
      } : {}),
      ...(result.calibrationBoundsWarnings?.length ? {
        "X-TCGPrint-Calibration-Warnings": Buffer.from(JSON.stringify(result.calibrationBoundsWarnings)).toString("base64url"),
      } : {}),
      ...(result.pagePairingPlan ? {
        "X-TCGPrint-Duplex-Flip-Mode": result.pagePairingPlan.flipMode,
        "X-TCGPrint-Duplex-Page-Orientation": result.pagePairingPlan.pageOrientation,
      } : {}),
    };
    if (result.contentMode === "front-back-separated") {
      const front = result.frontPdfBytes!;
      const back = result.backPdfBytes!;
      if (new URL(request.url).searchParams.get("proof") === "final") {
        return Response.json({
          frontPdfBase64: Buffer.from(front).toString("base64"),
          backPdfBase64: Buffer.from(back).toString("base64"),
        }, { headers: sharedHeaders });
      }
      const manifest = new TextEncoder().encode(JSON.stringify(result.manifest));
      const archive = createSeparatePdfArchive([
        { filename: "front.pdf", bytes: front },
        { filename: "back.pdf", bytes: back },
        { filename: "manifest.json", bytes: manifest },
      ]);
      return new Response(Uint8Array.from(archive), {
        headers: {
          ...sharedHeaders,
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="tcgprint-front-back.zip"',
        },
      });
    }
    const filename = result.contentMode === "front-only" ? "tcgprint-cards.pdf"
      : result.contentMode === "back-only" ? "tcgprint-back.pdf" : "tcgprint-duplex.pdf";
    return new Response(Uint8Array.from(result.pdfBytes!), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...sharedHeaders,
      },
    });
  } catch (error) { return respondError(error); }
}
