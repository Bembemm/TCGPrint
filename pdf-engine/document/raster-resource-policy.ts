export interface RasterReuseIdentity {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PdfRasterCacheDiagnostics {
  readonly rasterEmbeds: number;
  readonly cacheLookups: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheEntries: number;
  readonly snapshotBytes: number;
}

const diagnosticsByPdfBytes = new WeakMap<Uint8Array, PdfRasterCacheDiagnostics>();

export function associatePdfRasterCacheDiagnostics(
  pdfBytes: Uint8Array,
  diagnostics: PdfRasterCacheDiagnostics,
): void {
  diagnosticsByPdfBytes.set(pdfBytes, diagnostics);
}

/** Internal benchmark/test diagnostics; not exported from the PDF engine barrel. */
export function readPdfRasterCacheDiagnostics(pdfBytes: Uint8Array): PdfRasterCacheDiagnostics | undefined {
  return diagnosticsByPdfBytes.get(pdfBytes);
}

/**
 * Counts exact byte identities within digest buckets. Digest collisions are
 * deliberately split by byte equality so a unique raster is not retained for
 * a cache entry that can never produce a safe hit.
 */
export function countRasterReuseOccurrences(
  identities: readonly (RasterReuseIdentity | undefined)[],
): number[] {
  const occurrences = new Array<number>(identities.length).fill(0);
  const groupsByDigest = new Map<string, Array<{ bytes: Uint8Array; indexes: number[] }>>();

  for (const [index, identity] of identities.entries()) {
    if (!identity) continue;
    const digestGroups = groupsByDigest.get(identity.sha256) ?? [];
    let group = digestGroups.find((candidate) => sameBytes(candidate.bytes, identity.bytes));
    if (!group) {
      group = { bytes: identity.bytes, indexes: [] };
      digestGroups.push(group);
      groupsByDigest.set(identity.sha256, digestGroups);
    }
    group.indexes.push(index);
  }

  for (const digestGroups of groupsByDigest.values()) {
    for (const group of digestGroups) {
      for (const index of group.indexes) occurrences[index] = group.indexes.length;
    }
  }

  return occurrences;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
