import type {
  CardFace,
  CardFaceSide,
  CardIdentity,
  IdentityResolution,
  SelectedArtwork,
  WorkingCard,
  WorkingCardMpcReference,
  WorkingCardSharedMpcCardback,
} from "../../core/cards/types";
import { MAX_PHYSICAL_CARDS_PER_EXPORT } from "../../core/cards/limits";
import { isSafeArtworkCandidateId } from "../../core/cards/artwork-candidate-id";
import { validateCardIdentityMetadata } from "../../core/cards/safe-identity-metadata";
import { DEFAULT_CUT_GUIDE_CONFIG, GUIDE_COLOR_OPTIONS, MAGIC_STANDARD_CARD, PAPER_FORMATS, parseTemplateLayoutGeometry, type CardFormat, type CutGuideConfig, type GuideColor, type PageOrientation, type PaperFormat, type TemplateLayoutGeometryMm } from "../../core/geometry";
import { parseRegistrationConfig, type RegistrationConfig } from "../../core/registration";

export const CURRENT_PROJECT_SCHEMA_VERSION = 2;

/** 16 MiB bounds a 500-entry resolved Working Set without ever embedding artwork bytes. */
export const MAX_PROJECT_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_CARDS = 500;

export type PersistedWorkingCard = Omit<WorkingCard, "metadata">;

export interface ProjectSettingsV2 {
  readonly bleedMm: number;
  readonly roundedCorners: boolean;
  readonly cutGuides: CutGuideConfig;
  readonly pageOrientation: PageOrientation;
  readonly cardOrientation: PageOrientation;
  readonly paperFormat: PaperFormat;
  readonly cardFormat: CardFormat;
  readonly marginsMm: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
  readonly horizontalGapMm: number;
  readonly verticalGapMm: number;
  readonly registration: RegistrationConfig;
  /** Explicit Project-level registration choice overriding a version's registration default. */
  readonly registrationOverride: boolean;
  readonly layout: {
    readonly rows?: number;
    readonly columns?: number;
    readonly skippedSlotIndices: readonly number[];
    readonly templateGeometry?: TemplateLayoutGeometryMm;
  };
}

export interface LegacyProjectSettingsV1 {
  readonly bleedMm: number;
  readonly roundedCorners: boolean;
  readonly cutGuides: CutGuideConfig;
}

/** @deprecated Kept as a source-compatible name; current settings use the v2 shape. */
export type ProjectSettingsV1 = ProjectSettingsV2;
export type ProjectSettingsInput = ProjectSettingsV2 | LegacyProjectSettingsV1;

export interface ProjectSnapshotV1 {
  /** Legacy version-1 snapshots are accepted and promoted to version 2 on read. */
  readonly projectSchemaVersion: number;
  readonly cards: readonly PersistedWorkingCard[];
  readonly settings: ProjectSettingsV2;
}

