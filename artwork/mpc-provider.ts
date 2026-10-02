import type { ArtworkCandidate, CardFaceSide, CardIdentity, WorkingCardMpcReference } from "../core/cards/types";
import { mpcArtworkCandidateId } from "../core/cards/ids";
import { calculateEffectiveDpi } from "./effective-dpi";
import type { ArtworkMetadataCache } from "./storage/metadata-cache";
import type { ArtworkOriginalStore } from "./storage/original-store";
import type { ArtworkRepository } from "./storage/repository";
import type { ArtworkThumbnailStore } from "./storage/thumbnail-store";
import { ArtworkStorageError, type ArtworkOriginal } from "./storage/types";
import { validateImageBytes } from "./storage/image-validation";
import type { ArtworkPreview, ArtworkProvider, ArtworkSearchOptions, ProviderHealth } from "./types";
import { validateSvgForPdfExport } from "../pdf-engine/document";
import { MpcArtworkFilterValidationError, normalizeMpcArtworkFilters, validateMpcArtworkFiltersAgainstCatalogs } from "./mpc-contract";
import type { MpcArtworkFilterInput, MpcArtworkFilters, MpcFilterCatalogs, MpcLanguageOption, MpcSourceOption, MpcTagOption } from "./mpc-contract";
import { buildMpcSearchCacheKey } from "./mpc-cache-key";
import { rankMpcCandidates } from "./mpc-ranking";

const API_BASE_URL = "https://mpcfill.com";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const THUMBNAIL_LIMIT = 10 * 1024 * 1024;
const DEFAULT_MAX_ORIGINAL_BYTES = 30 * 1024 * 1024;
const SVG_PDF_VALIDATION_VERSION = 1;
const THUMBNAIL_HOSTS = new Set(["drive.google.com", "lh3.googleusercontent.com", "lh4.googleusercontent.com"]);
const ORIGINAL_HOSTS = new Set(["drive.google.com", "drive.usercontent.google.com"]);
const API_HOSTS = new Set(["mpcfill.com"]);

export class MpcArtworkProviderError extends Error {
  constructor(readonly kind: "http" | "protocol" | "unsafe-source" | "invalid-image" | "unsupported-format" | "asset-too-large" | "timeout" | "aborted" | "network", message: string, readonly status?: number) {
    super(message);
    this.name = "MpcArtworkProviderError";
  }
}

export interface MpcArtworkProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxOriginalBytes?: number;
  readonly searchLimit?: number;
  readonly originals: ArtworkOriginalStore;
  readonly thumbnails: ArtworkThumbnailStore;
  readonly metadata: ArtworkMetadataCache;
  readonly repository: ArtworkRepository;
}

interface StoredCandidate {
  readonly candidate: ArtworkCandidate;
  readonly thumbnailUrl?: string;
  readonly declaredSize?: number;
}

interface SourceRecord { readonly pk: number; readonly sourceType: "Google Drive"; readonly name: string; }

export interface MpcAdvancedArtworkSearchOptions extends ArtworkSearchOptions {
  readonly filters?: MpcArtworkFilterInput;
}

export interface MpcCatalogCacheDiagnostic {
  readonly state: "fresh" | "stale" | "unavailable" | "empty";
  readonly ageMs?: number;
}

export interface MpcArtworkProviderDiagnostic {
  readonly available: boolean;
  readonly degraded: boolean;
  readonly lastProtocolConfirmed: "v2" | "v3" | null;
  readonly v3Available: boolean | null;
  readonly fallbackV2Used: boolean;
  readonly lastSuccessfulOperation?: "search" | "catalog-refresh" | "metadata-refresh" | "thumbnail" | "original";
  readonly lastSuccessfulAt?: string;
  readonly lastFailureType?: string;
  readonly catalogCaches: Readonly<Record<"sources" | "languages" | "tags", MpcCatalogCacheDiagnostic>>;
  readonly searchCacheHits: number;
  readonly searchCacheMisses: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError") ||
    (record(error) && error.kind === "aborted");
}

function validAssetId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value);
}

function faceQuery(identity: CardIdentity, faceId?: CardFaceSide): string {
  const faces = identity.metadata?.faces;
  const face = Array.isArray(faces) ? faces[faceId === "back" ? 1 : 0] : undefined;
  if (record(face) && typeof face.name === "string" && face.name.trim()) return face.name.trim().slice(0, 200);
  return identity.name.trim().slice(0, 200);
}

