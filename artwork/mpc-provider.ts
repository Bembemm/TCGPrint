import { createHash } from "node:crypto";
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

const API_BASE_URL = "https://mpcfill.com";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const THUMBNAIL_LIMIT = 10 * 1024 * 1024;
const DEFAULT_MAX_ORIGINAL_BYTES = 30 * 1024 * 1024;
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

interface SourceRecord { readonly pk: number; readonly sourceType: string; }

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
  return items.flatMap((item): SourceRecord[] => {
    if (!record(item) || item.sourceType !== "Google Drive") return [];
    const pk = Number(item.pk);
    return Number.isSafeInteger(pk) && pk > 0 ? [{ pk, sourceType: "Google Drive" }] : [];
  });
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
  const extension = normalizeExtension(candidate.metadata?.extension);
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

  private degrade(error: unknown): void {
    this.health = { available: false, degraded: true, message: error instanceof Error ? error.message.slice(0, 300) : "MPC artwork provider failed." };
  }

  async searchArtwork(identity: CardIdentity, options: ArtworkSearchOptions = {}): Promise<readonly ArtworkCandidate[]> {
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
        this.health = { available: false, degraded: true, message: error instanceof Error ? error.message.slice(0, 300) : "MPC reference hydration failed." };
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
    const searchKey = `mpc:search:${createHash("sha256").update(`${query.toLocaleLowerCase("en-US")}\0${options.faceId ?? "any"}`).digest("hex")}`;
    const cached = this.metadata.getMetadata<readonly StoredCandidate[]>(searchKey);
    if (cached) {
      for (const item of cached) this.metadata.putMetadata(candidateKey(item.candidate.id), item, Date.now() + CANDIDATE_TTL_MS);
      const refreshed = await Promise.all(cached.map(async ({ candidate }) => {
        const current = await this.getCandidate(candidate.id);
        return { ...(current ?? candidate), identityId: identity.id };
      }));
      return this.combineCandidates(importedCandidates, refreshed.filter((candidate) => !candidateHasKnownUnsupportedFormat(candidate)));
    }

    try {
      const sources = await this.sources(options.signal);
      if (!sources.length) throw new MpcArtworkProviderError("protocol", "MPC returned no verified Google Drive sources.");
      const verifiedSourceIds = new Set(sources.map(({ pk }) => pk));
      const settings = {
        filterSettings: { minimumDPI: 0, maximumDPI: 1500, maximumSize: 30, includesTags: [], excludesTags: [], languages: [] },
        searchTypeSettings: { fuzzySearch: false, filterCardbacks: false },
        sourceSettings: { sources: sources.map(({ pk }) => [pk, true]) },
      };
      const searchQuery = { query, cardType: "CARD" };
      const hash = requestHash(searchQuery);
      const v3 = await this.apiJson("/3/editorSearch/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchSettings: settings, queries: { [hash]: searchQuery } }),
      }, options.signal, true);
      let version: "v3" | "v2" = "v3";
      let payload: unknown = v3.payload;
      if (v3.status === 404) {
        version = "v2";
        const v2 = await this.apiJson("/2/editorSearch/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ searchSettings: settings, queries: [{ query, cardType: "CARD" }] }),
        }, options.signal);
        payload = v2.payload;
      }
      const ids = resultIds(payload, query, hash, version).slice(0, this.searchLimit);
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
          return candidate ? [candidate] : [];
        } catch (error) {
          rejectedCandidate = true;
          this.degrade(error);
          return [];
        }
      });
      for (const item of candidates) this.metadata.putMetadata(candidateKey(item.candidate.id), item, Date.now() + CANDIDATE_TTL_MS);
      if (!rejectedCandidate) {
        this.metadata.putMetadata(searchKey, candidates, Date.now() + CACHE_TTL_MS);
        this.health = { available: true, degraded: false };
      }
      return this.combineCandidates(importedCandidates, candidates.map(({ candidate }) => candidate).filter((candidate) => !candidateHasKnownUnsupportedFormat(candidate)));
    } catch (error) {
      if (isCancellation(error, options.signal)) throw error;
      this.degrade(error);
      if (!importedCandidates.length) throw error;
      return importedCandidates.filter((candidate) => !candidateHasKnownUnsupportedFormat(candidate));
    }
  }

  private combineCandidates(imported: readonly ArtworkCandidate[], searched: readonly ArtworkCandidate[]): readonly ArtworkCandidate[] {
    const combined = new Map(imported.map((candidate) => [candidate.id, candidate]));
    for (const candidate of searched) if (!combined.has(candidate.id)) combined.set(candidate.id, candidate);
    return [...combined.values()];
  }

  async getCandidate(id: string): Promise<ArtworkCandidate | undefined> {
    if (!/^mpc:[a-f0-9]{64}$/.test(id)) return undefined;
    const stored = this.metadata.getMetadata<StoredCandidate>(candidateKey(id));
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
    const formatKnown = stored.candidate.metadata?.originalFormatKnown === true || actualExtension !== undefined;
    const formatExportable = !formatKnown || isExportableOriginalExtension(actualExtension);
    return {
      ...stored.candidate,
      originalAvailable: formatExportable && (original ? true : stored.candidate.originalAvailable),
      originalCached: Boolean(original),
      metadata: {
        ...stored.candidate.metadata,
        ...(formatKnown ? {
          ...(actualExtension ? { extension: actualExtension } : {}),
          originalFormatKnown: true,
          originalFormatExportable: formatExportable,
        } : {}),
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
        originalAvailable: isExportableOriginalExtension(localOriginal.extension),
        originalCached: true,
        metadata: {
          ...referenceMetadata(reference),
          sourceType: "Google Drive",
          extension: localOriginal.extension,
          originalFormatKnown: true,
          originalFormatExportable: isExportableOriginalExtension(localOriginal.extension),
        },
      };
      const stored: StoredCandidate = { candidate };
      this.metadata.putMetadata(candidateKey(id), stored, Date.now() + CANDIDATE_TTL_MS);
      return candidate;
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
    if (existing) {
      try { return await this.originals.getOriginal(existing.artworkId); }
      catch (error) {
        if (!(error instanceof ArtworkStorageError) || (error.code !== "ARTWORK_MISSING" && error.code !== "ARTWORK_CONTENT_CORRUPT")) {
          if (error instanceof ArtworkStorageError) this.degrade(error);
          throw error;
        }
        this.degrade(error);
      }
    }
    const { response, bytes } = await this.fetchImage(sourceUrl, this.maximumOriginalBytes, "original", signal);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const stored = this.metadata.getMetadata<StoredCandidate>(candidateKey(id));
    let validatedImage: Awaited<ReturnType<typeof validateImageBytes>>;
    try {
      validatedImage = await validateImageBytes(bytes, this.maximumOriginalBytes);
    } catch (error) {
      const unsupported = error instanceof ArtworkStorageError && error.code === "ARTWORK_UNSUPPORTED_FORMAT";
      if (unsupported && stored) this.metadata.putMetadata(candidateKey(id), {
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
      const error = new MpcArtworkProviderError("invalid-image", "MPC original format differs from the hydrated card metadata.");
      this.degrade(error);
      throw error;
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
        metadata: { ...stored.candidate.metadata, extension: original.extension, originalFormatKnown: true, originalFormatExportable: true },
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
    const sourceId = Number(item.sourceId);
    if (!Number.isSafeInteger(sourceId) || !verifiedSourceIds.has(sourceId)) {
      throw new MpcArtworkProviderError("unsafe-source", "MPC artwork does not belong to a verified Google Drive source.");
    }
    const extension = normalizeExtension(item.extension);
    if (extension && !isExportableOriginalExtension(extension)) return undefined;
    const size = Number(item.size);
    const declaredSize = Number.isSafeInteger(size) && size > 0 ? size : undefined;
    const rawThumbnail = item.smallThumbnailUrl ?? item.mediumThumbnailUrl;
    const thumbnailUrl = typeof rawThumbnail === "string" ? safeImageUrl(rawThumbnail, "thumbnail")?.toString() : undefined;
    if (rawThumbnail !== undefined && !thumbnailUrl) throw new MpcArtworkProviderError("unsafe-source", "MPC thumbnail URL is not on an approved HTTPS host.");
    const dpi = Number(item.dpi);
    const id = mpcArtworkCandidateId(item.identifier, faceId);
    const candidate: ArtworkCandidate = {
      id,
      source: "mpc",
      identityId: identity.id,
      faceId,
      ...(typeof item.name === "string" ? { faceName: item.name.slice(0, 200) } : {}),
      ...(thumbnailUrl ? { previewUri: thumbnailUrl } : {}),
      providerAssetId: item.identifier,
      selectedArtworkId: item.identifier,
      originalAvailable: declaredSize !== undefined && declaredSize <= this.maximumOriginalBytes,
      originalCached: false,
      metadata: {
        ...(typeof item.name === "string" ? { name: item.name.slice(0, 200) } : {}),
        sourceType: item.sourceType,
        ...(typeof item.sourceName === "string" ? { sourceName: item.sourceName.slice(0, 200) } : {}),
        ...(extension ? { extension } : {}),
        originalFormatKnown: Boolean(extension),
        ...(extension ? { originalFormatExportable: true } : {}),
        ...(declaredSize ? { declaredSize } : {}),
        ...(Number.isFinite(dpi) && dpi > 0 ? { dpi } : {}),
      },
    };
    return { candidate, ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(declaredSize ? { declaredSize } : {}) };
  }

  private async sources(signal?: AbortSignal): Promise<SourceRecord[]> {
    const key = "mpc:sources:google-drive";
    const cached = this.metadata.getMetadata<SourceRecord[]>(key);
    if (cached?.length) return cached;
    const response = await this.apiJson("/2/sources/", { method: "GET" }, signal);
    const sources = verifiedSources(response.payload);
    this.metadata.putMetadata(key, sources, Date.now() + CACHE_TTL_MS);
    return sources;
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
