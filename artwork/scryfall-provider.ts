import sharp from "sharp";
import { ScryfallClient } from "../providers/scryfall/client";
import type { ScryfallCard, ScryfallFace } from "../providers/scryfall/types";
import type { ArtworkCandidate, CardFaceSide, CardIdentity } from "../core/cards/types";
import type { ArtworkMetadataCache } from "./storage/metadata-cache";
import type { ArtworkOriginalStore } from "./storage/original-store";
import type { ArtworkRepository } from "./storage/repository";
import type { ArtworkThumbnailStore } from "./storage/thumbnail-store";
import { calculateEffectiveDpi } from "./effective-dpi";
import type { ArtworkPreview, ArtworkProvider, ArtworkSearchOptions, ProviderHealth } from "./types";
import type { ArtworkOriginal, ArtworkOriginalRecord } from "./storage/types";
import { ArtworkStorageError } from "./storage/types";

const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface ScryfallFaceArtwork {
  readonly id: string;
  readonly name?: string;
  readonly side: CardFaceSide;
  readonly face?: ScryfallFace;
  readonly uris: ScryfallFace["imageUris"];
}

function artworkFaces(card: ScryfallCard): readonly ScryfallFaceArtwork[] {
  if (card.faces.length > 0) {
    return card.faces.map((face, index) => ({ id: index === 0 ? "front" : "back", name: face.name, side: index === 0 ? "front" : "back", face, uris: face.imageUris ?? card.imageUris }));
  }
  return [{ id: "front", side: "front", uris: card.imageUris }];
}

function originalUri(uris: ScryfallFace["imageUris"]): string | undefined {
  return uris?.png ?? uris?.large;
}

function previewUri(uris: ScryfallFace["imageUris"]): string | undefined {
  return uris?.small ?? uris?.normal ?? uris?.artCrop ?? uris?.large ?? uris?.png;
}

function candidateId(scryfallId: string, side: CardFaceSide): string {
  return `scryfall:${scryfallId}:${side}`;
}

function isCandidate(value: unknown): value is ArtworkCandidate {
  return Boolean(value && typeof value === "object" && typeof (value as ArtworkCandidate).id === "string" && (value as ArtworkCandidate).source === "scryfall");
}

export class ScryfallArtworkProvider implements ArtworkProvider {
  readonly source = "scryfall" as const;
  private readonly client: ScryfallClient;
  private readonly originals: ArtworkOriginalStore;
  private readonly thumbnails: ArtworkThumbnailStore;
  private readonly metadata: ArtworkMetadataCache;
  private readonly repository: ArtworkRepository;
  private health: ProviderHealth = { available: true, degraded: false };

  constructor(client: ScryfallClient, originals: ArtworkOriginalStore, thumbnails: ArtworkThumbnailStore, metadata: ArtworkMetadataCache, repository: ArtworkRepository) {
    this.client = client;
    this.originals = originals;
    this.thumbnails = thumbnails;
    this.metadata = metadata;
    this.repository = repository;
  }

  async searchArtwork(identity: CardIdentity, options: ArtworkSearchOptions = {}): Promise<readonly ArtworkCandidate[]> {
    const cacheKey = `scryfall:printings:${identity.oracleId ?? identity.scryfallId ?? identity.name.toLowerCase()}`;
    let cards = this.metadata.getMetadata<readonly ScryfallCard[]>(cacheKey);
    if (!cards) {
      try {
        if (identity.oracleId) {
          cards = await this.client.listPrintings(identity.oracleId, { signal: options.signal });
        } else {
          const requested = identity.scryfallId
            ? await this.client.lookupById(identity.scryfallId, { signal: options.signal })
            : await this.client.lookupByName(identity.name, "exact", { signal: options.signal });
          cards = requested.oracleId ? await this.client.listPrintings(requested.oracleId, { signal: options.signal }) : [requested];
        }
        this.metadata.putMetadata(cacheKey, cards, Date.now() + METADATA_TTL_MS);
        this.health = { available: true, degraded: false };
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError") || (error && typeof error === "object" && (error as { kind?: unknown }).kind === "aborted")) throw error;
        const cached = identity.oracleId ? this.repository.listOriginalsByOracleId(identity.oracleId) : identity.scryfallId ? [this.repository.findOriginalByScryfallId(identity.scryfallId)].filter((item): item is ArtworkOriginalRecord => Boolean(item)) : [];
        const candidates = cached.flatMap((record) => {
          const candidate = this.candidateFromStoredOriginal(record, identity);
          return candidate ? [candidate] : [];
        });
        if (!candidates.length) throw error;
        this.health = { available: true, degraded: true, message: error instanceof Error ? error.message.slice(0, 300) : "Scryfall is unavailable; using cached originals." };
        return candidates.filter((candidate) => !options.faceId || candidate.faceId === options.faceId);
      }
    }
    return cards.flatMap((card) => this.candidatesFromPrinting(identity, card, options.faceId));
  }

