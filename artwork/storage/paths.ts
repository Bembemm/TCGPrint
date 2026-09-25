import { join } from "node:path";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_EXTENSIONS = new Set(["jpg", "png", "webp", "avif", "gif", "svg", "tif"]);

export interface ArtworkAppDataPaths {
  readonly rootDirectory: string;
  readonly databaseFile: string;
  readonly originalsDirectory: string;
  readonly thumbnailsDirectory: string;
}

export function appDataPaths(baseDirectory: string): ArtworkAppDataPaths {
  const rootDirectory = join(baseDirectory, ".tcgprint");
  return {
    rootDirectory,
    databaseFile: join(rootDirectory, "artwork-cache.sqlite"),
    originalsDirectory: join(rootDirectory, "originals"),
    thumbnailsDirectory: join(rootDirectory, "thumbnails"),
  };
}

export function validateContentHash(hash: string): string {
  if (!HASH_PATTERN.test(hash)) throw new TypeError("Artwork content hash must be a lowercase SHA-256 hex digest.");
  return hash;
}

export function validateArtworkExtension(extension: string): string {
  const normalized = extension.toLowerCase().replace(/^\./, "");
  if (!SAFE_EXTENSIONS.has(normalized)) throw new TypeError("Artwork extension is not supported.");
  return normalized;
}

export function originalPathForHash(originalsDirectory: string, hash: string, extension: string): string {
  const safeHash = validateContentHash(hash);
  const safeExtension = validateArtworkExtension(extension);
  return join(/*turbopackIgnore: true*/ originalsDirectory, safeHash.slice(0, 2), `${safeHash}.${safeExtension}`);
}

export function thumbnailPathForHash(thumbnailsDirectory: string, hash: string, extension: string): string {
  const safeHash = validateContentHash(hash);
  const safeExtension = validateArtworkExtension(extension);
  return join(/*turbopackIgnore: true*/ thumbnailsDirectory, safeHash.slice(0, 2), `${safeHash}.${safeExtension}`);
}