function requestHash(searchQuery: { query: string | null; cardType: string; expansionCode?: string; collectorNumber?: string }): string {
  const serialized = `cardType=${searchQuery.cardType}\n  &query=${searchQuery.query ?? "null"}\n  &expansionCode=${searchQuery.expansionCode ?? "null"}\n  &collectorNumber=${searchQuery.collectorNumber ?? "null"}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
    hash >>>= 0;
  }
  return String(hash);
}

function verifiedSources(payload: unknown): SourceRecord[] {
  const envelope = record(payload) ? payload.results : payload;
  const items = Array.isArray(envelope) ? envelope : record(envelope) ? Object.entries(envelope).flatMap(([key, value]) => {
    if (!record(value)) return [];
    const mapPk = Number(key);
    const sourcePk = Number(value.pk ?? mapPk);
    return Number.isSafeInteger(mapPk) && mapPk > 0 && sourcePk === mapPk ? [{ ...value, pk: sourcePk }] : [];
  }) : [];
  if (items.length > 5_000) throw new MpcArtworkProviderError("protocol", "MPC source catalog is too large.");
  return items.flatMap((item): SourceRecord[] => {
    if (!record(item) || item.sourceType !== "Google Drive") return [];
    const pk = Number(item.pk);
    const name = typeof item.name === "string" ? safeCatalogText(item.name, 120) : undefined;
    return Number.isSafeInteger(pk) && pk > 0 ? [{ pk, sourceType: "Google Drive", name: name ?? `Google Drive source ${pk}` }] : [];
  });
}

function safeCatalogText(value: unknown, maximum = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : undefined;
}

function catalogArray(payload: unknown, key: string): unknown[] {
  if (record(payload) && Array.isArray(payload[key])) return payload[key] as unknown[];
  if (record(payload) && record(payload.results) && Array.isArray(payload.results[key])) return payload.results[key] as unknown[];
  throw new MpcArtworkProviderError("protocol", `MPC ${key} catalog has an invalid response shape.`);
}

function verifiedLanguages(payload: unknown): MpcLanguageOption[] {
  const items = catalogArray(payload, "languages");
  if (items.length > 100) throw new MpcArtworkProviderError("protocol", "MPC language catalog is too large.");
  return items.flatMap((item): MpcLanguageOption[] => {
    if (!record(item)) return [];
    const code = safeCatalogText(item.code, 16)?.toLowerCase();
    const name = safeCatalogText(item.name, 80);
    return code && /^[a-z0-9-]+$/.test(code) && name ? [{ code, name }] : [];
  }).sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
}

function verifiedTags(payload: unknown): MpcTagOption[] {
  const roots = catalogArray(payload, "tags");
  const names = new Set<string>();
  let visited = 0;
  const visit = (items: unknown[], depth: number) => {
    if (depth > 8) throw new MpcArtworkProviderError("protocol", "MPC tag catalog is nested too deeply.");
    for (const item of items) {
      visited += 1;
      if (visited > 2000) throw new MpcArtworkProviderError("protocol", "MPC tag catalog is too large.");
      if (!record(item)) continue;
      const name = safeCatalogText(item.name, 80);
      if (name) names.add(name);
      if (Array.isArray(item.children)) visit(item.children, depth + 1);
    }
  };
  visit(roots, 0);
  return [...names].sort((left, right) => left.toLowerCase() < right.toLowerCase() ? -1 : left.toLowerCase() > right.toLowerCase() ? 1 : 0).map((name) => ({ name }));
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function safeRemoteTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const tags = value.flatMap((item): string[] => {
    const name = typeof item === "string" ? safeCatalogText(item, 80) : record(item) ? safeCatalogText(item.name, 80) : undefined;
    return name ? [name] : [];
  });
  return [...new Set(tags)].sort((left, right) => left.toLowerCase() < right.toLowerCase() ? -1 : left.toLowerCase() > right.toLowerCase() ? 1 : 0);
}

function candidateMatchesFilters(candidate: ArtworkCandidate, filters: MpcArtworkFilters): boolean {
  const sourceId = candidate.metadata?.sourceId;
  if (filters.sources.length && (typeof sourceId !== "number" || !filters.sources.includes(sourceId))) return false;

  const declaredDpi = candidate.metadata?.dpi;
  const validDpi = typeof declaredDpi === "number" && Number.isSafeInteger(declaredDpi) && declaredDpi > 0
    ? declaredDpi
    : undefined;
  if (filters.minimumDpi > 0 && (validDpi === undefined || validDpi < filters.minimumDpi)) return false;
  // The legacy/basic search already defaults to 1500 DPI. Preserve candidates
  // with missing remote DPI metadata at that default, but require metadata for
  // every non-default maximum and reject known values outside the selected range.
  if (validDpi !== undefined && validDpi > filters.maximumDpi) return false;
  if (filters.maximumDpi !== 1500 && validDpi === undefined) return false;

  if (filters.languages.length) {
    const language = candidate.language ?? candidate.metadata?.language;
    const normalized = typeof language === "string" ? language.toLocaleLowerCase("en-US") : undefined;
    if (!normalized || !filters.languages.includes(normalized)) return false;
  }

  if (filters.includeTags.length || filters.excludeTags.length) {
    const metadataTags = candidate.metadata?.tags;
    if (!Array.isArray(metadataTags)) return false;
    const tags = new Set(metadataTags.flatMap((tag) => typeof tag === "string" ? [tag.toLocaleLowerCase("en-US")] : []));
    if (!filters.includeTags.every((tag) => tags.has(tag.toLocaleLowerCase("en-US")))) return false;
    if (filters.excludeTags.some((tag) => tags.has(tag.toLocaleLowerCase("en-US")))) return false;
  }
  return true;
}

function safeCanonicalCard(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!record(value)) return undefined;
  const output: Record<string, string> = {};
  for (const key of ["name", "expansionCode", "expansionName", "collectorNumber", "rarity", "scryfallId"]) {
    const text = safeCatalogText(value[key], key === "name" || key === "expansionName" ? 160 : 80);
    if (text) output[key] = text;
  }
  return Object.keys(output).length ? output : undefined;
}

function safeCanonicalArtist(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!record(value)) return undefined;
  const output: Record<string, string> = {};
  for (const key of ["name", "scryfallId"]) {
    const text = safeCatalogText(value[key], key === "name" ? 160 : 80);
    if (text) output[key] = text;
  }
  return Object.keys(output).length ? output : undefined;
}

function resultIds(payload: unknown, query: string, hash: string, version: "v3" | "v2"): string[] {
  if (!record(payload) || !record(payload.results)) throw new MpcArtworkProviderError("protocol", "MPC editor search did not return a results map.");
  let result: unknown;
  if (version === "v3") {
    if (!Object.prototype.hasOwnProperty.call(payload.results, hash)) throw new MpcArtworkProviderError("protocol", "MPC v3 search omitted the submitted query key.");
    result = payload.results[hash];
  } else {
    const queryResults = payload.results[query];
    if (!record(queryResults) || !Object.prototype.hasOwnProperty.call(queryResults, "CARD")) throw new MpcArtworkProviderError("protocol", "MPC v2 search omitted the requested card-type result.");
    result = queryResults.CARD;
  }
  if (!Array.isArray(result) || result.some((item) => !validAssetId(item))) throw new MpcArtworkProviderError("protocol", "MPC editor search returned an invalid asset-ID list.");
  return [...new Set(result)].slice(0, 30);
}

function cardItems(payload: unknown, expectedIds?: ReadonlySet<string>): Record<string, unknown>[] {
  if (!record(payload) || !record(payload.results)) throw new MpcArtworkProviderError("protocol", "MPC card hydration did not return a results map.");
  return Object.entries(payload.results).map(([id, item]) => {
    if (expectedIds && !expectedIds.has(id)) throw new MpcArtworkProviderError("protocol", "MPC card hydration returned an unrequested document ID.");
    if (!record(item) || item.identifier !== id) throw new MpcArtworkProviderError("protocol", "MPC card hydration returned an invalid document ID mapping.");
    return item;
  });
}

function candidateKey(id: string): string { return `mpc:candidate:${id}`; }

const EXPORTABLE_ORIGINAL_EXTENSIONS = new Set(["png", "jpg", "jpeg", "svg"]);

function normalizeExtension(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const extension = value.trim().toLowerCase().replace(/^\./, "");
  return extension || undefined;
}

function canonicalExtension(value: unknown): string | undefined {
  const extension = normalizeExtension(value);
  return extension === "jpeg" ? "jpg" : extension;
}

function isExportableOriginalExtension(value: unknown): boolean {
  const extension = canonicalExtension(value);
  return extension !== undefined && EXPORTABLE_ORIGINAL_EXTENSIONS.has(extension);
}

function candidateHasKnownUnsupportedFormat(candidate: ArtworkCandidate): boolean {
  if (candidate.metadata?.originalFormatExportable === false) return true;
  const extension = normalizeExtension(candidate.metadata?.extension);
  if (canonicalExtension(extension) === "svg") return false;
  const known = candidate.metadata?.originalFormatKnown === true || extension !== undefined;
  return known && !isExportableOriginalExtension(extension);
}

function mimeTypeForFormat(format: string): string | undefined {
  const mimeTypes: Readonly<Record<string, string>> = {
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    gif: "image/gif",
    svg: "image/svg+xml",
    tiff: "image/tiff",
  };
  return mimeTypes[format];
}

function referenceMetadata(reference: WorkingCardMpcReference): Readonly<Record<string, unknown>> {
  return {
    referenceOnly: true,
    referenceOrigin: reference.referenceOrigin ?? "order-import",
    importedAssetId: reference.importedAssetId,
    slots: [...reference.slots],
    localAvailabilityHint: reference.availableLocally,
  };
}

function safeUrl(value: string, hosts: ReadonlySet<string>): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !hosts.has(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== "443")) return undefined;
    return url;
  } catch { return undefined; }
}

function safeImageUrl(value: string, role: "thumbnail" | "original"): URL | undefined {
  return safeUrl(value, role === "thumbnail" ? THUMBNAIL_HOSTS : ORIGINAL_HOSTS);
}

function imageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  return undefined;
}

interface RequestScope {
  readonly signal: AbortSignal;
  run<T>(operation: Promise<T>): Promise<T>;
  close(): void;
}

function createRequestScope(parentSignal: AbortSignal | undefined, timeoutMs: number): RequestScope {
  if (parentSignal?.aborted) throw new MpcArtworkProviderError("aborted", "The MPC request was cancelled.");
  const controller = new AbortController();
  let abortError: MpcArtworkProviderError | undefined;
  let rejectAbort!: (error: MpcArtworkProviderError) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (kind: "aborted" | "timeout") => {
    if (abortError) return;
    abortError = new MpcArtworkProviderError(kind, kind === "timeout" ? "The MPC request timed out." : "The MPC request was cancelled.");
    controller.abort();
    rejectAbort(abortError);
  };
  const onParentAbort = () => abort("aborted");
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => abort("timeout"), timeoutMs);
  return {
    signal: controller.signal,
    run<T>(operation: Promise<T>): Promise<T> { return Promise.race([operation, abortPromise]); },
    close() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function readLimited(response: Response, maximumBytes: number, scope: RequestScope): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new MpcArtworkProviderError("asset-too-large", `MPC response exceeds the ${maximumBytes} byte limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await scope.run(reader.read());
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MpcArtworkProviderError("asset-too-large", `MPC response exceeds the ${maximumBytes} byte limit.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export class MpcArtworkProvider implements ArtworkProvider {
  readonly source = "mpc" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maximumOriginalBytes: number;
  private readonly searchLimit: number;
  private readonly originals: ArtworkOriginalStore;
  private readonly thumbnails: ArtworkThumbnailStore;
  private readonly metadata: ArtworkMetadataCache;
  private readonly repository: ArtworkRepository;
  private health: ProviderHealth = { available: true, degraded: false };
  private readonly catalogStates: Record<"sources" | "languages" | "tags", MpcCatalogCacheDiagnostic> = {
    sources: { state: "empty" }, languages: { state: "empty" }, tags: { state: "empty" },
  };
  private lastProtocolConfirmed: "v2" | "v3" | null = null;
  private v3Available: boolean | null = null;
  private fallbackV2Used = false;
  private lastSuccessfulOperation: MpcArtworkProviderDiagnostic["lastSuccessfulOperation"];
  private lastSuccessfulAt: string | undefined;
  private lastFailureType: string | undefined;
  private searchCacheHits = 0;
  private searchCacheMisses = 0;
  private catalogDegraded = false;

  constructor(options: MpcArtworkProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = new URL(options.baseUrl ?? API_BASE_URL);
    if (this.baseUrl.protocol !== "https:" || this.baseUrl.hostname !== "mpcfill.com" || this.baseUrl.username || this.baseUrl.password || (this.baseUrl.port && this.baseUrl.port !== "443")) {
      throw new MpcArtworkProviderError("unsafe-source", "MPC API must use https://mpcfill.com.");
    }
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maximumOriginalBytes = Math.max(1, options.maxOriginalBytes ?? DEFAULT_MAX_ORIGINAL_BYTES);
    this.searchLimit = Math.min(30, Math.max(1, options.searchLimit ?? 30));
    this.originals = options.originals;
    this.thumbnails = options.thumbnails;
    this.metadata = options.metadata;
    this.repository = options.repository;
  }

  getHealth(): ProviderHealth { return this.health; }

  getDiagnostic(): MpcArtworkProviderDiagnostic {
    return {
      available: this.health.available,
      degraded: this.health.degraded || this.catalogDegraded,
      lastProtocolConfirmed: this.lastProtocolConfirmed,
      v3Available: this.v3Available,
      fallbackV2Used: this.fallbackV2Used,
      ...(this.lastSuccessfulOperation ? { lastSuccessfulOperation: this.lastSuccessfulOperation } : {}),
      ...(this.lastSuccessfulAt ? { lastSuccessfulAt: this.lastSuccessfulAt } : {}),
      ...(this.lastFailureType ? { lastFailureType: this.lastFailureType } : {}),
      catalogCaches: {
        sources: { ...this.catalogStates.sources },
        languages: { ...this.catalogStates.languages },
        tags: { ...this.catalogStates.tags },
      },
      searchCacheHits: this.searchCacheHits,
      searchCacheMisses: this.searchCacheMisses,
    };
  }

  private operationSucceeded(operation: NonNullable<MpcArtworkProviderDiagnostic["lastSuccessfulOperation"]>): void {
    this.lastSuccessfulOperation = operation;
    this.lastSuccessfulAt = new Date().toISOString();
    this.health = { available: true, degraded: false };
  }

  private degrade(error: unknown): void {
    const type = error instanceof MpcArtworkProviderError ? error.kind
      : error instanceof ArtworkStorageError ? "storage"
        : "protocol";
    this.lastFailureType = type;
    // Never publish upstream text, URLs, or arbitrary error messages through
    // MPC health. Provider-specific diagnostics expose a bounded enum only.
    this.health = { available: false, degraded: true, message: "MPC artwork provider is temporarily degraded." };
  }

  async searchArtwork(identity: CardIdentity, options: ArtworkSearchOptions = {}): Promise<readonly ArtworkCandidate[]> {
    return this.searchArtworkAdvanced(identity, { ...options, filters: {} });
  }

  async getFilterCatalogs(signal?: AbortSignal): Promise<MpcFilterCatalogs> {
    const [sources, languages, tags] = await Promise.all([
      this.sources(signal),
      this.loadCatalog("languages", "mpc:catalog:languages", "/2/languages/", verifiedLanguages, signal),
      this.loadCatalog("tags", "mpc:catalog:tags", "/2/tags/", verifiedTags, signal),
    ]);
    this.operationSucceeded("catalog-refresh");
    return {
      sources: sources.map(({ pk, name, sourceType }) => ({ id: pk, name, sourceType })),
      languages,
      tags,
    };
  }

  async refreshCandidate(id: string, signal?: AbortSignal): Promise<ArtworkCandidate | undefined> {
    if (!/^mpc:[a-f0-9]{64}$/.test(id)) return undefined;
    if (signal?.aborted) throw new MpcArtworkProviderError("aborted", "The MPC metadata refresh was cancelled.");
    const snapshot = this.metadata.getMetadataSnapshot<StoredCandidate>(candidateKey(id));
    const stored = snapshot?.value;
    if (!stored?.candidate.providerAssetId || !validAssetId(stored.candidate.providerAssetId)) return undefined;
    const assetId = stored.candidate.providerAssetId;
    const sources = await this.sources(signal);
    const verifiedSourceIds = new Set(sources.map(({ pk }) => pk));
    const response = await this.apiJson("/2/cards/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIdentifiers: [assetId] }),
    }, signal);
    let documents: Record<string, unknown>[];
    try { documents = cardItems(response.payload, new Set([assetId])); }
    catch (error) { this.degrade(error); throw error; }
    const document = documents.find((item) => item.identifier === assetId);
    const metadataCheckedAt = new Date().toISOString();
    if (!document) {
      const refreshed: StoredCandidate = {
        ...stored,
        candidate: {
          ...stored.candidate,
          originalAvailable: Boolean(stored.candidate.originalCached),
          metadata: { ...stored.candidate.metadata, remoteMetadataStatus: "removed", metadataCheckedAt },
        },
      };
      this.metadata.putMetadata(candidateKey(id), refreshed, Date.now() + CANDIDATE_TTL_MS);
      this.operationSucceeded("metadata-refresh");
      return await this.getCandidate(id) ?? refreshed.candidate;
    }
    const identityId = stored.candidate.identityId ?? "local:mpc-refresh";
    const identity: CardIdentity = {
      id: identityId,
      provider: identityId.startsWith("scryfall:") ? "scryfall" : "local",
      name: typeof stored.candidate.metadata?.name === "string" ? stored.candidate.metadata.name : "MPC artwork",
      resolutionMethod: "custom",
      confidence: 0,
    };
    let updated: StoredCandidate | undefined;
    try { updated = this.candidateFromCard(document, identity, stored.candidate.faceId === "back" ? "back" : "front", verifiedSourceIds); }
    catch (error) {
      this.degrade(error);
      const retained: StoredCandidate = {
        ...stored,
        candidate: {
          ...stored.candidate,
          originalAvailable: Boolean(stored.candidate.originalCached),
          metadata: { ...stored.candidate.metadata, remoteMetadataStatus: "invalid", metadataCheckedAt },
        },
      };
      this.metadata.putMetadata(candidateKey(id), retained, Date.now() + CANDIDATE_TTL_MS);
      return await this.getCandidate(id) ?? retained.candidate;
    }
    if (!updated) {
      const retained: StoredCandidate = {
        ...stored,
        candidate: { ...stored.candidate, originalAvailable: Boolean(stored.candidate.originalCached), metadata: { ...stored.candidate.metadata, remoteMetadataStatus: "unsupported", metadataCheckedAt } },
      };
      this.metadata.putMetadata(candidateKey(id), retained, Date.now() + CANDIDATE_TTL_MS);
      this.operationSucceeded("metadata-refresh");
      return await this.getCandidate(id) ?? retained.candidate;
    }
    const merged: StoredCandidate = {
      ...updated,
      candidate: {
        ...updated.candidate,
        id,
        identityId: stored.candidate.identityId,
        ...(stored.candidate.selectedArtworkId ? { selectedArtworkId: stored.candidate.selectedArtworkId } : {}),
        metadata: {
          ...updated.candidate.metadata,
          remoteMetadataStatus: "current",
          metadataCheckedAt,
        },
      },
    };
    this.metadata.putMetadata(candidateKey(id), merged, Date.now() + CANDIDATE_TTL_MS);
    this.operationSucceeded("metadata-refresh");
    return await this.getCandidate(id) ?? merged.candidate;
  }

  async searchArtworkAdvanced(identity: CardIdentity, options: MpcAdvancedArtworkSearchOptions = {}): Promise<readonly ArtworkCandidate[]> {
    const inputFilters = normalizeMpcArtworkFilters(options.filters ?? {});
    const references = (options.mpcReferences ?? []).filter((reference) =>
      (reference.faceId === "front" || reference.faceId === "back") && (!options.faceId || reference.faceId === options.faceId),
    );
    const importedCandidates: ArtworkCandidate[] = [];
    for (const reference of references) {
      const id = mpcArtworkCandidateId(reference.importedAssetId, reference.faceId as CardFaceSide);
      try {
        const hydrated = await this.getCandidateForReferences(id, [reference], identity, options.signal);
        if (hydrated) importedCandidates.push(hydrated);
      } catch (error) {
        if (isCancellation(error, options.signal)) throw error;
        this.degrade(error);
        importedCandidates.push({
          id,
          source: "mpc",
          identityId: identity.id,
          faceId: reference.faceId,
          ...(reference.providerAssetId ? { providerAssetId: reference.providerAssetId } : {}),
          ...(reference.selectedArtworkId ? { selectedArtworkId: reference.selectedArtworkId } : {}),
          originalAvailable: false,
          originalCached: false,
          metadata: referenceMetadata(reference),
        });
      }
    }
    if (identity.id === "custom:artwork-picker" || identity.provider === "local") return importedCandidates.filter((candidate) => !candidateHasKnownUnsupportedFormat(candidate));
    const query = faceQuery(identity, options.faceId);
    if (!query) return importedCandidates;
    let staleSearch: readonly StoredCandidate[] | undefined;
    let appliedFilters = inputFilters;
    try {
      const sources = await this.sources(options.signal);
      if (!sources.length) throw new MpcArtworkProviderError("protocol", "MPC returned no verified Google Drive sources.");
      const verifiedSourceIds = new Set(sources.map(({ pk }) => pk));
      const catalogs: MpcFilterCatalogs = {
        sources: sources.map(({ pk, name, sourceType }) => ({ id: pk, name, sourceType })),
        languages: inputFilters.languages.length || inputFilters.preferredLanguages.length
          ? await this.loadCatalog("languages", "mpc:catalog:languages", "/2/languages/", verifiedLanguages, options.signal)
          : [],
        tags: inputFilters.includeTags.length || inputFilters.excludeTags.length || inputFilters.preferredTags.length
          ? await this.loadCatalog("tags", "mpc:catalog:tags", "/2/tags/", verifiedTags, options.signal)
          : [],
      };
      const filters = validateMpcArtworkFiltersAgainstCatalogs(inputFilters, catalogs);
      appliedFilters = filters;
      const searchKey = buildMpcSearchCacheKey(query, options.faceId ?? "any", filters, [...verifiedSourceIds]);
      const cached = this.metadata.getMetadataSnapshot<readonly StoredCandidate[]>(searchKey);
      if (cached && cached.expiresAt > Date.now()) {
        this.searchCacheHits += 1;
        const refreshed = await Promise.all(cached.value.map(async ({ candidate }) => {
          const current = await this.getCandidate(candidate.id);
          return { ...(current ?? candidate), identityId: identity.id };
        }));
        this.operationSucceeded("search");
        return this.combineCandidates(importedCandidates, rankMpcCandidates(
          refreshed.filter((candidate) => !candidateHasKnownUnsupportedFormat(candidate) && candidateMatchesFilters(candidate, filters)), identity, filters,
        ));
      }
      staleSearch = cached?.value;
      this.searchCacheMisses += 1;
      const settings = {
        filterSettings: {
          minimumDPI: filters.minimumDpi,
          maximumDPI: filters.maximumDpi,
          maximumSize: 30,
          includesTags: [...filters.includeTags],
          excludesTags: [...filters.excludeTags],
          languages: [...filters.languages],
        },
        searchTypeSettings: { fuzzySearch: false, filterCardbacks: false },
        sourceSettings: { sources: sources.map(({ pk }) => [pk, filters.sources.length === 0 || filters.sources.includes(pk)]) },
      };
      const searchQuery = { query, cardType: "CARD" };
      const hash = requestHash(searchQuery);
      this.fallbackV2Used = false;
      const v3 = await this.apiJson("/3/editorSearch/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchSettings: settings, queries: { [hash]: searchQuery } }),
      }, options.signal, true);
      let version: "v3" | "v2" = "v3";
      let payload: unknown = v3.payload;
      if (v3.status === 404) {
        this.v3Available = false;
        version = "v2";
        const v2 = await this.apiJson("/2/editorSearch/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ searchSettings: settings, queries: [{ query, cardType: "CARD" }] }),
        }, options.signal);
        payload = v2.payload;
      }
      const ids = resultIds(payload, query, hash, version).slice(0, this.searchLimit);
      this.lastProtocolConfirmed = version;
      this.fallbackV2Used = version === "v2";
      if (version === "v3") this.v3Available = true;
      const cardsResponse = ids.length ? await this.apiJson("/2/cards/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardIdentifiers: ids }),
      }, options.signal) : undefined;
      const side = options.faceId ?? "front";
      const requestedIds = new Set(ids);
      const hydratedCards = ids.length ? cardItems(cardsResponse?.payload, requestedIds) : [];
      let rejectedCandidate = hydratedCards.length < ids.length;
      if (rejectedCandidate) this.degrade(new MpcArtworkProviderError("protocol", "MPC card hydration omitted one or more requested asset IDs."));
      const candidates = hydratedCards.flatMap((item): StoredCandidate[] => {
        try {
          const candidate = this.candidateFromCard(item, identity, side, verifiedSourceIds);
          if (!candidate) return [];
          if (!candidateMatchesFilters(candidate.candidate, filters)) return [];
          return [candidate];
        } catch (error) {
          rejectedCandidate = true;
          this.degrade(error);
          return [];
        }
      });
      for (const item of candidates) this.metadata.putMetadata(candidateKey(item.candidate.id), item, Date.now() + CANDIDATE_TTL_MS);
      if (!rejectedCandidate) {
        this.metadata.putMetadata(searchKey, candidates, Date.now() + CACHE_TTL_MS);
        this.operationSucceeded("search");
      }
      return this.combineCandidates(importedCandidates, rankMpcCandidates(
        candidates.map(({ candidate }) => candidate).filter((candidate) => !candidateHasKnownUnsupportedFormat(candidate)), identity, filters,
      ));
    } catch (error) {
      if (isCancellation(error, options.signal)) throw error;
      if (error instanceof MpcArtworkFilterValidationError) throw error;
      this.degrade(error);
      if (staleSearch) {
        const stale = await Promise.all(staleSearch.map(async ({ candidate }) => ({
          ...(await this.getCandidate(candidate.id) ?? candidate),
          identityId: identity.id,
        })));
        return this.combineCandidates(importedCandidates, rankMpcCandidates(
          stale.filter((candidate) => !candidateHasKnownUnsupportedFormat(candidate) && candidateMatchesFilters(candidate, appliedFilters)),
          identity,
          appliedFilters,
        ));
      }
      if (!importedCandidates.length) throw error;
      return importedCandidates.filter((candidate) => !candidateHasKnownUnsupportedFormat(candidate));
    }
  }

  private async sources(signal?: AbortSignal): Promise<SourceRecord[]> {
    return this.loadCatalog("sources", "mpc:sources:google-drive", "/2/sources/", (payload) => {
      const result = verifiedSources(payload);
      if (!result.length) throw new MpcArtworkProviderError("protocol", "MPC returned no verified Google Drive sources.");
      return result;
    }, signal);
  }

  private async loadCatalog<T>(
    kind: "sources" | "languages" | "tags",
    key: string,
    path: string,
    parse: (payload: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const cached = this.metadata.getMetadataSnapshot<T>(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      this.catalogStates[kind] = { state: "fresh", ageMs: Math.max(0, now - cached.updatedAt) };
      return cached.value;
    }
    try {
      const response = await this.apiJson(path, { method: "GET" }, signal);
      const value = parse(response.payload);
      this.metadata.putMetadata(key, value, Date.now() + CACHE_TTL_MS);
      this.catalogStates[kind] = { state: "fresh", ageMs: 0 };
      if (Object.values(this.catalogStates).every(({ state }) => state !== "unavailable" && state !== "stale")) this.catalogDegraded = false;
      return value;
    } catch (error) {
      if (isCancellation(error, signal)) throw error;
      this.catalogDegraded = true;
      if (cached) {
        this.catalogStates[kind] = { state: "stale", ageMs: Math.max(0, now - cached.updatedAt) };
        return cached.value;
      }
      this.catalogStates[kind] = { state: "unavailable" };
      throw error;
    }
  }

  private combineCandidates(imported: readonly ArtworkCandidate[], searched: readonly ArtworkCandidate[]): readonly ArtworkCandidate[] {
    const combined = new Map(imported.map((candidate) => [candidate.id, candidate]));
    for (const candidate of searched) if (!combined.has(candidate.id)) combined.set(candidate.id, candidate);
    return [...combined.values()];
  }

  private recordSvgPdfValidation(stored: StoredCandidate, exportable: boolean, originalCached = stored.candidate.originalCached): StoredCandidate {
    const updated: StoredCandidate = {
      ...stored,
      candidate: {
        ...stored.candidate,
        originalAvailable: exportable,
        originalCached,
        metadata: {
          ...stored.candidate.metadata,
          extension: "svg",
          originalFormatKnown: true,
          originalFormatExportable: exportable,
          svgPdfValidationVersion: SVG_PDF_VALIDATION_VERSION,
        },
      },
    };
    this.metadata.putMetadata(candidateKey(updated.candidate.id), updated, Date.now() + CANDIDATE_TTL_MS);
    return updated;
  }

  private async svgPdfExportable(bytes: Uint8Array): Promise<boolean> {
    try {
      await validateSvgForPdfExport(bytes);
      return true;
    } catch {
      return false;
    }
  }

  async getCandidate(id: string): Promise<ArtworkCandidate | undefined> {
    if (!/^mpc:[a-f0-9]{64}$/.test(id)) return undefined;
    const snapshot = this.metadata.getMetadataSnapshot<StoredCandidate>(candidateKey(id));
    const stored = snapshot?.value;
    if (!stored) return undefined;
    const sourceUrl = stored.candidate.providerAssetId ? this.sourceUrl(stored.candidate.providerAssetId) : undefined;
    const originalRecord = sourceUrl && stored.candidate.providerAssetId
      ? this.repository.findOriginalByProviderSource("mpc", stored.candidate.providerAssetId, sourceUrl)
      : undefined;
    let original: ArtworkOriginal | undefined;
    if (originalRecord) {
      try { original = await this.originals.getOriginal(originalRecord.artworkId); }
      catch (error) {
        if (!(error instanceof ArtworkStorageError)) throw error;
        this.degrade(error);
      }
    }
    const actualExtension = original?.extension ?? originalRecord?.extension ?? normalizeExtension(stored.candidate.metadata?.extension);
    const isSvg = canonicalExtension(actualExtension) === "svg";
    let effectiveStored = stored;
    if (isSvg && original && stored.candidate.metadata?.svgPdfValidationVersion !== SVG_PDF_VALIDATION_VERSION) {
      effectiveStored = this.recordSvgPdfValidation(stored, await this.svgPdfExportable(original.bytes), true);
    }
    const formatKnown = effectiveStored.candidate.metadata?.originalFormatKnown === true || actualExtension !== undefined;
    const {
      originalFormatExportable: storedFormatExportable,
      svgPdfValidationVersion: _storedSvgPdfValidationVersion,
      ...metadataWithoutExportability
    } = effectiveStored.candidate.metadata ?? {};
    const svgValidationCurrent = isSvg
      && Boolean(original)
      && effectiveStored.candidate.metadata?.svgPdfValidationVersion === SVG_PDF_VALIDATION_VERSION
      && typeof storedFormatExportable === "boolean";
    const formatExportable = isSvg
      ? svgValidationCurrent
        ? storedFormatExportable
        : storedFormatExportable === false ? false : undefined
      : !formatKnown || isExportableOriginalExtension(actualExtension);
    const remoteMetadataStatus = effectiveStored.candidate.metadata?.remoteMetadataStatus;
    const remoteUnavailable = remoteMetadataStatus === "removed" || remoteMetadataStatus === "invalid" || remoteMetadataStatus === "unsupported";
    return {
      ...effectiveStored.candidate,
      originalAvailable: formatExportable === false ? false : original ? true : remoteUnavailable ? false : effectiveStored.candidate.originalAvailable,
      originalCached: Boolean(original),
      metadata: {
        ...metadataWithoutExportability,
        ...(snapshot && snapshot.expiresAt <= Date.now() && !metadataWithoutExportability.remoteMetadataStatus
          ? { remoteMetadataStatus: "stale" }
          : {}),
        ...(formatKnown ? {
          ...(actualExtension ? { extension: actualExtension } : {}),
          originalFormatKnown: true,
        } : {}),
        ...(formatExportable !== undefined ? { originalFormatExportable: formatExportable } : {}),
        ...(svgValidationCurrent
          ? { svgPdfValidationVersion: SVG_PDF_VALIDATION_VERSION }
          : {}),
      },
      ...(original ? {
        widthPx: original.widthPx,
        heightPx: original.heightPx,
        effectiveDpi: calculateEffectiveDpi(original.widthPx, original.heightPx),
      } : {}),
    };
  }

  async getCandidateForReferences(id: string, references: readonly WorkingCardMpcReference[], identity: CardIdentity, signal?: AbortSignal): Promise<ArtworkCandidate | undefined> {
    const reference = references.find((item) =>
      (item.faceId === "front" || item.faceId === "back") && mpcArtworkCandidateId(item.importedAssetId, item.faceId) === id,
    );
    if (!reference) return this.getCandidate(id);
    if (signal?.aborted) throw new MpcArtworkProviderError("aborted", "The MPC reference lookup was cancelled.");
    const faceId: CardFaceSide = reference.faceId === "back" ? "back" : "front";
    const assetId = reference.providerAssetId ?? reference.selectedArtworkId;
    const selectedArtworkId = reference.selectedArtworkId;
    if (assetId && !validAssetId(assetId)) throw new MpcArtworkProviderError("unsafe-source", "Imported MPC artwork identifier is invalid.");
    const cached = this.metadata.getMetadata<StoredCandidate>(candidateKey(id));
    if (cached && cached.candidate.providerAssetId === assetId && cached.candidate.selectedArtworkId === selectedArtworkId) {
      const candidate = await this.getCandidate(id);
      return candidate ? {
        ...candidate,
        identityId: identity.id,
        metadata: { ...candidate.metadata, ...referenceMetadata(reference) },
      } : undefined;
    }
    const sourceUrl = assetId ? this.sourceUrl(assetId) : undefined;
    const localOriginalRecord = sourceUrl && assetId ? this.repository.findOriginalByProviderSource("mpc", assetId, sourceUrl) : undefined;
    let localOriginal: ArtworkOriginal | undefined;
    let localStorageFailure: ArtworkStorageError | undefined;
    if (localOriginalRecord) {
      try { localOriginal = await this.originals.getOriginal(localOriginalRecord.artworkId); }
      catch (error) {
        if (!(error instanceof ArtworkStorageError) || (error.code !== "ARTWORK_MISSING" && error.code !== "ARTWORK_CONTENT_CORRUPT")) throw error;
        localStorageFailure = error;
        this.degrade(error);
      }
    }
    if (localOriginal) {
      const isSvg = canonicalExtension(localOriginal.extension) === "svg";
      const originalFormatExportable = isExportableOriginalExtension(localOriginal.extension);
      const candidate: ArtworkCandidate = {
        id,
        source: "mpc",
        identityId: identity.id,
        faceId,
        ...(assetId ? { providerAssetId: assetId } : {}),
        ...(selectedArtworkId ? { selectedArtworkId } : {}),
        widthPx: localOriginal.widthPx,
        heightPx: localOriginal.heightPx,
        effectiveDpi: calculateEffectiveDpi(localOriginal.widthPx, localOriginal.heightPx),
        originalAvailable: isSvg || originalFormatExportable,
        originalCached: true,
        metadata: {
          ...referenceMetadata(reference),
          sourceType: "Google Drive",
          extension: localOriginal.extension,
          originalFormatKnown: true,
          ...(!isSvg ? { originalFormatExportable } : {}),
        },
      };
      const stored: StoredCandidate = { candidate };
      this.metadata.putMetadata(candidateKey(id), stored, Date.now() + CANDIDATE_TTL_MS);
      return await this.getCandidate(id) ?? candidate;
    }

    const baseCandidate: ArtworkCandidate = {
      id,
      source: "mpc",
      identityId: identity.id,
      faceId,
      ...(assetId ? { providerAssetId: assetId } : {}),
      ...(selectedArtworkId ? { selectedArtworkId } : {}),
      originalAvailable: false,
      originalCached: false,
      metadata: referenceMetadata(reference),
    };
    if (!assetId || !sourceUrl) {
      this.metadata.putMetadata(candidateKey(id), { candidate: baseCandidate }, Date.now() + CANDIDATE_TTL_MS);
      return baseCandidate;
    }

    try {
      const sources = await this.sources(signal);
      if (!sources.length) {
        const error = new MpcArtworkProviderError("protocol", "MPC returned no verified Google Drive sources.");
        this.degrade(error);
        throw error;
      }
      const verifiedSourceIds = new Set(sources.map(({ pk }) => pk));
      const response = await this.apiJson("/2/cards/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardIdentifiers: [assetId] }),
      }, signal);
      let documents: Record<string, unknown>[];
      try { documents = cardItems(response.payload, new Set([assetId])); }
      catch (error) { this.degrade(error); throw error; }
      const document = documents.find((item) => item.identifier === assetId);
      if (!document) {
        const error = new MpcArtworkProviderError("protocol", "MPC card hydration omitted the selected imported artwork ID.");
        this.degrade(error);
        throw error;
      }
      let online: StoredCandidate | undefined;
      try { online = this.candidateFromCard(document, identity, faceId, verifiedSourceIds); }
      catch (error) { this.degrade(error); throw error; }
      if (!online) return undefined;
      const candidate: ArtworkCandidate = {
        ...online.candidate,
        id,
        providerAssetId: assetId,
        ...(selectedArtworkId ? { selectedArtworkId } : {}),
        metadata: { ...online.candidate.metadata, ...referenceMetadata(reference) },
      };
      const stored: StoredCandidate = { ...online, candidate };
      this.metadata.putMetadata(candidateKey(id), stored, Date.now() + CANDIDATE_TTL_MS);
      this.health = { available: true, degraded: false };
      return candidate;
    } catch (error) {
      if (localStorageFailure && !isCancellation(error, signal) && error instanceof MpcArtworkProviderError && ["network", "timeout", "http"].includes(error.kind)) {
        const failure = new MpcArtworkProviderError(
          error.kind,
          `The cached MPC original failed local validation (${localStorageFailure.code}), and provider revalidation failed: ${error.message}`,
          error.status,
        );
        this.degrade(failure);
        throw failure;
      }
      throw error;
    }
  }

  async getPreview(id: string, signal?: AbortSignal): Promise<ArtworkPreview | undefined> {
    const candidate = await this.getCandidate(id);
    if (!candidate) return undefined;
    const cached = await this.thumbnails.getThumbnail(id);
    if (cached) return { candidateId: id, source: "mpc", bytes: cached.bytes, contentType: `image/${cached.extension === "jpg" ? "jpeg" : cached.extension}`, widthPx: cached.widthPx, heightPx: cached.heightPx };
    const stored = this.metadata.getMetadata<StoredCandidate>(candidateKey(id));
    if (!stored?.thumbnailUrl) return undefined;
    const { response, bytes } = await this.fetchImage(stored.thumbnailUrl, THUMBNAIL_LIMIT, "thumbnail", signal);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType || imageType(bytes) !== contentType) {
      const error = new MpcArtworkProviderError("invalid-image", "MPC thumbnail content type does not match its image signature.");
      this.degrade(error);
      throw error;
    }
    const thumbnail = await this.thumbnails.putThumbnail(id, bytes, { thumbnailSourceUrl: stored.thumbnailUrl });
    const saved = await this.thumbnails.getThumbnail(id);
    if (!saved) throw new Error("MPC thumbnail was not persisted.");
    return { candidateId: id, source: "mpc", bytes: saved.bytes, contentType, widthPx: saved.widthPx, heightPx: saved.heightPx };
  }

  async getOriginal(id: string, signal?: AbortSignal): Promise<ArtworkOriginal> {
    const candidate = await this.getCandidate(id);
    if (candidate?.metadata?.originalFormatExportable === false) {
      throw new MpcArtworkProviderError("unsupported-format", `MPC original format ${String(candidate.metadata.extension ?? "unknown").toUpperCase()} is not supported by PDF export.`);
    }
    if (!candidate?.providerAssetId || !candidate.originalAvailable) throw new ArtworkStorageError("ARTWORK_MISSING", `MPC original for ${id} is unavailable.`);
    const sourceUrl = this.sourceUrl(candidate.providerAssetId);
    if (!sourceUrl) throw new MpcArtworkProviderError("unsafe-source", "MPC Google Drive identifier is invalid.");
    const existing = this.repository.findOriginalByProviderSource("mpc", candidate.providerAssetId, sourceUrl);
    let localStorageFailure: ArtworkStorageError | undefined;
    if (existing) {
      try { return await this.originals.getOriginal(existing.artworkId); }
      catch (error) {
        if (!(error instanceof ArtworkStorageError) || (error.code !== "ARTWORK_MISSING" && error.code !== "ARTWORK_CONTENT_CORRUPT")) {
          if (error instanceof ArtworkStorageError) this.degrade(error);
          throw error;
        }
        localStorageFailure = error;
        this.degrade(error);
      }
    }
    let response: Response;
    let bytes: Uint8Array;
    try {
      ({ response, bytes } = await this.fetchImage(sourceUrl, this.maximumOriginalBytes, "original", signal));
    } catch (error) {
      if (!localStorageFailure || isCancellation(error, signal) || !(error instanceof MpcArtworkProviderError)) throw error;
      throw new MpcArtworkProviderError(
        error.kind,
        `The cached MPC original failed local validation (${localStorageFailure.code}); remote recovery failed.`,
        error.status,
      );
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const stored = this.metadata.getMetadata<StoredCandidate>(candidateKey(id));
    let validatedImage: Awaited<ReturnType<typeof validateImageBytes>>;
    try {
      validatedImage = await validateImageBytes(bytes, this.maximumOriginalBytes);
    } catch (error) {
      const unsupported = error instanceof ArtworkStorageError && error.code === "ARTWORK_UNSUPPORTED_FORMAT";
      if (stored && canonicalExtension(candidate.metadata?.extension) === "svg") {
        this.recordSvgPdfValidation(stored, false, false);
      } else if (unsupported && stored) this.metadata.putMetadata(candidateKey(id), {
        ...stored,
        candidate: {
          ...stored.candidate,
          originalAvailable: false,
          originalCached: false,
          metadata: { ...stored.candidate.metadata, originalFormatKnown: true, originalFormatExportable: false },
        },
      }, Date.now() + CANDIDATE_TTL_MS);
      const validationFailure = new MpcArtworkProviderError(unsupported ? "unsupported-format" : "invalid-image", unsupported
        ? "MPC original format is not supported by the current artwork pipeline."
        : "MPC original bytes failed image validation.");
      if (!unsupported) this.degrade(validationFailure);
      throw validationFailure;
    }
    const expectedType = mimeTypeForFormat(validatedImage.format);
    if (!expectedType || contentType !== expectedType) {
      if (stored && (canonicalExtension(candidate.metadata?.extension) === "svg" || validatedImage.format === "svg")) {
        this.recordSvgPdfValidation(stored, false, false);
      }
      const error = new MpcArtworkProviderError("invalid-image", "MPC original content type does not match its image signature.");
      this.degrade(error);
      throw error;
    }
    if (!isExportableOriginalExtension(validatedImage.extension)) {
      if (stored) this.metadata.putMetadata(candidateKey(id), {
        ...stored,
        candidate: {
          ...stored.candidate,
          originalAvailable: false,
          originalCached: false,
          metadata: { ...stored.candidate.metadata, extension: validatedImage.extension, originalFormatKnown: true, originalFormatExportable: false },
        },
      }, Date.now() + CANDIDATE_TTL_MS);
      throw new MpcArtworkProviderError("unsupported-format", `MPC original format ${validatedImage.extension.toUpperCase()} is not supported by PDF export.`);
    }
    const declaredExtension = canonicalExtension(candidate.metadata?.extension);
    if (declaredExtension && declaredExtension !== canonicalExtension(validatedImage.extension)) {
      if (stored && (declaredExtension === "svg" || canonicalExtension(validatedImage.extension) === "svg")) {
        this.recordSvgPdfValidation(stored, false, false);
      }
      const error = new MpcArtworkProviderError("invalid-image", "MPC original format differs from the hydrated card metadata.");
      this.degrade(error);
      throw error;
    }
    if (validatedImage.format === "svg" && !(await this.svgPdfExportable(bytes))) {
      if (stored) this.recordSvgPdfValidation(stored, false, false);
      throw new MpcArtworkProviderError("unsupported-format", "MPC SVG original is not supported by PDF export.");
    }
    if (stored?.declaredSize && bytes.byteLength !== stored.declaredSize) {
      const error = new MpcArtworkProviderError("invalid-image", "MPC original byte length differs from the hydrated card metadata.");
      this.degrade(error);
      throw error;
    }
    const original = await this.originals.addOriginal(bytes, {
      provider: "mpc",
      providerAssetId: candidate.providerAssetId,
      sourceUrl,
      downloadedAt: new Date().toISOString(),
      contentType,
      importMetadata: { candidateId: id, faceId: candidate.faceId, selectedArtworkId: candidate.selectedArtworkId, ...(candidate.metadata ?? {}) },
    });
    if (stored) this.metadata.putMetadata(candidateKey(id), {
      ...stored,
      candidate: {
        ...stored.candidate,
        widthPx: original.widthPx,
        heightPx: original.heightPx,
        effectiveDpi: calculateEffectiveDpi(original.widthPx, original.heightPx),
        originalAvailable: true,
        originalCached: true,
        metadata: {
          ...stored.candidate.metadata,
          extension: original.extension,
          originalFormatKnown: true,
          originalFormatExportable: true,
          ...(original.format === "svg" ? { svgPdfValidationVersion: SVG_PDF_VALIDATION_VERSION } : {}),
        },
      },
    }, Date.now() + CANDIDATE_TTL_MS);
    this.health = { available: true, degraded: false };
    return original;
  }

  private candidateFromCard(item: Record<string, unknown>, identity: CardIdentity, faceId: CardFaceSide, verifiedSourceIds: ReadonlySet<number>): StoredCandidate | undefined {
    if (!validAssetId(item.identifier)) return undefined;
    if (item.cardType !== "CARD") throw new MpcArtworkProviderError("protocol", "MPC card hydration omitted or returned an unsupported cardType.");
    if (item.sourceType !== "Google Drive") {
      throw new MpcArtworkProviderError("unsafe-source", "MPC returned an unsupported artwork source or card type.");
    }
    const sourceId = typeof item.sourceId === "number" ? item.sourceId : Number.NaN;
    if (!Number.isSafeInteger(sourceId) || !verifiedSourceIds.has(sourceId)) {
      throw new MpcArtworkProviderError("unsafe-source", "MPC artwork does not belong to a verified Google Drive source.");
    }
    const extension = normalizeExtension(item.extension);
    if (extension && !isExportableOriginalExtension(extension) && canonicalExtension(extension) !== "svg") return undefined;
    const size = Number(item.size);
    const declaredSize = Number.isSafeInteger(size) && size > 0 ? size : undefined;
    const rawThumbnail = item.smallThumbnailUrl ?? item.mediumThumbnailUrl;
    const thumbnailUrl = typeof rawThumbnail === "string" ? safeImageUrl(rawThumbnail, "thumbnail")?.toString() : undefined;
    if (rawThumbnail !== undefined && !thumbnailUrl) throw new MpcArtworkProviderError("unsafe-source", "MPC thumbnail URL is not on an approved HTTPS host.");
    const dpi = typeof item.dpi === "number" && Number.isSafeInteger(item.dpi) && item.dpi > 0 ? item.dpi : Number.NaN;
    const name = safeCatalogText(item.name, 200);
    const language = typeof item.language === "string" && /^[A-Za-z0-9-]{1,16}$/.test(item.language) ? item.language.toLowerCase() : undefined;
    const sourceName = safeCatalogText(item.sourceName, 120);
    const tags = safeRemoteTags(item.tags);
    const priority = typeof item.priority === "number" && Number.isSafeInteger(item.priority) ? item.priority : undefined;
    const dateCreated = safeTimestamp(item.dateCreated);
    const dateModified = safeTimestamp(item.dateModified);
    const canonicalCard = safeCanonicalCard(item.canonicalCard);
    const canonicalArtist = safeCanonicalArtist(item.canonicalArtist);
    const id = mpcArtworkCandidateId(item.identifier, faceId);
    const candidate: ArtworkCandidate = {
      id,
      source: "mpc",
      identityId: identity.id,
      faceId,
      ...(name ? { faceName: name } : {}),
      ...(thumbnailUrl ? { previewUri: thumbnailUrl } : {}),
      ...(language ? { language } : {}),
      providerAssetId: item.identifier,
      selectedArtworkId: item.identifier,
      originalAvailable: declaredSize !== undefined && declaredSize <= this.maximumOriginalBytes,
      originalCached: false,
      metadata: {
        ...(name ? { name } : {}),
        sourceType: item.sourceType,
        sourceId,
        ...(sourceName ? { sourceName } : {}),
        ...(extension ? { extension } : {}),
        originalFormatKnown: Boolean(extension),
        ...(extension && canonicalExtension(extension) !== "svg" ? { originalFormatExportable: true } : {}),
        ...(declaredSize ? { declaredSize } : {}),
        ...(Number.isFinite(dpi) && dpi > 0 ? { dpi } : {}),
        ...(language ? { language } : {}),
        ...(tags ? { tags } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(dateCreated ? { dateCreated } : {}),
        ...(dateModified ? { dateModified } : {}),
        ...(canonicalCard ? { canonicalCard } : {}),
        ...(canonicalArtist ? { canonicalArtist } : {}),
        remoteMetadataStatus: "current",
      },
    };
    return { candidate, ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(declaredSize ? { declaredSize } : {}) };
  }

  private async apiJson(path: string, init: RequestInit, signal?: AbortSignal, allowNotFound = false): Promise<{ status: number; payload?: unknown }> {
    const scope = createRequestScope(signal, this.timeoutMs);
    try {
      let url = safeUrl(new URL(path, this.baseUrl).toString(), API_HOSTS);
      if (!url) throw new MpcArtworkProviderError("unsafe-source", "MPC API URL is not on the configured HTTPS host.");
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const response: Response = await scope.run(this.fetchImpl(url, { ...init, credentials: "omit", cache: "no-store", signal: scope.signal, redirect: "manual" }));
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects === 3) throw new MpcArtworkProviderError("unsafe-source", "MPC API exceeded the redirect limit.");
          const location: string | null = response.headers.get("location");
          let next: URL | undefined;
          try { next = location ? safeUrl(new URL(location, url).toString(), API_HOSTS) : undefined; } catch { next = undefined; }
          await response.body?.cancel().catch(() => undefined);
          if (!next) throw new MpcArtworkProviderError("unsafe-source", "MPC API redirected to an unapproved URL.");
          url = next;
          continue;
        }
        if (allowNotFound && response.status === 404) return { status: 404 };
        if (!response.ok) throw new MpcArtworkProviderError("http", `MPC API returned HTTP ${response.status}.`, response.status);
        const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (type !== "application/json") throw new MpcArtworkProviderError("protocol", "MPC API response was not JSON.");
        const bytes = await readLimited(response, 8 * 1024 * 1024, scope);
        try {
          const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
          this.health = { available: true, degraded: false };
          return { status: response.status, payload };
        }
        catch { throw new MpcArtworkProviderError("protocol", "MPC API returned invalid JSON."); }
      }
      throw new MpcArtworkProviderError("unsafe-source", "MPC API exceeded the redirect limit.");
    } catch (error) {
      const failure = error instanceof MpcArtworkProviderError ? error : new MpcArtworkProviderError("network", "MPC API request failed.");
      if (!isCancellation(failure, signal)) this.degrade(failure);
      throw failure;
    } finally {
      scope.close();
    }
  }

  private sourceUrl(identifier: string): string | undefined {
    if (!validAssetId(identifier)) return undefined;
    const url = new URL("https://drive.google.com/uc");
    url.searchParams.set("export", "download");
    url.searchParams.set("id", identifier);
    return url.toString();
  }

  private async fetchImage(initialUrl: string, maximumBytes: number, role: "thumbnail" | "original", signal?: AbortSignal): Promise<{ response: Response; bytes: Uint8Array }> {
    const scope = createRequestScope(signal, this.timeoutMs);
    try {
      let url = safeImageUrl(initialUrl, role);
      if (!url) throw new MpcArtworkProviderError("unsafe-source", "MPC artwork URL is not on an approved HTTPS host.");
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const response: Response = await scope.run(this.fetchImpl(url, { method: "GET", credentials: "omit", cache: "no-store", signal: scope.signal, redirect: "manual" }));
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.ok) throw new MpcArtworkProviderError("http", `MPC artwork returned HTTP ${response.status}.`, response.status);
          return { response, bytes: await readLimited(response, maximumBytes, scope) };
        }
        if (redirects === 3) throw new MpcArtworkProviderError("unsafe-source", "MPC artwork exceeded the redirect limit.");
        const location: string | null = response.headers.get("location");
        let next: URL | undefined;
        try { next = location ? safeImageUrl(new URL(location, url).toString(), role) : undefined; } catch { next = undefined; }
        await response.body?.cancel().catch(() => undefined);
        if (!next) throw new MpcArtworkProviderError("unsafe-source", "MPC artwork redirected to an unapproved URL.");
        url = next;
      }
      throw new MpcArtworkProviderError("unsafe-source", "MPC artwork exceeded the redirect limit.");
    } catch (error) {
      const failure = error instanceof MpcArtworkProviderError ? error : new MpcArtworkProviderError("network", "MPC artwork request failed.");
      if (!isCancellation(failure, signal)) this.degrade(failure);
      throw failure;
    } finally {
      scope.close();
    }
  }
}