  /** Builds lazy artwork metadata from one already-resolved printing; it performs no API or asset requests. */
  candidatesFromPrinting(identity: CardIdentity, card: ScryfallCard, faceId?: CardFaceSide): readonly ArtworkCandidate[] {
    const candidates: ArtworkCandidate[] = [];
    for (const face of artworkFaces(card)) {
      if (faceId && faceId !== face.side) continue;
      const selectedOriginalUri = originalUri(face.uris);
      const selectedPreviewUri = previewUri(face.uris);
      if (!selectedOriginalUri && !selectedPreviewUri) continue;
      let candidate: ArtworkCandidate = {
        id: candidateId(card.id, face.side),
        source: "scryfall",
        identityId: identity.id,
        faceId: face.side,
        ...(face.name ? { faceName: face.name } : {}),
        ...(selectedPreviewUri ? { previewUri: selectedPreviewUri } : {}),
        ...(selectedOriginalUri ? { originalUri: selectedOriginalUri } : {}),
        providerAssetId: card.id,
        scryfallId: card.id,
        selectedArtworkId: card.id,
        ...(card.oracleId ? { oracleId: card.oracleId } : {}),
        ...(card.setCode ? { setCode: card.setCode } : {}),
        ...(card.collectorNumber ? { collectorNumber: card.collectorNumber } : {}),
        ...(card.lang ? { language: card.lang } : {}),
        ...(card.releasedAt ? { releasedAt: card.releasedAt } : {}),
        originalAvailable: Boolean(selectedOriginalUri),
        metadata: { layout: card.layout, digital: Boolean(card.digital), promo: Boolean(card.promo), fullArt: Boolean(card.fullArt), imageStatus: card.imageStatus, borderColor: card.borderColor, selectedArtworkId: card.id },
      };
      const stored = this.repository.findOriginalByScryfallId(card.id);
      if (stored) candidate = this.enrichWithStoredOriginal(candidate, stored);
      this.metadata.putMetadata(`scryfall:candidate:${candidate.id}`, candidate, Date.now() + CANDIDATE_TTL_MS);
      candidates.push(candidate);
    }
    return candidates;
  }

  async getCandidate(id: string): Promise<ArtworkCandidate | undefined> {
    if (!id.startsWith("scryfall:")) return undefined;
    const cached = this.metadata.getMetadata<unknown>(`scryfall:candidate:${id}`);
    if (isCandidate(cached)) {
      const stored = cached.scryfallId ? this.repository.findOriginalByScryfallId(cached.scryfallId) : undefined;
      return stored ? this.enrichWithStoredOriginal(cached, stored) : cached;
    }
    const match = /^scryfall:([a-f0-9-]{36}):(front|back)$/.exec(id);
    if (!match) return undefined;
    const original = this.repository.findOriginalByScryfallId(match[1]);
    if (!original) return undefined;
    const candidate = this.candidateFromStoredOriginal(original, {
      id: original.provenance.find((item) => item.scryfallId === match[1])?.oracleId ? `scryfall:oracle:${original.provenance.find((item) => item.scryfallId === match[1])!.oracleId}` : `scryfall:card:${match[1]}`,
      provider: "scryfall",
      name: "Cached Scryfall card",
      resolutionMethod: "scryfall-id",
      confidence: 1,
    }, match[1]);
    if (candidate?.faceId !== match[2]) return undefined;
    this.metadata.putMetadata(`scryfall:candidate:${id}`, candidate, Date.now() + CANDIDATE_TTL_MS);
    return candidate;
  }

  getHealth(): ProviderHealth { return this.health; }

  async getPreview(id: string, signal?: AbortSignal): Promise<ArtworkPreview | undefined> {
    const candidate = await this.getCandidate(id);
    if (!candidate) return undefined;
    const cached = await this.thumbnails.getThumbnail(id);
    if (cached) return { candidateId: id, source: "scryfall", bytes: cached.bytes, contentType: `image/${cached.extension === "jpg" ? "jpeg" : cached.extension}`, widthPx: cached.widthPx, heightPx: cached.heightPx };
    if (!candidate.previewUri) return undefined;
    const downloaded = await this.client.downloadAsset(candidate.previewUri, { kind: "thumbnail", signal });
    const thumbnailBytes = new Uint8Array(await sharp(Buffer.from(downloaded.bytes), { failOn: "error" }).resize({ width: 300, height: 420, fit: "inside", withoutEnlargement: true }).png().toBuffer());
    const thumbnail = await this.thumbnails.putThumbnail(id, thumbnailBytes, { metadataSourceUrl: downloaded.sourceUrl });
    const stored = await this.thumbnails.getThumbnail(id);
    if (!stored) throw new Error("Scryfall thumbnail was not persisted.");
    return { candidateId: id, source: "scryfall", bytes: stored.bytes, contentType: `image/${thumbnail.extension === "jpg" ? "jpeg" : thumbnail.extension}`, widthPx: stored.widthPx, heightPx: stored.heightPx };
  }

