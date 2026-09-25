import type { ImportLimits } from "./types";

export const IMPORT_LIMITS: ImportLimits = Object.freeze({
  maxInputBytes: 50 * 1024 * 1024,
  maxRasterPixels: 100_000_000,
  maxSvgBytes: 5 * 1024 * 1024,
  maxTextBytes: 5 * 1024 * 1024,
  maxCsvBytes: 25 * 1024 * 1024,
  maxCsvRows: 100_000,
  maxJsonBytes: 8 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 250_000,
  maxXmlBytes: 5 * 1024 * 1024,
  maxXmlDepth: 64,
  maxXmlNodes: 100_000,
  maxZipArchiveBytes: 100 * 1024 * 1024,
  maxZipEntries: 500,
  maxZipEntryBytes: 50 * 1024 * 1024,
  maxZipTotalUncompressedBytes: 200 * 1024 * 1024,
  maxZipCompressionRatio: 100,
  maxZipNestingDepth: 3,
});

export function resolveImportLimits(overrides?: Partial<ImportLimits>): ImportLimits {
  const limits = { ...IMPORT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Import limit ${key} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}