export class ProjectSnapshotError extends Error {
  constructor(
    readonly code:
      | "INVALID_PROJECT_SNAPSHOT"
      | "INVALID_PROJECT_SCHEMA_VERSION"
      | "FUTURE_PROJECT_SCHEMA_VERSION"
      | "UNSUPPORTED_PROJECT_SCHEMA_VERSION"
      | "PROJECT_SNAPSHOT_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "ProjectSnapshotError";
  }
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettingsV1 = Object.freeze({
  bleedMm: 0.625,
  roundedCorners: false,
  cutGuides: DEFAULT_CUT_GUIDE_CONFIG,
  pageOrientation: "portrait",
  cardOrientation: "portrait",
  paperFormat: Object.freeze({ name: PAPER_FORMATS.A4.name, widthMm: PAPER_FORMATS.A4.widthMm, heightMm: PAPER_FORMATS.A4.heightMm }),
  cardFormat: MAGIC_STANDARD_CARD,
  marginsMm: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
  horizontalGapMm: 0,
  verticalGapMm: 0,
  registration: Object.freeze({ type: "none", orientation: "portrait" }),
  registrationOverride: false,
  layout: Object.freeze({ skippedSlotIndices: Object.freeze([]) }),
});

type DataObject = Record<string, unknown>;

const ARTWORK_SOURCES = new Set(["scryfall", "upload", "mpc", "url", "custom"]);
const IDENTITY_METHODS = new Set(["scryfall-id", "set-collector", "name", "filename", "ocr", "fuzzy", "manual", "custom"]);
const IDENTITY_STATUSES = new Set(["resolved", "suggested", "ambiguous", "unresolved", "custom"]);
const GUIDE_COLORS = new Set<GuideColor>(GUIDE_COLOR_OPTIONS.map(({ value }) => value));

function invalid(path: string, reason: string): never {
  throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", `${path} ${reason}`);
}

function isPlainObject(value: unknown): value is DataObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonData(value: unknown, path: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || value === undefined) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "must contain only finite JSON numbers.");
    return;
  }
  if (typeof value !== "object") invalid(path, "must contain only JSON data.");
  if (!Array.isArray(value) && !isPlainObject(value)) invalid(path, "must not contain binary data or non-plain objects.");
  if (ancestors.has(value)) invalid(path, "must not contain cyclic data.");
  ancestors.add(value);
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) {
      invalid(path, "must not contain extra array properties.");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || value[index] === undefined) invalid(`${path}[${index}]`, "must be present JSON data.");
      assertJsonData(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalid(path, "must not contain symbol properties.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) invalid(`${path}.${key}`, "must be an enumerable data property.");
      if (descriptor.value !== undefined) assertJsonData(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function object(value: unknown, path: string, allowed: readonly string[], required: readonly string[] = allowed): DataObject {
  if (!isPlainObject(value)) invalid(path, "must be a plain object.");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) invalid(path, `contains unsupported property ${String(key)}.`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(path, `is missing required property ${key}.`);
  }
  return value;
}

function string(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    invalid(path, `must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${maximum} characters.`);
  }
  return value;
}

function optionalString(source: DataObject, key: string, path: string, maximum: number): string | undefined {
  const value = source[key];
  return value === undefined ? undefined : string(value, path, maximum);
}

function optionalFilename(source: DataObject, key: string, path: string, maximum: number): string | undefined {
  const value = optionalString(source, key, path, maximum);
  if (value !== undefined && (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || /^file:/i.test(value) || /^~[\\/]/.test(value))) {
    invalid(path, "must be a filename, not an absolute filesystem path.");
  }
  return value;
}

function finiteNumber(value: unknown, path: string, minimum: number, maximum = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(path, `must be a finite number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be a boolean.");
  return value;
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(path, `must be an array containing at most ${maximum} items.`);
  return value;
}

function stringArray(value: unknown, path: string, maximumItems: number, maximumLength: number): string[] {
  const values = array(value, path, maximumItems).map((item, index) => string(item, `${path}[${index}]`, maximumLength));
  if (new Set(values).size !== values.length) invalid(path, "must not contain duplicates.");
  return values;
}

function safeIdentityMetadata(value: unknown, path: string): CardIdentity["metadata"] {
  try {
    return validateCardIdentityMetadata(value);
  } catch (error) {
    invalid(path, error instanceof Error ? error.message : "must contain only safe CardIdentity metadata.");
  }
}

function identity(value: unknown, path: string): CardIdentity | null {
  if (value === null) return null;
  const source = object(value, path,
    ["id", "provider", "name", "scryfallId", "oracleId", "setCode", "collectorNumber", "lang", "resolutionMethod", "confidence", "metadata"],
    ["id", "provider", "name", "resolutionMethod", "confidence"]);
  const method = string(source.resolutionMethod, `${path}.resolutionMethod`, 32);
  if (!IDENTITY_METHODS.has(method)) invalid(`${path}.resolutionMethod`, "is not supported.");
  const metadata = safeIdentityMetadata(source.metadata, `${path}.metadata`);
  const scryfallId = optionalString(source, "scryfallId", `${path}.scryfallId`, 80);
  const oracleId = optionalString(source, "oracleId", `${path}.oracleId`, 80);
  const setCode = optionalString(source, "setCode", `${path}.setCode`, 12);
  const collectorNumber = optionalString(source, "collectorNumber", `${path}.collectorNumber`, 40);
  const lang = optionalString(source, "lang", `${path}.lang`, 12);
  return {
    id: string(source.id, `${path}.id`, 180),
    provider: string(source.provider, `${path}.provider`, 40),
    name: string(source.name, `${path}.name`, 200),
    ...(scryfallId !== undefined ? { scryfallId } : {}),
    ...(oracleId !== undefined ? { oracleId } : {}),
    ...(setCode !== undefined ? { setCode } : {}),
    ...(collectorNumber !== undefined ? { collectorNumber } : {}),
    ...(lang !== undefined ? { lang } : {}),
    resolutionMethod: method as CardIdentity["resolutionMethod"],
    confidence: finiteNumber(source.confidence, `${path}.confidence`, 0, 1),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function selectedArtwork(value: unknown, side: CardFaceSide, path: string): SelectedArtwork {
  const source = object(value, path,
    ["candidateId", "source", "identityId", "faceId", "providerAssetId", "selectedArtworkId", "selectionPolicy"],
    ["candidateId", "source", "identityId", "faceId"]);
  const artworkSource = string(source.source, `${path}.source`, 16);
  if (!ARTWORK_SOURCES.has(artworkSource)) invalid(`${path}.source`, "is not supported.");
  if (source.identityId !== null && typeof source.identityId !== "string") invalid(`${path}.identityId`, "must be a string or null.");
  const faceId = string(source.faceId, `${path}.faceId`, 8);
  if (faceId !== side) invalid(`${path}.faceId`, `must match the ${side} selection key.`);
  const candidateId = string(source.candidateId, `${path}.candidateId`, 128);
  if (!isSafeArtworkCandidateId(candidateId)) invalid(`${path}.candidateId`, "is not a supported artwork candidate ID.");
  const providerAssetId = optionalString(source, "providerAssetId", `${path}.providerAssetId`, 200);
  const selectedArtworkId = optionalString(source, "selectedArtworkId", `${path}.selectedArtworkId`, 200);
  const selectionPolicy = optionalString(source, "selectionPolicy", `${path}.selectionPolicy`, 80);
  return {
    candidateId,
    source: artworkSource as SelectedArtwork["source"],
    identityId: source.identityId === null ? null : string(source.identityId, `${path}.identityId`, 180),
    faceId,
    ...(providerAssetId !== undefined ? { providerAssetId } : {}),
    ...(selectedArtworkId !== undefined ? { selectedArtworkId } : {}),
    ...(selectionPolicy !== undefined ? { selectionPolicy } : {}),
  };
}

function identityResolution(value: unknown, currentIdentity: CardIdentity | null, path: string): IdentityResolution {
  const source = object(value, path,
    ["status", "method", "query", "confidence", "candidates", "confirmed"],
    ["status", "candidates", "confirmed"]);
  const status = string(source.status, `${path}.status`, 16);
  if (!IDENTITY_STATUSES.has(status)) invalid(`${path}.status`, "is not supported.");
  const methodValue = optionalString(source, "method", `${path}.method`, 32);
  if (methodValue !== undefined && !IDENTITY_METHODS.has(methodValue)) invalid(`${path}.method`, "is not supported.");
  const query = optionalString(source, "query", `${path}.query`, 200);
  const confidence = source.confidence === undefined ? undefined : finiteNumber(source.confidence, `${path}.confidence`, 0, 1);
  const candidates = array(source.candidates, `${path}.candidates`, 20).map((candidate, index) => {
    const candidatePath = `${path}.candidates[${index}]`;
    const candidateRecord = object(candidate, candidatePath, ["identity", "score", "reason"]);
    return {
      identity: identity(candidateRecord.identity, `${candidatePath}.identity`) ?? invalid(`${candidatePath}.identity`, "must be an identity object."),
      score: finiteNumber(candidateRecord.score, `${candidatePath}.score`, 0, 1),
      reason: string(candidateRecord.reason, `${candidatePath}.reason`, 300),
    };
  });
  const confirmed = boolean(source.confirmed, `${path}.confirmed`);
  if (confirmed && currentIdentity === null && status !== "custom") {
    invalid(path, "cannot confirm an identity without a current CardIdentity unless status is custom.");
  }
  if (status === "custom" && currentIdentity !== null) invalid(path, "cannot have a custom status with a resolved identity.");
  return {
    status: status as IdentityResolution["status"],
    ...(methodValue !== undefined ? { method: methodValue as IdentityResolution["method"] } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    candidates,
    confirmed,
  };
}

function cardFace(value: unknown, path: string): CardFace {
  const source = object(value, path, ["id", "side", "name", "importedAssetId", "slots"], ["id", "side"]);
  const side = string(source.side, `${path}.side`, 8);
  if (side !== "front" && side !== "back") invalid(`${path}.side`, "must be front or back.");
  const id = string(source.id, `${path}.id`, 8);
  if (id !== side) invalid(`${path}.id`, "must match its face side.");
  const name = optionalString(source, "name", `${path}.name`, 200);
  const importedAssetId = optionalString(source, "importedAssetId", `${path}.importedAssetId`, 128);
  const slots = source.slots === undefined ? undefined : stringArray(source.slots, `${path}.slots`, 100, 64);
  return {
    id,
    side,
    ...(name !== undefined ? { name } : {}),
    ...(importedAssetId !== undefined ? { importedAssetId } : {}),
    ...(slots !== undefined ? { slots } : {}),
  };
}

function mpcReference(value: unknown, path: string): WorkingCardMpcReference {
  const source = object(value, path,
    ["faceId", "importedAssetId", "providerAssetId", "selectedArtworkId", "referenceOrigin", "slots", "availableLocally"],
    ["faceId", "importedAssetId", "slots", "availableLocally"]);
  const faceId = string(source.faceId, `${path}.faceId`, 8);
  if (faceId !== "front" && faceId !== "back") invalid(`${path}.faceId`, "must be front or back.");
  const providerAssetId = optionalString(source, "providerAssetId", `${path}.providerAssetId`, 200);
  const selectedArtworkId = optionalString(source, "selectedArtworkId", `${path}.selectedArtworkId`, 200);
  const referenceOrigin = optionalString(source, "referenceOrigin", `${path}.referenceOrigin`, 32);
  if (referenceOrigin !== undefined && referenceOrigin !== "order-import" && referenceOrigin !== "gallery-selection") invalid(`${path}.referenceOrigin`, "is not supported.");
  return {
    faceId,
    importedAssetId: string(source.importedAssetId, `${path}.importedAssetId`, 180),
    ...(providerAssetId !== undefined ? { providerAssetId } : {}),
    ...(selectedArtworkId !== undefined ? { selectedArtworkId } : {}),
    ...(referenceOrigin !== undefined ? { referenceOrigin } : {}),
    slots: stringArray(source.slots, `${path}.slots`, 100, 64),
    availableLocally: boolean(source.availableLocally, `${path}.availableLocally`),
  };
}

function sharedMpcCardback(value: unknown, path: string): WorkingCardSharedMpcCardback {
  const source = object(value, path,
    ["importedAssetId", "providerAssetId", "selectedArtworkId", "originalFormat", "availableLocally", "provenance"],
    ["importedAssetId", "originalFormat", "availableLocally", "provenance"]);
  const providerAssetId = optionalString(source, "providerAssetId", `${path}.providerAssetId`, 200);
  const selectedArtworkId = optionalString(source, "selectedArtworkId", `${path}.selectedArtworkId`, 200);
  const provenance = object(source.provenance, `${path}.provenance`, ["sourceId", "sourceFilename"], ["sourceId"]);
  const sourceFilename = optionalFilename(provenance, "sourceFilename", `${path}.provenance.sourceFilename`, 240);
  return {
    importedAssetId: string(source.importedAssetId, `${path}.importedAssetId`, 180),
    ...(providerAssetId !== undefined ? { providerAssetId } : {}),
    ...(selectedArtworkId !== undefined ? { selectedArtworkId } : {}),
    originalFormat: string(source.originalFormat, `${path}.originalFormat`, 80),
    availableLocally: boolean(source.availableLocally, `${path}.availableLocally`),
    provenance: {
      sourceId: string(provenance.sourceId, `${path}.provenance.sourceId`, 180),
      ...(sourceFilename !== undefined ? { sourceFilename } : {}),
    },
  };
}

function faceAssociation(value: unknown, path: string): WorkingCard["faceAssociations"][number] {
  const source = object(value, path,
    ["slot", "frontAssetId", "backAssetId", "confidence", "reason", "accepted"],
    ["slot"]);
  const frontAssetId = optionalString(source, "frontAssetId", `${path}.frontAssetId`, 180);
  const backAssetId = optionalString(source, "backAssetId", `${path}.backAssetId`, 180);
  const confidence = source.confidence === undefined ? undefined : finiteNumber(source.confidence, `${path}.confidence`, 0, 1);
  const reason = optionalString(source, "reason", `${path}.reason`, 300);
  const accepted = source.accepted === undefined ? undefined : boolean(source.accepted, `${path}.accepted`);
  return {
    slot: string(source.slot, `${path}.slot`, 80),
    ...(frontAssetId !== undefined ? { frontAssetId } : {}),
    ...(backAssetId !== undefined ? { backAssetId } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(accepted !== undefined ? { accepted } : {}),
  };
}

function persistedCard(value: unknown, index: number): PersistedWorkingCard {
  const path = `snapshot.cards[${index}]`;
  const source = object(value, path,
    ["id", "quantity", "order", "section", "importSource", "identityHints", "identity", "identityResolution", "faces", "selectedArtworkByFace", "localArtworkIds", "mpcReferences", "sharedMpcCardback", "faceAssociations"],
    ["id", "quantity", "order", "importSource", "identityHints", "identity", "identityResolution", "faces", "selectedArtworkByFace", "localArtworkIds", "mpcReferences", "faceAssociations"]);
  const id = string(source.id, `${path}.id`, 180);
  if (!Number.isSafeInteger(source.quantity) || (source.quantity as number) < 1 || (source.quantity as number) > 999) invalid(`${path}.quantity`, "must be a positive integer no greater than 999.");
  if (!Number.isSafeInteger(source.order) || (source.order as number) < 0) invalid(`${path}.order`, "must be a non-negative integer.");
  const section = optionalString(source, "section", `${path}.section`, 80);
  const importSource = object(source.importSource, `${path}.importSource`, ["sourceId", "filename", "importKind", "entryKind"], ["sourceId", "importKind", "entryKind"]);
  const importFilename = optionalFilename(importSource, "filename", `${path}.importSource.filename`, 240);
  const hints = object(source.identityHints, `${path}.identityHints`, ["name", "setCode", "collectorNumber", "scryfallId", "language"], []);
  const identityHints = {
    ...(optionalString(hints, "name", `${path}.identityHints.name`, 200) !== undefined ? { name: hints.name as string } : {}),
    ...(optionalString(hints, "setCode", `${path}.identityHints.setCode`, 12) !== undefined ? { setCode: hints.setCode as string } : {}),
    ...(optionalString(hints, "collectorNumber", `${path}.identityHints.collectorNumber`, 40) !== undefined ? { collectorNumber: hints.collectorNumber as string } : {}),
    ...(optionalString(hints, "scryfallId", `${path}.identityHints.scryfallId`, 80) !== undefined ? { scryfallId: hints.scryfallId as string } : {}),
    ...(optionalString(hints, "language", `${path}.identityHints.language`, 12) !== undefined ? { language: hints.language as string } : {}),
  };
  const currentIdentity = identity(source.identity, `${path}.identity`);
  const resolution = identityResolution(source.identityResolution, currentIdentity, `${path}.identityResolution`);
  const faces = array(source.faces, `${path}.faces`, 2).map((face, faceIndex) => cardFace(face, `${path}.faces[${faceIndex}]`));
  const faceSides = faces.map(({ side }) => side);
  if (!faces.some(({ side }) => side === "front") || new Set(faceSides).size !== faces.length) invalid(`${path}.faces`, "must contain one front face and at most one back face.");
  const selectionsSource = object(source.selectedArtworkByFace, `${path}.selectedArtworkByFace`, ["front", "back"], []);
  const selectedArtworkByFace: Partial<Record<CardFaceSide, SelectedArtwork>> = {};
  for (const side of ["front", "back"] as const) {
    if (selectionsSource[side] === undefined) continue;
    if (!faceSides.includes(side)) invalid(`${path}.selectedArtworkByFace.${side}`, "cannot select artwork for a missing face.");
    selectedArtworkByFace[side] = selectedArtwork(selectionsSource[side], side, `${path}.selectedArtworkByFace.${side}`);
  }
  const localArtworkIds = stringArray(source.localArtworkIds, `${path}.localArtworkIds`, 200, 80);
  localArtworkIds.forEach((artworkId, index) => {
    if (!isSafeArtworkCandidateId(artworkId) || !artworkId.startsWith("upload:")) {
      invalid(`${path}.localArtworkIds[${index}]`, "must be a valid local upload artwork ID.");
    }
  });
  const mpcReferences = array(source.mpcReferences, `${path}.mpcReferences`, 200)
    .map((reference, referenceIndex) => {
      const referencePath = `${path}.mpcReferences[${referenceIndex}]`;
      const parsedReference = mpcReference(reference, referencePath);
      if (!faceSides.includes(parsedReference.faceId as CardFaceSide)) invalid(`${referencePath}.faceId`, "must reference a face on this card.");
      return parsedReference;
    });
  const cardback = source.sharedMpcCardback === undefined ? undefined : sharedMpcCardback(source.sharedMpcCardback, `${path}.sharedMpcCardback`);
  const associations = array(source.faceAssociations, `${path}.faceAssociations`, 200)
    .map((association, associationIndex) => faceAssociation(association, `${path}.faceAssociations[${associationIndex}]`));
  return {
    id,
    quantity: source.quantity as number,
    order: source.order as number,
    ...(section !== undefined ? { section } : {}),
    importSource: {
      sourceId: string(importSource.sourceId, `${path}.importSource.sourceId`, 180),
      ...(importFilename !== undefined ? { filename: importFilename } : {}),
      importKind: string(importSource.importKind, `${path}.importSource.importKind`, 60),
      entryKind: string(importSource.entryKind, `${path}.importSource.entryKind`, 60),
    },
    identityHints,
    identity: currentIdentity,
    identityResolution: resolution,
    faces,
    selectedArtworkByFace,
    localArtworkIds,
    mpcReferences,
    ...(cardback !== undefined ? { sharedMpcCardback: cardback } : {}),
    faceAssociations: associations,
  };
}

function projectSettings(value: unknown, legacy = false): ProjectSettingsV2 {
  const baseKeys = ["bleedMm", "roundedCorners", "cutGuides"];
  const currentKeys = [...baseKeys, "pageOrientation", "cardOrientation", "paperFormat", "cardFormat", "marginsMm", "horizontalGapMm", "verticalGapMm", "registration", "registrationOverride", "layout"];
  const source = object(value, "snapshot.settings", legacy
    ? baseKeys
    : currentKeys,
  legacy ? undefined : currentKeys.filter((key) => key !== "registrationOverride"));
  const guides = object(source.cutGuides, "snapshot.settings.cutGuides", ["trim", "external"]);
  const trim = object(guides.trim, "snapshot.settings.cutGuides.trim", ["enabled", "extentMm", "color"]);
  const external = object(guides.external, "snapshot.settings.cutGuides.external", ["enabled", "strokeWidthPt", "color"]);
  const trimColor = string(trim.color, "snapshot.settings.cutGuides.trim.color", 16);
  const externalColor = string(external.color, "snapshot.settings.cutGuides.external.color", 16);
  if (!GUIDE_COLORS.has(trimColor as GuideColor)) invalid("snapshot.settings.cutGuides.trim.color", "is not a supported guide color.");
  if (!GUIDE_COLORS.has(externalColor as GuideColor)) invalid("snapshot.settings.cutGuides.external.color", "is not a supported guide color.");
  const extentMm: CutGuideConfig["trim"]["extentMm"] = trim.extentMm === "full"
    ? "full"
    : finiteNumber(trim.extentMm, "snapshot.settings.cutGuides.trim.extentMm", Number.MIN_VALUE);
  const strokeWidthPt = finiteNumber(external.strokeWidthPt, "snapshot.settings.cutGuides.external.strokeWidthPt", Number.MIN_VALUE);
  const base: Pick<ProjectSettingsV2, "bleedMm" | "roundedCorners" | "cutGuides"> = {
    bleedMm: finiteNumber(source.bleedMm, "snapshot.settings.bleedMm", 0, 3),
    roundedCorners: boolean(source.roundedCorners, "snapshot.settings.roundedCorners"),
    cutGuides: {
      trim: { enabled: boolean(trim.enabled, "snapshot.settings.cutGuides.trim.enabled"), extentMm, color: trimColor as GuideColor },
      external: { enabled: boolean(external.enabled, "snapshot.settings.cutGuides.external.enabled"), strokeWidthPt, color: externalColor as GuideColor },
    },
  };
  if (legacy) return { ...DEFAULT_PROJECT_SETTINGS, ...base };

  const pageOrientation = string(source.pageOrientation, "snapshot.settings.pageOrientation", 12);
  const cardOrientation = string(source.cardOrientation, "snapshot.settings.cardOrientation", 12);
  if (pageOrientation !== "portrait" && pageOrientation !== "landscape") invalid("snapshot.settings.pageOrientation", "must be portrait or landscape.");
  if (cardOrientation !== "portrait" && cardOrientation !== "landscape") invalid("snapshot.settings.cardOrientation", "must be portrait or landscape.");
  const paperSource = object(source.paperFormat, "snapshot.settings.paperFormat", ["name", "widthMm", "heightMm"]);
  const paperFormat: PaperFormat = {
    name: string(paperSource.name, "snapshot.settings.paperFormat.name", 100),
    widthMm: finiteNumber(paperSource.widthMm, "snapshot.settings.paperFormat.widthMm", Number.MIN_VALUE, 2_000),
    heightMm: finiteNumber(paperSource.heightMm, "snapshot.settings.paperFormat.heightMm", Number.MIN_VALUE, 2_000),
  };
  const cardSource = object(source.cardFormat, "snapshot.settings.cardFormat", ["id", "name", "widthMm", "heightMm", "cornerRadiusMm"]);
  const cardFormat: CardFormat = {
    id: string(cardSource.id, "snapshot.settings.cardFormat.id", 100),
    name: string(cardSource.name, "snapshot.settings.cardFormat.name", 100),
    widthMm: finiteNumber(cardSource.widthMm, "snapshot.settings.cardFormat.widthMm", Number.MIN_VALUE, 2_000),
    heightMm: finiteNumber(cardSource.heightMm, "snapshot.settings.cardFormat.heightMm", Number.MIN_VALUE, 2_000),
    ...(cardSource.cornerRadiusMm !== undefined
      ? { cornerRadiusMm: finiteNumber(cardSource.cornerRadiusMm, "snapshot.settings.cardFormat.cornerRadiusMm", Number.MIN_VALUE, 1_000) }
      : {}),
  };
  if (cardFormat.cornerRadiusMm !== undefined && cardFormat.cornerRadiusMm * 2 > Math.min(cardFormat.widthMm, cardFormat.heightMm)) {
    invalid("snapshot.settings.cardFormat.cornerRadiusMm", "must not exceed half the smaller card dimension.");
  }
  const margins = object(source.marginsMm, "snapshot.settings.marginsMm", ["top", "right", "bottom", "left"]);
  const marginsMm = {
    top: finiteNumber(margins.top, "snapshot.settings.marginsMm.top", 0, 2_000),
    right: finiteNumber(margins.right, "snapshot.settings.marginsMm.right", 0, 2_000),
    bottom: finiteNumber(margins.bottom, "snapshot.settings.marginsMm.bottom", 0, 2_000),
    left: finiteNumber(margins.left, "snapshot.settings.marginsMm.left", 0, 2_000),
  };
  const horizontalGapMm = finiteNumber(source.horizontalGapMm, "snapshot.settings.horizontalGapMm", 0, 2_000);
  const verticalGapMm = finiteNumber(source.verticalGapMm, "snapshot.settings.verticalGapMm", 0, 2_000);
  let registration: RegistrationConfig;
  try { registration = parseRegistrationConfig(source.registration); }
  catch (error) { invalid("snapshot.settings.registration", error instanceof Error ? error.message : "must be valid bounded geometry."); }
  const registrationOverride = source.registrationOverride === undefined
    ? false
    : boolean(source.registrationOverride, "snapshot.settings.registrationOverride");
  const layoutSource = object(source.layout, "snapshot.settings.layout", ["rows", "columns", "skippedSlotIndices", "templateGeometry"], ["skippedSlotIndices"]);
  const rows = layoutSource.rows === undefined ? undefined : finiteNumber(layoutSource.rows, "snapshot.settings.layout.rows", 1, 1_128);
  const columns = layoutSource.columns === undefined ? undefined : finiteNumber(layoutSource.columns, "snapshot.settings.layout.columns", 1, 1_128);
  if ((rows === undefined) !== (columns === undefined)) invalid("snapshot.settings.layout", "rows and columns must be supplied together.");
  if ((rows !== undefined && !Number.isSafeInteger(rows)) || (columns !== undefined && !Number.isSafeInteger(columns))) {
    invalid("snapshot.settings.layout", "rows and columns must be positive integers.");
  }
  if (rows !== undefined && columns !== undefined && rows * columns > 1_128) {
    invalid("snapshot.settings.layout", "fixed grid may contain at most 1128 positions.");
  }
  const skippedSlotIndices = array(layoutSource.skippedSlotIndices, "snapshot.settings.layout.skippedSlotIndices", 1_128)
    .map((index, position) => {
      if (!Number.isSafeInteger(index) || (index as number) < 0) invalid(`snapshot.settings.layout.skippedSlotIndices[${position}]`, "must be a non-negative safe integer.");
      return index as number;
    });
  if (new Set(skippedSlotIndices).size !== skippedSlotIndices.length) invalid("snapshot.settings.layout.skippedSlotIndices", "must not contain duplicate slot indices.");
  if (rows !== undefined && columns !== undefined && skippedSlotIndices.some((index) => index >= rows * columns)) {
    invalid("snapshot.settings.layout.skippedSlotIndices", "contains an index outside the fixed grid.");
  }
  let templateGeometry: TemplateLayoutGeometryMm | undefined;
  if (layoutSource.templateGeometry !== undefined) {
    let parsedGeometry: TemplateLayoutGeometryMm;
    try { parsedGeometry = parseTemplateLayoutGeometry(layoutSource.templateGeometry); }
    catch (error) { invalid("snapshot.settings.layout.templateGeometry", error instanceof Error ? error.message : "must be bounded template geometry."); }
    templateGeometry = parsedGeometry!;
    const parsedTemplateGeometry = templateGeometry as TemplateLayoutGeometryMm;
    if ((rows !== undefined && rows !== parsedTemplateGeometry.rows) || (columns !== undefined && columns !== parsedTemplateGeometry.columns)) {
      invalid("snapshot.settings.layout", "manual rows and columns conflict with immutable template geometry.");
    }
    if (skippedSlotIndices.some((index) => !parsedTemplateGeometry.slots.some((slot) => slot.index === index))) {
      invalid("snapshot.settings.layout.skippedSlotIndices", "contains an index without a physical template slot.");
    }
  }
  if (skippedSlotIndices.length > 0 && rows === undefined && templateGeometry === undefined) {
    invalid("snapshot.settings.layout.skippedSlotIndices", "skipped slots require a fixed grid or versioned template geometry.");
  }
  return {
    ...base,
    pageOrientation,
    cardOrientation,
    paperFormat,
    cardFormat,
    marginsMm,
    horizontalGapMm,
    verticalGapMm,
    registration,
    registrationOverride,
    layout: {
      ...(rows !== undefined ? { rows, columns } : {}),
      skippedSlotIndices,
      ...(templateGeometry !== undefined ? { templateGeometry } : {}),
    },
  };
}

function validateSnapshot(value: unknown, legacy = false): ProjectSnapshotV1 {
  const source = object(value, "snapshot", ["projectSchemaVersion", "cards", "settings"]);
  const cards = array(source.cards, "snapshot.cards", MAX_PROJECT_CARDS).map((card, index) => persistedCard(card, index));
  if (new Set(cards.map(({ id }) => id)).size !== cards.length) invalid("snapshot.cards", "must not contain duplicate WorkingCard IDs.");
  if (cards.reduce((total, card) => total + card.quantity, 0) > MAX_PHYSICAL_CARDS_PER_EXPORT) {
    invalid("snapshot.cards", `must contain at most ${MAX_PHYSICAL_CARDS_PER_EXPORT} physical cards.`);
  }
  return {
    projectSchemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    cards,
    settings: projectSettings(source.settings, legacy),
  };
}

function checkSnapshotSize(serialized: string): void {
  if (new TextEncoder().encode(serialized).byteLength > MAX_PROJECT_SNAPSHOT_BYTES) {
    throw new ProjectSnapshotError("PROJECT_SNAPSHOT_TOO_LARGE", `Project snapshot exceeds the ${MAX_PROJECT_SNAPSHOT_BYTES}-byte limit.`);
  }
}

/** Serializes only durable WorkingCard fields; WorkingCard.metadata is intentionally omitted. */
export function serializeProjectSnapshot(cards: readonly WorkingCard[], settings: ProjectSettingsInput): string {
  const persistedCards = cards.map((card, index) => {
    if (!isPlainObject(card)) invalid(`cards[${index}]`, "must be a plain object.");
    const copy = { ...card } as DataObject;
    delete copy.metadata;
    return copy;
  });
  const isLegacySettings = isPlainObject(settings) && !Object.prototype.hasOwnProperty.call(settings, "registration");
  const normalizedSettings = projectSettings(settings, isLegacySettings);
  const candidate = { projectSchemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, cards: persistedCards, settings: normalizedSettings };
  assertJsonData(candidate, "snapshot");
  const snapshot = validateSnapshot(candidate);
  const serialized = JSON.stringify(snapshot);
  checkSnapshotSize(serialized);
  return serialized;
}

/** Dispatches logical Project snapshot versions; v1 is validated losslessly and future versions are read-only errors. */
export function deserializeProjectSnapshot(value: string | unknown): ProjectSnapshotV1 {
  let snapshot: unknown = value;
  if (typeof value === "string") {
    checkSnapshotSize(value);
    try {
      snapshot = JSON.parse(value) as unknown;
    } catch {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Project snapshot must contain valid JSON.");
    }
  } else {
    assertJsonData(snapshot, "snapshot");
    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Project snapshot must contain serializable JSON data.");
    }
    checkSnapshotSize(serialized);
  }
  if (!isPlainObject(snapshot)) invalid("snapshot", "must be an object.");
  const version = snapshot.projectSchemaVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new ProjectSnapshotError("INVALID_PROJECT_SCHEMA_VERSION", "Project snapshot schema version must be a positive integer.");
  }
  if (version > CURRENT_PROJECT_SCHEMA_VERSION) {
    throw new ProjectSnapshotError("FUTURE_PROJECT_SCHEMA_VERSION", `Project snapshot schema ${version} is newer than this application supports (${CURRENT_PROJECT_SCHEMA_VERSION}).`);
  }
  if (version !== 1 && version !== CURRENT_PROJECT_SCHEMA_VERSION) {
    throw new ProjectSnapshotError("UNSUPPORTED_PROJECT_SCHEMA_VERSION", `Project snapshot schema ${version} has no supported migration path.`);
  }
  // v1 had only bleed/corners/cut-guide settings; the effective geometry defaults
  // are materialized once and serialized as v2 on the next save.
  return validateSnapshot(snapshot, version === 1);
}