  async getOriginal(id: string, signal?: AbortSignal): Promise<ArtworkOriginal> {
    const candidate = await this.getCandidate(id);
    if (!candidate?.originalUri || !candidate.originalAvailable) throw new ArtworkStorageError("ARTWORK_MISSING", `Scryfall candidate ${id} has no original image.`);
    const existing = this.repository.findOriginalByProviderSource("scryfall", candidate.providerAssetId ?? "", candidate.originalUri);
    const original = existing
      ? await this.originals.getOriginal(existing.artworkId)
      : await this.downloadOriginal(candidate, signal);
    this.metadata.putMetadata(`scryfall:candidate:${id}`, {
      ...candidate,
      widthPx: original.widthPx,
      heightPx: original.heightPx,
      effectiveDpi: calculateEffectiveDpi(original.widthPx, original.heightPx),
    }, Date.now() + CANDIDATE_TTL_MS);
    return original;
  }

  private async downloadOriginal(candidate: ArtworkCandidate, signal?: AbortSignal): Promise<ArtworkOriginal> {
    const downloaded = await this.client.downloadAsset(candidate.originalUri!, { kind: "original", signal });
    return this.originals.addOriginal(downloaded.bytes, {
        provider: "scryfall",
        providerAssetId: candidate.providerAssetId,
        scryfallId: candidate.scryfallId,
        oracleId: candidate.oracleId,
        sourceUrl: downloaded.sourceUrl,
        downloadedAt: new Date().toISOString(),
        contentType: downloaded.contentType,
        importMetadata: { faceId: candidate.faceId, faceName: candidate.faceName, setCode: candidate.setCode, collectorNumber: candidate.collectorNumber, language: candidate.language, releasedAt: candidate.releasedAt, ...candidate.metadata },
      });
  }

  private candidateFromStoredOriginal(record: ArtworkOriginalRecord, identity: CardIdentity, scryfallId?: string): ArtworkCandidate | undefined {
    const provenance = record.provenance.find((item) => item.provider === "scryfall" && (!scryfallId || item.scryfallId === scryfallId) && (!identity.oracleId || item.oracleId === identity.oracleId));
    const providerAssetId = provenance?.providerAssetId ?? provenance?.scryfallId;
    if (!provenance?.scryfallId || !providerAssetId) return undefined;
    const metadata = provenance.importMetadata ?? {};
    const faceId = metadata.faceId === "back" ? "back" : "front";
    const candidate: ArtworkCandidate = {
      id: candidateId(provenance.scryfallId, faceId),
      source: "scryfall",
      identityId: identity.id,
      faceId,
      ...(typeof metadata.faceName === "string" ? { faceName: metadata.faceName } : {}),
      ...(provenance.sourceUrl ? { originalUri: provenance.sourceUrl } : {}),
      providerAssetId,
      scryfallId: provenance.scryfallId,
      ...(provenance.oracleId ? { oracleId: provenance.oracleId } : {}),
      ...(typeof metadata.setCode === "string" ? { setCode: metadata.setCode } : {}),
      ...(typeof metadata.collectorNumber === "string" ? { collectorNumber: metadata.collectorNumber } : {}),
      ...(typeof metadata.language === "string" ? { language: metadata.language } : {}),
      ...(typeof metadata.releasedAt === "string" ? { releasedAt: metadata.releasedAt } : {}),
      widthPx: record.widthPx,
      heightPx: record.heightPx,
      effectiveDpi: calculateEffectiveDpi(record.widthPx, record.heightPx),
      originalAvailable: true,
      metadata: { ...Object.fromEntries(Object.entries(metadata).filter(([key, value]) => ["layout", "digital", "promo", "fullArt", "imageStatus", "borderColor"].includes(key) && (typeof value === "string" || typeof value === "boolean"))) },
    };
    return candidate;
  }

  private enrichWithStoredOriginal(candidate: ArtworkCandidate, record: ArtworkOriginalRecord): ArtworkCandidate {
    const provenance = record.provenance.find((item) => item.provider === "scryfall" && item.scryfallId === candidate.scryfallId);
    return {
      ...candidate,
      widthPx: record.widthPx,
      heightPx: record.heightPx,
      effectiveDpi: calculateEffectiveDpi(record.widthPx, record.heightPx),
      ...(provenance?.sourceUrl ? { originalUri: provenance.sourceUrl } : {}),
    };
  }
}
