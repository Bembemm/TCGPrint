import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ImportFailureError, importFiles } from "../import-engine";
import type { ImportReport, ImportResult, ImportedAsset, ImportedEntry, UniversalImportRequest } from "../import-engine/types";
import { sanitizeRelativeImportPath } from "../import-engine/source-path";
import { ArtworkCatalog } from "../artwork/catalog";
import { calculateEffectiveDpi, artworkResolutionQuality } from "../artwork/effective-dpi";
import { LocalArtworkProvider } from "../artwork/local-provider";
import { MpcReferenceArtworkProvider } from "../artwork/mpc-reference-provider";
import { ScryfallArtworkProvider } from "../artwork/scryfall-provider";
import { ArtworkMetadataCache } from "../artwork/storage/metadata-cache";
import { ArtworkOriginalStore } from "../artwork/storage/original-store";
import { appDataPaths } from "../artwork/storage/paths";
import { ArtworkRepository } from "../artwork/storage/repository";
import { ArtworkThumbnailStore } from "../artwork/storage/thumbnail-store";
import type { ArtworkCatalogSource, ArtworkPreview, ProviderHealth } from "../artwork/types";
import { confirmIdentity, IdentityResolver, keepCustom, selectDefaultArtwork } from "../core/cards/identity-resolver";
import { selectArtwork as updateSelectedArtwork, createWorkingSet } from "../core/cards/working-set";
import type { ArtworkCandidate, CardFaceSide, CardIdentity, IdentityResolutionCandidate, SelectedArtwork, WorkingCard, WorkingCardMpcReference } from "../core/cards/types";
import { ScryfallClient } from "../providers/scryfall/client";
import { ScryfallError } from "../providers/scryfall/errors";
import type { ScryfallCard } from "../providers/scryfall/types";
import { TesseractOcrRecognizer } from "../providers/ocr/tesseract-recognizer";
import { openArtworkDatabase } from "../persistence/sqlite";

const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOADS = 200;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export interface SafeImportIssue {
  readonly code: string;
  readonly message: string;
  readonly filename?: string;
  readonly line?: number;
  readonly field?: string;
}

export interface SafeImportReport {
  readonly summary: ImportReport["summary"];
  readonly selectedImporters: readonly { readonly sourceId: string; readonly kind: string }[];
  readonly warnings: readonly SafeImportIssue[];
  readonly errors: readonly SafeImportIssue[];
  readonly pairings: readonly { readonly frontAssetId: string; readonly backAssetId: string; readonly confidence: number; readonly reason: string; readonly accepted: false }[];
}

export interface WorkingSetImportResult {
  readonly workingCards: readonly WorkingCard[];
  readonly report: SafeImportReport;
  readonly providerHealth: Readonly<Record<string, ProviderHealth>>;
}

export interface ResolveWorkingCardsResult {
  readonly workingCards: readonly WorkingCard[];
  readonly providerHealth: Readonly<Record<string, ProviderHealth>>;
}

export interface CardWorkbenchOptions {
  readonly dataDirectory?: string;
  readonly fetchImpl?: typeof fetch;
  readonly minIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly maxUploadBytes?: number;
  readonly recognizer?: {
    recognizeName(bytes: Uint8Array, options?: { signal?: AbortSignal }): Promise<string | undefined>;
    dispose?(): Promise<void>;
  };
}

export interface CardWorkbench {
  importForWorkingSet(request: UniversalImportRequest, options?: { signal?: AbortSignal }): Promise<WorkingSetImportResult>;
  autocompleteCards(query: string, options?: { signal?: AbortSignal }): Promise<readonly string[]>;
  searchCardIdentities(query: string, options?: { signal?: AbortSignal }): Promise<readonly CardIdentity[]>;
  getIdentityDetails(identityId: string, options?: { signal?: AbortSignal }): Promise<CardIdentity & { readonly layout?: string; readonly relatedCards: ScryfallCard["relatedCards"] }>;
  resolveWorkingCards(cards: readonly WorkingCard[], options?: { signal?: AbortSignal }): Promise<ResolveWorkingCardsResult>;
  confirmWorkingCardIdentity(card: WorkingCard, scryfallId: string, options?: { signal?: AbortSignal }): Promise<WorkingCard>;
  keepWorkingCardCustom(card: WorkingCard): WorkingCard;
  listArtworkCandidates(identityId: string, faceId: CardFaceSide, source: ArtworkCatalogSource, options?: { mpcReferences?: readonly WorkingCardMpcReference[]; signal?: AbortSignal }): Promise<readonly ArtworkCandidate[]>;
  getArtworkCandidate(candidateId: string, options?: { mpcReferences?: readonly WorkingCardMpcReference[] }): Promise<ArtworkCandidate | undefined>;
  getArtworkPreview(candidateId: string, signal?: AbortSignal): Promise<ArtworkPreview | undefined>;
  getArtworkOriginal(candidateId: string, signal?: AbortSignal): ReturnType<ArtworkCatalog["getOriginal"]>;
  selectArtwork(card: WorkingCard, faceId: CardFaceSide, candidate: ArtworkCandidate): WorkingCard;
  getProviderHealth(): Readonly<Record<string, ProviderHealth>>;
  close(): Promise<void>;
}

