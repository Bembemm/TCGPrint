import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ArtworkCandidate, CardFaceSide, CardIdentity } from "../core/cards/types";
import { ArtworkStorageError } from "./storage/types";
import type { ArtworkOriginalStore } from "./storage/original-store";
import type { ArtworkRepository } from "./storage/repository";
import type { ArtworkThumbnailStore } from "./storage/thumbnail-store";
import type { ArtworkOriginalRecord } from "./storage/types";
import { calculateEffectiveDpi } from "./effective-dpi";
import type { ArtworkPreview, ArtworkProvider, ArtworkSearchOptions } from "./types";

function uploadId(hash: string): string {
  return `upload:${hash}`;
}

function hashFromId(id: string): string {
  const hash = id.slice("upload:".length);
  if (!id.startsWith("upload:") || !/^[a-f0-9]{64}$/.test(hash)) throw new ArtworkStorageError("ARTWORK_MISSING", "Local artwork ID is invalid.");
  return hash;
}

function makeCandidate(id: string, identityId: string | null, side: CardFaceSide, original: ArtworkOriginalRecord, filename?: string): ArtworkCandidate {
  return {
    id,
    source: "upload",
    identityId,
    faceId: side,
    providerAssetId: original.artworkId,
    widthPx: original.widthPx,
    heightPx: original.heightPx,
    effectiveDpi: calculateEffectiveDpi(original.widthPx, original.heightPx),
    originalAvailable: true,
    metadata: {
      originalFilename: filename,
      originalFormat: original.format,
      contentHash: original.contentHash,
      provenanceCount: original.provenance.length,
    },
  };
}

export class LocalArtworkProvider implements ArtworkProvider {
  readonly source = "upload" as const;
  private readonly originals: ArtworkOriginalStore;
  private readonly thumbnails: ArtworkThumbnailStore;
  private readonly repository: ArtworkRepository;

  constructor(originals: ArtworkOriginalStore, thumbnails: ArtworkThumbnailStore, repository: ArtworkRepository) {
    this.originals = originals;
    this.thumbnails = thumbnails;
    this.repository = repository;
  }

  async registerUpload(bytes: Uint8Array, provenance: { originalFilename?: string; sourcePath?: string; importMetadata?: Readonly<Record<string, unknown>> }) {
    const original = await this.originals.addOriginal(bytes, { provider: "upload", ...provenance });
    return makeCandidate(uploadId(original.artworkId), null, "front", original, provenance.originalFilename);
  }

  linkUpload(identityId: string, artworkId: string, faceId: CardFaceSide): void {
    const hash = artworkId.startsWith("upload:") ? hashFromId(artworkId) : hashFromId(uploadId(artworkId));
    this.repository.linkIdentityArtwork(identityId, hash, faceId);
  }

  async searchArtwork(identity: CardIdentity, options: ArtworkSearchOptions = {}): Promise<readonly ArtworkCandidate[]> {
    const side = options.faceId ?? "front";
    const records = identity.id === "custom:artwork-picker"
      ? this.originals.listUploads()
      : this.repository.listUploadsForIdentityFace(identity.id, side);
    return records.map((record) => {
      const filename = record.provenance.find((item) => item.provider === "upload")?.originalFilename;
      return makeCandidate(uploadId(record.artworkId), identity.id, side, record, filename);
    });
  }

  async getCandidate(id: string): Promise<ArtworkCandidate | undefined> {
    let hash: string;
    try { hash = hashFromId(id); } catch { return undefined; }
    const original = this.repository.getOriginal(hash);
    if (!original) return undefined;
    const filename = original.provenance.find((item) => item.provider === "upload")?.originalFilename;
    return makeCandidate(id, null, "front", original, filename);
  }

  async getOriginal(id: string) {
    return this.originals.getOriginal(hashFromId(id));
  }

  async getPreview(id: string): Promise<ArtworkPreview | undefined> {
    const cached = await this.thumbnails.getThumbnail(id);
    if (cached) return { candidateId: id, source: "upload", bytes: cached.bytes, contentType: `image/${cached.extension === "jpg" ? "jpeg" : cached.extension}`, widthPx: cached.widthPx, heightPx: cached.heightPx };
    const original = await this.getOriginal(id);
    const bytes = new Uint8Array(await sharp(Buffer.from(original.bytes), { failOn: "error" }).resize({ width: 300, height: 420, fit: "inside", withoutEnlargement: true }).png().toBuffer());
    const thumb = await this.thumbnails.putThumbnail(id, bytes, { sourceArtworkId: original.artworkId });
    const stored = await this.thumbnails.getThumbnail(id);
    if (!stored) throw new Error("Local artwork thumbnail was not persisted.");
    return { candidateId: id, source: "upload", bytes: stored.bytes, contentType: `image/${thumb.extension === "jpg" ? "jpeg" : thumb.extension}`, widthPx: thumb.widthPx, heightPx: thumb.heightPx };
  }
}
