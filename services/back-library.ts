import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ArtworkOriginal } from "../artwork/storage/types";
import { ArtworkStorageError } from "../artwork/storage/types";
import { validateImageBytes } from "../artwork/storage/image-validation";
import type { ArtworkOriginalStore } from "../artwork/storage/original-store";
import type { ArtworkDisplayAsset, ArtworkDisplayStore } from "../artwork/storage/display-store";
import { isArtworkDisplayWidthBucket, type ArtworkDisplayWidthBucket } from "../artwork/display-buckets";
import type { ArtworkThumbnailStore } from "../artwork/storage/thumbnail-store";
import type { BackLibraryAssetReference } from "../core/cards/types";
import { BackLibraryRepository, type BackLibraryAssetRecord } from "../persistence/back-library/repository";

export const MAX_BACK_LIBRARY_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_BACK_DIMENSION_PIXELS = 12_000;
const MAX_BACK_PIXELS = 100_000_000;

export type BackLibraryErrorCode =
  | "BACK_INVALID_IMAGE"
  | "BACK_TOO_LARGE"
  | "BACK_DIMENSIONS_EXCEEDED"
  | "BACK_INVALID_FILENAME"
  | "BACK_INVALID_METADATA"
  | "BACK_ASSET_NOT_FOUND"
  | "BACK_ORIGINAL_UNAVAILABLE"
  | "BACK_REFERENCE_MISMATCH";

export class BackLibraryError extends Error {
  constructor(readonly code: BackLibraryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BackLibraryError";
  }
}

export interface AddBackLibraryAssetInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}

function safeName(filename: string): string {
  if (typeof filename !== "string" || filename.length > 1024) throw new BackLibraryError("BACK_INVALID_FILENAME", "Back filename must be a bounded string.");
  const basename = filename.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!basename) throw new BackLibraryError("BACK_INVALID_FILENAME", "Back filename must contain a visible name.");
  return basename.slice(0, 120);
}

function safeMetadata(value: Readonly<Record<string, unknown>> | undefined): BackLibraryAssetRecord["metadata"] {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 20) {
    throw new BackLibraryError("BACK_INVALID_METADATA", "Back metadata must be a flat object with at most 20 fields.");
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[\p{L}\p{N}_ -]{1,40}$/u.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new BackLibraryError("BACK_INVALID_METADATA", "Back metadata contains an invalid field name.");
    }
    if (item === null || typeof item === "boolean") result[key] = item;
    else if (typeof item === "string" && item.length <= 240 && !/[\u0000-\u001f]/.test(item)) result[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else throw new BackLibraryError("BACK_INVALID_METADATA", "Back metadata values must be short strings, finite numbers, booleans, or null.");
  }
  return Object.freeze(result);
}

function mappedStorageError(error: unknown): BackLibraryError {
  if (error instanceof BackLibraryError) return error;
  if (error instanceof ArtworkStorageError) {
    if (error.code === "ARTWORK_TOO_LARGE") return new BackLibraryError("BACK_TOO_LARGE", "Back image exceeds the upload byte limit.", error);
    if (error.code === "ARTWORK_INVALID_IMAGE" || error.code === "ARTWORK_UNSUPPORTED_FORMAT") return new BackLibraryError("BACK_INVALID_IMAGE", "Back upload must be a valid JPEG or PNG image.", error);
    return new BackLibraryError("BACK_ORIGINAL_UNAVAILABLE", "Validated Back Library original is unavailable.", error);
  }
  return new BackLibraryError("BACK_INVALID_IMAGE", "Back upload could not be validated.", error);
}

/** Validated originals and immutable metadata; all consumers resolve bytes by assetId and SHA-256. */
export class BackLibraryService {
  private readonly repository: BackLibraryRepository;
  private readonly originals: ArtworkOriginalStore;
  private readonly maximumBytes: number;
  private readonly maximumDimensionPixels: number;
  private readonly maximumPixels: number;
  private readonly thumbnails: ArtworkThumbnailStore | undefined;
  private readonly displayStore: ArtworkDisplayStore | undefined;
  private readonly previewCache = new Map<string, { readonly bytes: Uint8Array; readonly contentType: string; readonly widthPx: number; readonly heightPx: number }>();