function fileBaseName(value?: string): string | undefined {
  if (!value) return undefined;
  const name = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, "").trim();
  return name || undefined;
}

function safeReport(report: ImportReport): SafeImportReport {
  const safeMessage = (message: string) => message
    .replace(/[A-Za-z]:[\\/][^\s,;]+/g, "[caminho]")
    .replace(/(^|[\s,(])(?:\.\.?[\\/]|[^\s,;]+[\\/])[^\s,;]+/g, "$1[asset]")
    .slice(0, 500);
  const issue = (item: ImportReport["warnings"][number]): SafeImportIssue => ({
    code: item.code,
    message: safeMessage(item.message),
    ...(fileBaseName(item.sourceFilename) ? { filename: fileBaseName(item.sourceFilename) } : {}),
    ...(item.line !== undefined ? { line: item.line } : {}),
    ...(item.field ? { field: item.field } : {}),
  });
  return {
    summary: report.summary,
    selectedImporters: report.selectedImporters.map((item) => ({ ...item })),
    warnings: report.warnings.map(issue),
    errors: report.errors.map(issue),
    pairings: report.pairings.map(({ frontAssetId, backAssetId, confidence, reason }) => ({ frontAssetId, backAssetId, confidence, reason, accepted: false })),
  };
}

function listImportedAssets(entries: readonly ImportedEntry[]): readonly ImportedAsset[] {
  const byId = new Map<string, ImportedAsset>();
  for (const entry of entries) {
    for (const asset of [entry.asset, entry.cardbackAsset, entry.front?.asset, entry.back?.asset, ...(entry.faces ?? []).map((face) => face.asset)]) {
      if (asset) byId.set(asset.id, asset);
    }
  }
  return [...byId.values()];
}

function identityFromCard(card: ScryfallCard, method: CardIdentity["resolutionMethod"], confidence = 1): CardIdentity {
  return {
    id: card.oracleId ? `scryfall:oracle:${card.oracleId}` : `scryfall:card:${card.id}`,
    provider: "scryfall",
    name: card.name,
    scryfallId: card.id,
    ...(card.oracleId ? { oracleId: card.oracleId } : {}),
    ...(card.setCode ? { setCode: card.setCode } : {}),
    ...(card.collectorNumber ? { collectorNumber: card.collectorNumber } : {}),
    ...(card.lang ? { lang: card.lang } : {}),
    resolutionMethod: method,
    confidence,
    metadata: {
      layout: card.layout,
      digital: Boolean(card.digital),
      promo: Boolean(card.promo),
      fullArt: Boolean(card.fullArt),
      imageStatus: card.imageStatus,
      faces: card.faces.map((face) => ({ name: face.name })),
      relatedCards: card.relatedCards,
      relatedUris: card.relatedUris,
    },
  };
}

function identityKey(identityId: string): string {
  return `card-identity:${identityId}`;
}

function resolutionKey(card: WorkingCard): string {
  const query = {
    hints: card.identityHints,
    filename: card.importSource.filename,
    imageIds: card.localArtworkIds,
  };
  return `card-resolution:${createHash("sha256").update(JSON.stringify(query)).digest("hex")}`;
}

function storeIdentity(cache: ArtworkMetadataCache, identity: CardIdentity): void {
  cache.putMetadata(identityKey(identity.id), identity, Date.now() + METADATA_TTL_MS);
}

function getIdentity(cache: ArtworkMetadataCache, identityId: string): CardIdentity | undefined {
  return cache.getMetadata<CardIdentity>(identityKey(identityId));
}

function applyIdentityFaces(card: WorkingCard, identity: CardIdentity): WorkingCard {
  const identityFaces = Array.isArray(identity.metadata?.faces)
    ? identity.metadata.faces.flatMap((item): Array<{ name?: string }> => {
      if (!item || typeof item !== "object") return [];
      const name = (item as { name?: unknown }).name;
      return name === undefined || typeof name === "string" ? [{ ...(typeof name === "string" ? { name } : {}) }] : [];
    })
    : [];
  if (identityFaces.length < 2) return card;
  const faces: WorkingCard["faces"][number][] = (["front", "back"] as const).map((side, index) => {
    const existing = card.faces.find((face) => face.side === side);
    return {
      ...(existing ?? { id: side, side }),
      ...(identityFaces[index].name ? { name: identityFaces[index].name } : existing?.name ? { name: existing.name } : {}),
    };
  });
  return { ...card, faces };
}

function remapImportedIds(card: WorkingCard, uploadByImportId: ReadonlyMap<string, ArtworkCandidate>): WorkingCard {
  const remapId = (id: string | undefined) => id ? uploadByImportId.get(id)?.id ?? id : undefined;
  const selectedArtworkByFace: WorkingCard["selectedArtworkByFace"] = Object.fromEntries(
    Object.entries(card.selectedArtworkByFace).map(([side, selection]) => {
      if (!selection) return [side, undefined];
      const mapped = uploadByImportId.get(selection.candidateId);
      return [side, mapped ? { ...selection, candidateId: mapped.id, providerAssetId: mapped.providerAssetId } : selection];
    }),
  );
  return {
    ...card,
    importSource: { ...card.importSource, ...(fileBaseName(card.importSource.filename) ? { filename: fileBaseName(card.importSource.filename) } : {}) },
    faces: card.faces.map((face) => ({ ...face, ...(remapId(face.importedAssetId) ? { importedAssetId: remapId(face.importedAssetId) } : {}) })),
    selectedArtworkByFace,
    localArtworkIds: [...new Set(card.localArtworkIds.map((id) => uploadByImportId.get(id)?.id ?? id))],
    faceAssociations: card.faceAssociations.map((association) => ({
      ...association,
      ...(remapId(association.frontAssetId) ? { frontAssetId: remapId(association.frontAssetId) } : {}),
      ...(remapId(association.backAssetId) ? { backAssetId: remapId(association.backAssetId) } : {}),
    })),
    // Importer metadata may contain source paths, raw text, or other private values.
    metadata: undefined,
  };
}

function identityFromResolutionCandidate(candidate: IdentityResolutionCandidate): CardIdentity {
  return candidate.identity;
}

export async function createCardWorkbench(options: CardWorkbenchOptions = {}): Promise<CardWorkbench> {
  const dataDirectory = options.dataDirectory ?? process.env.TCGPRINT_DATA_DIR ?? process.cwd();
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const paths = appDataPaths(dataDirectory);
  mkdirSync(paths.rootDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(paths.originalsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(paths.thumbnailsDirectory, { recursive: true, mode: 0o700 });
  const database = openArtworkDatabase(paths.databaseFile);
  const repository = new ArtworkRepository(database);
  const originals = new ArtworkOriginalStore(paths.originalsDirectory, repository, { maximumBytes: options.maxUploadBytes ?? MAX_UPLOAD_BYTES });
  const thumbnails = new ArtworkThumbnailStore(paths.thumbnailsDirectory, repository);
  const metadata = new ArtworkMetadataCache(repository);
  const client = new ScryfallClient({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    userAgent: "TCGPrint/0.1.0 (card identity and artwork workbench)",
  });
  const local = new LocalArtworkProvider(originals, thumbnails, repository);
  const scryfall = new ScryfallArtworkProvider(client, originals, thumbnails, metadata, repository);
  const mpc = new MpcReferenceArtworkProvider();
  const catalog = new ArtworkCatalog([scryfall, local, mpc]);
  const resolver = new IdentityResolver(client);
  const recognizer = options.recognizer ?? new TesseractOcrRecognizer({ cachePath: paths.rootDirectory });
  const resolutionCache = new Map<string, { identity: CardIdentity | null; resolution: WorkingCard["identityResolution"] }>();
  let closePromise: Promise<void> | undefined;

  return {
    async importForWorkingSet(request, callOptions = {}) {
      if ((request.files?.length ?? 0) > MAX_UPLOADS) throw new ImportFailureError(`At most ${MAX_UPLOADS} files may be imported at once.`, "INPUT_TOO_LARGE");
      let totalBytes = 0;
      for (const file of request.files ?? []) {
        totalBytes += file.bytes.byteLength;
        if (file.bytes.byteLength > (options.maxUploadBytes ?? MAX_UPLOAD_BYTES) || totalBytes > 100 * 1024 * 1024) {
          throw new ImportFailureError("Imported files exceed the server upload size limit.", "INPUT_TOO_LARGE");
        }
      }
      const sanitizedRequest: UniversalImportRequest = {
        ...(request.files ? { files: request.files.map((file) => {
          let sourcePath: string | undefined;
          try { sourcePath = sanitizeRelativeImportPath(file.sourcePath); }
          catch { throw new ImportFailureError("Imported file path must be a safe relative path of at most 1024 characters.", "INVALID_SOURCE_PATH"); }
          return {
            filename: fileBaseName(file.filename) ?? "upload",
            bytes: file.bytes,
            ...(sourcePath ? { sourcePath, kind: "folder-file" as const } : {}),
          };
        }) } : {}),
        ...(request.text !== undefined ? { text: request.text } : {}),
        ...(request.textFilename ? { textFilename: fileBaseName(request.textFilename) ?? "decklist.txt" } : {}),
        ...(request.selections ? { selections: request.selections } : {}),
        ...(request.csvMappings ? { csvMappings: request.csvMappings } : {}),
        ...(request.jsonMappings ? { jsonMappings: request.jsonMappings } : {}),
      };
      const result = await importFiles(sanitizedRequest, { signal: callOptions.signal });
      const uploadByImportId = new Map<string, ArtworkCandidate>();
      for (const asset of listImportedAssets(result.entries)) {
        if (!asset.originalBytes) continue;
        const filename = fileBaseName(asset.sourceFilename);
        const candidate = await local.registerUpload(asset.originalBytes, {
          ...(filename ? { originalFilename: filename } : {}),
          ...(asset.sourcePath ? { sourcePath: asset.sourcePath } : {}),
          importMetadata: { sourceId: asset.sourceId, originalFormat: asset.originalFormat },
        });
        uploadByImportId.set(asset.id, candidate);
      }
      const workingCards = createWorkingSet(result).map((card) => remapImportedIds(card, uploadByImportId));
      return { workingCards, report: safeReport(result.report), providerHealth: catalog.getProviderHealth() };
    },

    async autocompleteCards(query, callOptions = {}) {
      const normalized = query.trim().slice(0, 100);
      if (normalized.length < 2) return [];
      const key = `scryfall:autocomplete:${normalized.toLocaleLowerCase("en-US")}`;
      const cached = metadata.getMetadata<readonly string[]>(key);
      if (cached) return cached;
      const result = await client.autocomplete(normalized, { signal: callOptions.signal });
      metadata.putMetadata(key, result, Date.now() + 60 * 60 * 1000);
      return result;
    },

    async searchCardIdentities(query, callOptions = {}) {
      const normalized = query.trim().slice(0, 100);
      if (normalized.length < 2) return [];
      const cards = await client.searchCards(`name:"${normalized.replaceAll('"', "\\\"")}"`, { signal: callOptions.signal });
      const identities = new Map<string, CardIdentity>();
      for (const card of cards.slice(0, 30)) {
        const identity = identityFromCard(card, "fuzzy", 0.95);
        identities.set(identity.id, identity);
        storeIdentity(metadata, identity);
        metadata.putMetadata(`scryfall:identity-card:${identity.id}`, card, Date.now() + METADATA_TTL_MS);
      }
      return [...identities.values()];
    },

    async getIdentityDetails(identityId, callOptions = {}) {
      const identity = getIdentity(metadata, identityId);
      if (!identity) throw new ScryfallError("not-found", "Card identity is not available in the local identity cache.", { status: 404 });
      let card = metadata.getMetadata<ScryfallCard>(`scryfall:identity-card:${identityId}`);
      if (!card && identity.scryfallId) {
        try {
          card = await client.lookupById(identity.scryfallId, { signal: callOptions.signal });
          metadata.putMetadata(`scryfall:identity-card:${identityId}`, card, Date.now() + METADATA_TTL_MS);
        } catch (error) {
          if (callOptions.signal?.aborted || (error instanceof ScryfallError && error.kind === "aborted")) throw error;
          if (error instanceof ScryfallError) catalog.markProviderDegraded("scryfall", error);
          // The resolved normalized identity and related card metadata remain useful offline.
        }
      }
      const cachedLayout = typeof identity.metadata?.layout === "string" ? identity.metadata.layout : undefined;
      const cachedRelated = Array.isArray(identity.metadata?.relatedCards) ? identity.metadata.relatedCards as ScryfallCard["relatedCards"] : [];
      return { ...identity, ...(card ? { layout: card.layout, relatedCards: card.relatedCards } : { ...(cachedLayout ? { layout: cachedLayout } : {}), relatedCards: cachedRelated }) };
    },

    async resolveWorkingCards(cards, callOptions = {}) {
      const resolved: WorkingCard[] = [];
      for (const card of cards) {
        if (callOptions.signal?.aborted) throw new ScryfallError("aborted", "The Scryfall request was cancelled.");
        if (card.identityResolution.confirmed) { resolved.push(card); continue; }
        const key = resolutionKey(card);
        let resolution = resolutionCache.get(key);
        if (!resolution) {
          const stored = metadata.getMetadata<{ identity: CardIdentity | null; resolution: WorkingCard["identityResolution"] }>(key);
          resolution = stored;
        }
        let next: WorkingCard;
        try {
          if (resolution) next = { ...card, identity: resolution.identity, identityResolution: resolution.resolution };
          else {
            const selected = card.selectedArtworkByFace.front;
            const original = selected?.source === "upload" ? await local.getOriginal(selected.candidateId).then((item) => item.bytes).catch(() => undefined) : undefined;
            next = await resolver.resolve(card, {
              filename: card.importSource.filename,
              ...(original ? { imageBytes: original } : {}),
              signal: callOptions.signal,
              recognizer,
            });
            resolution = { identity: next.identity, resolution: next.identityResolution };
            resolutionCache.set(key, resolution);
            metadata.putMetadata(key, resolution, Date.now() + METADATA_TTL_MS);
          }
          const resolvedIdentity = next.identity;
          if (resolvedIdentity) {
            next = applyIdentityFaces(next, resolvedIdentity);
            storeIdentity(metadata, resolvedIdentity);
            const candidates = await catalog.search(resolvedIdentity, { source: "scryfall", signal: callOptions.signal });
            for (const side of ["front", "back"] as const) {
              const current = next.selectedArtworkByFace[side];
              if (current?.source === "upload" && current.identityId !== resolvedIdentity.id) {
                const linked = { ...current, identityId: resolvedIdentity.id } satisfies SelectedArtwork;
                next = updateSelectedArtwork(next, side, linked);
                local.linkUpload(resolvedIdentity.id, current.candidateId, side);
              }
              const importedFace = next.faces.find((face) => face.side === side);
              if (importedFace?.importedAssetId?.startsWith("upload:")) local.linkUpload(resolvedIdentity.id, importedFace.importedAssetId, side);
            }
            next = selectDefaultArtwork(next, candidates);
          }
          resolved.push(next);
        } catch (error) {
          if (error instanceof ScryfallError && error.kind === "aborted") throw error;
          if (error instanceof ScryfallError) catalog.markProviderDegraded("scryfall", error);
          resolved.push({ ...card, identityResolution: { ...card.identityResolution, status: card.identity ? "resolved" : "unresolved" } });
        }
      }
      return { workingCards: resolved, providerHealth: catalog.getProviderHealth() };
    },

    async confirmWorkingCardIdentity(card, scryfallId, callOptions = {}) {
      const scryfallCard = await client.lookupById(scryfallId, { signal: callOptions.signal });
      const identity = identityFromCard(scryfallCard, "manual", 1);
      storeIdentity(metadata, identity);
      metadata.putMetadata(`scryfall:identity-card:${identity.id}`, scryfallCard, Date.now() + METADATA_TTL_MS);
      let next = confirmIdentity(card, identity);
      next = applyIdentityFaces(next, identity);
      const candidates = await catalog.search(identity, { source: "scryfall", signal: callOptions.signal });
      for (const side of ["front", "back"] as const) {
        const selected = next.selectedArtworkByFace[side];
        if (selected?.source === "upload") {
          const linked = { ...selected, identityId: identity.id } satisfies SelectedArtwork;
          next = updateSelectedArtwork(next, side, linked);
          local.linkUpload(identity.id, selected.candidateId, side);
        }
        const importedFace = next.faces.find((face) => face.side === side);
        if (importedFace?.importedAssetId?.startsWith("upload:")) local.linkUpload(identity.id, importedFace.importedAssetId, side);
      }
      return selectDefaultArtwork(next, candidates);
    },

    keepWorkingCardCustom(card) { return keepCustom(card); },

    async listArtworkCandidates(identityId, faceId, source, callOptions = {}) {
      const cachedIdentity = getIdentity(metadata, identityId);
      const oracleId = /^scryfall:oracle:(.+)$/.exec(identityId)?.[1];
      const scryfallId = /^scryfall:card:(.+)$/.exec(identityId)?.[1];
      const identity: CardIdentity = cachedIdentity ?? (identityId === "custom:artwork-picker"
        ? { id: identityId, provider: "local", name: "Local artwork library", resolutionMethod: "custom", confidence: 0 }
        : {
          id: identityId,
          provider: "scryfall",
          name: identityId,
          ...(oracleId ? { oracleId } : {}),
          ...(scryfallId ? { scryfallId } : {}),
          resolutionMethod: "manual",
          confidence: 1,
        });
      if (identity.provider === "local" && source === "scryfall") return [];
      if (identity.id === "custom:artwork-picker" && source === "all") {
        const [uploads, references] = await Promise.all([
          catalog.search(identity, { source: "upload", faceId, signal: callOptions.signal }),
          catalog.search(identity, { source: "mpc", faceId, ...(callOptions.mpcReferences ? { mpcReferences: callOptions.mpcReferences } : {}), signal: callOptions.signal }),
        ]);
        return [...uploads, ...references];
      }
      return catalog.search(identity, { source, faceId, ...(callOptions.mpcReferences ? { mpcReferences: callOptions.mpcReferences } : {}), signal: callOptions.signal });
    },

    async getArtworkCandidate(candidateId, callOptions = {}) {
      const candidate = await catalog.getCandidate(candidateId);
      if (candidate || !candidateId.startsWith("mpc:") || !callOptions.mpcReferences?.length) return candidate;
      const syntheticIdentity: CardIdentity = { id: "local:mpc-reference", provider: "local", name: "MPC Autofill reference", resolutionMethod: "custom", confidence: 0 };
      await mpc.searchArtwork(syntheticIdentity, { mpcReferences: callOptions.mpcReferences });
      return mpc.getCandidate(candidateId);
    },
    getArtworkPreview(candidateId, signal) { return catalog.getPreview(candidateId, signal); },
    getArtworkOriginal(candidateId, signal) { return catalog.getOriginal(candidateId, signal); },
    selectArtwork(card, faceId, candidate) {
      const selection: SelectedArtwork = {
        candidateId: candidate.id,
        source: candidate.source,
        identityId: card.identity?.id ?? null,
        faceId,
        ...(candidate.providerAssetId ? { providerAssetId: candidate.providerAssetId } : {}),
        ...(candidate.selectedArtworkId ? { selectedArtworkId: candidate.selectedArtworkId } : {}),
        selectionPolicy: "user-selected",
      };
      if (candidate.source === "upload" && card.identity) local.linkUpload(card.identity.id, candidate.id, faceId);
      return updateSelectedArtwork(card, faceId, selection);
    },
    getProviderHealth() { return catalog.getProviderHealth(); },
    close() {
      closePromise ??= (async () => {
        try { await recognizer.dispose?.(); }
        finally { database.close(); }
      })();
      return closePromise;
    },
  };
}

let defaultWorkbench: Promise<CardWorkbench> | undefined;

export function getCardWorkbench(): Promise<CardWorkbench> {
  defaultWorkbench ??= createCardWorkbench();
  return defaultWorkbench;
}

export async function resetCardWorkbenchForTests(): Promise<void> {
  const pending = defaultWorkbench;
  defaultWorkbench = undefined;
  const workbench = await pending;
  await workbench?.close();
}

export function artworkQualityFromCandidate(candidate: ArtworkCandidate): ReturnType<typeof artworkResolutionQuality> {
  return artworkResolutionQuality(candidate.effectiveDpi ?? (candidate.widthPx && candidate.heightPx ? calculateEffectiveDpi(candidate.widthPx, candidate.heightPx) : undefined));
}