  constructor(
    repository: BackLibraryRepository,
    originals: ArtworkOriginalStore,
    options: { maximumBytes?: number; maximumDimensionPixels?: number; maximumPixels?: number } = {},
    thumbnails?: ArtworkThumbnailStore,
    displayStore?: ArtworkDisplayStore,
  ) {
    this.repository = repository;
    this.originals = originals;
    this.thumbnails = thumbnails;
    this.displayStore = displayStore;
    this.maximumBytes = options.maximumBytes ?? MAX_BACK_LIBRARY_UPLOAD_BYTES;
    this.maximumDimensionPixels = options.maximumDimensionPixels ?? MAX_BACK_DIMENSION_PIXELS;
    this.maximumPixels = options.maximumPixels ?? MAX_BACK_PIXELS;
  }

  async add(input: AddBackLibraryAssetInput): Promise<BackLibraryAssetRecord> {
    const name = safeName(input.filename);
    const metadata = safeMetadata(input.metadata);
    const bytes = new Uint8Array(input.bytes);
    if (!bytes.byteLength) throw new BackLibraryError("BACK_INVALID_IMAGE", "Back image is empty.");
    if (bytes.byteLength > this.maximumBytes) throw new BackLibraryError("BACK_TOO_LARGE", `Back image exceeds ${this.maximumBytes} bytes.`);
    let image;
    try { image = await validateImageBytes(bytes, this.maximumBytes); } catch (error) { throw mappedStorageError(error); }
    if (image.format !== "jpeg" && image.format !== "png") throw new BackLibraryError("BACK_INVALID_IMAGE", "Back Library supports JPEG and PNG originals only.");
    if (image.widthPx > this.maximumDimensionPixels || image.heightPx > this.maximumDimensionPixels || image.widthPx * image.heightPx > this.maximumPixels) {
      throw new BackLibraryError("BACK_DIMENSIONS_EXCEEDED", "Back image dimensions exceed the Back Library limits.");
    }
    const sha256 = digest(bytes);
    let original: ArtworkOriginal;
    try {
      original = await this.originals.addOriginal(bytes, { provider: "back-library", originalFilename: name, contentType: image.format === "jpeg" ? "image/jpeg" : "image/png" });
    } catch (error) { throw mappedStorageError(error); }
    if (original.contentHash !== sha256 || original.format !== image.format || original.widthPx !== image.widthPx || original.heightPx !== image.heightPx) {
      throw new BackLibraryError("BACK_ORIGINAL_UNAVAILABLE", "Stored Back Library original does not match its validated upload.");
    }
    const assetId = `back:${sha256}`;
    try {
      const record = this.repository.add({ assetId, sha256, format: image.format, name, widthPx: image.widthPx, heightPx: image.heightPx, metadata });
      if (this.thumbnails) {
        const thumbnail = sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { limitInputPixels: this.maximumPixels })
          .rotate().resize({ width: 640, height: 896, fit: "inside", withoutEnlargement: true });
        const output = image.format === "png"
          ? await thumbnail.png({ compressionLevel: 8 }).toBuffer({ resolveWithObject: true })
          : await thumbnail.jpeg({ quality: 78, mozjpeg: true }).toBuffer({ resolveWithObject: true });
        await this.thumbnails.putThumbnail(assetId, new Uint8Array(output.data), {
          sourceArtworkId: sha256,
          widthPx: output.info.width,
          heightPx: output.info.height,
          role: "back-library-preview",
        });
      }
      return record;
    } catch (error) {
      throw new BackLibraryError("BACK_ORIGINAL_UNAVAILABLE", "Back Library metadata could not be stored.", error);
    }
  }

  list(): readonly BackLibraryAssetRecord[] {
    return this.repository.listActive();
  }

  /** Includes immutable retired records so Project references remain visible in the UI. */
  listAll(): readonly BackLibraryAssetRecord[] {
    return this.repository.listAll();
  }

  retire(assetId: string): BackLibraryAssetRecord {
    const hash = assetId.startsWith("back:") ? assetId.slice(5) : "";
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new BackLibraryError("BACK_ASSET_NOT_FOUND", "Back Library asset ID is invalid.");
    const retired = this.repository.retire(assetId);
    if (!retired) throw new BackLibraryError("BACK_ASSET_NOT_FOUND", "Back Library asset does not exist.");
    return retired;
  }

  async resolveOriginal(reference: BackLibraryAssetReference): Promise<ArtworkOriginal> {
    const record = this.repository.get(reference.assetId);
    if (!record) throw new BackLibraryError("BACK_ORIGINAL_UNAVAILABLE", "Referenced Back Library asset record is unavailable.");
    if (reference.assetId !== `back:${reference.sha256}` || record.sha256 !== reference.sha256 || record.format !== reference.format) {
      throw new BackLibraryError("BACK_REFERENCE_MISMATCH", "Project Back Library reference does not match its immutable asset record.");
    }
    try {
      const original = await this.originals.getOriginal(reference.sha256);
      const format = original.format === "jpeg" ? "jpeg" : original.format === "png" ? "png" : undefined;
      if (format !== record.format || original.widthPx !== record.widthPx || original.heightPx !== record.heightPx) {
        throw new BackLibraryError("BACK_ORIGINAL_UNAVAILABLE", "Stored Back Library original metadata no longer matches its immutable record.");
      }
      return original;
    } catch (error) { throw mappedStorageError(error); }
  }

  /** Returns a small validated preview derivative for the live compositor, never the original bytes. */
  async resolvePreview(reference: BackLibraryAssetReference): Promise<{ readonly bytes: Uint8Array; readonly contentType: string; readonly widthPx: number; readonly heightPx: number }> {
    const record = this.repository.get(reference.assetId);
    if (!record) throw new BackLibraryError("BACK_ORIGINAL_UNAVAILABLE", "Referenced Back Library asset record is unavailable.");
    if (reference.assetId !== `back:${reference.sha256}` || record.sha256 !== reference.sha256 || record.format !== reference.format) {
      throw new BackLibraryError("BACK_REFERENCE_MISMATCH", "Project Back Library reference does not match its immutable asset record.");
    }
    const cached = this.previewCache.get(reference.sha256);
    if (cached) {
      this.previewCache.delete(reference.sha256);
      this.previewCache.set(reference.sha256, cached);
      return { ...cached, bytes: new Uint8Array(cached.bytes) };
    }
    const stored = await this.thumbnails?.getThumbnail(reference.assetId);
    if (stored) {
      const contentType = stored.extension === "jpg" || stored.extension === "jpeg" ? "image/jpeg" : "image/png";
      const preview = { bytes: new Uint8Array(stored.bytes), contentType, widthPx: stored.widthPx, heightPx: stored.heightPx };
      this.previewCache.delete(reference.sha256);
      this.previewCache.set(reference.sha256, preview);
      while (this.previewCache.size > 24) this.previewCache.delete(this.previewCache.keys().next().value!);
      return { ...preview, bytes: new Uint8Array(preview.bytes) };
    }
    const original = await this.resolveOriginal(reference);
    const image = sharp(Buffer.from(original.bytes.buffer, original.bytes.byteOffset, original.bytes.byteLength), { limitInputPixels: this.maximumPixels }).rotate().resize({ width: 640, height: 896, fit: "inside", withoutEnlargement: true });
    const output = reference.format === "png"
      ? await image.png({ compressionLevel: 8 }).toBuffer({ resolveWithObject: true })
      : await image.jpeg({ quality: 78, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const preview = {
      bytes: new Uint8Array(output.data),
      contentType: reference.format === "png" ? "image/png" : "image/jpeg",
      widthPx: output.info.width,
      heightPx: output.info.height,
    };
    await this.thumbnails?.putThumbnail(reference.assetId, preview.bytes, {
      sourceArtworkId: reference.sha256,
      widthPx: preview.widthPx,
      heightPx: preview.heightPx,
      role: "back-library-preview",
    });
    this.previewCache.set(reference.sha256, preview);
    while (this.previewCache.size > 24) this.previewCache.delete(this.previewCache.keys().next().value!);
    return { ...preview, bytes: new Uint8Array(preview.bytes) };
  }

  async resolveDisplay(
    reference: BackLibraryAssetReference,
    bucket: ArtworkDisplayWidthBucket,
    signal?: AbortSignal,
  ): Promise<ArtworkDisplayAsset> {
    if (!isArtworkDisplayWidthBucket(bucket)) throw new BackLibraryError("BACK_INVALID_METADATA", "Display width must be one of the supported buckets.");
    if (signal?.aborted) throw Object.assign(new Error("The display image request was cancelled."), { name: "AbortError" });
    if (!this.displayStore) throw new BackLibraryError("BACK_ORIGINAL_UNAVAILABLE", "Back Library display storage is unavailable.");
    const original = await this.resolveOriginal(reference);
    if (signal?.aborted) throw Object.assign(new Error("The display image request was cancelled."), { name: "AbortError" });
    try {
      return await this.displayStore.getOrCreate(reference.assetId, original.contentHash, original.bytes, bucket, signal);
    } catch (error) {
      if (error instanceof BackLibraryError) throw error;
      if (error instanceof TypeError) throw new BackLibraryError("BACK_INVALID_METADATA", error.message, error);
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new BackLibraryError("BACK_ORIGINAL_UNAVAILABLE", "Back Library display image could not be derived.", error);
    }
  }
}
