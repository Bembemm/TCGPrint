import { randomUUID } from "node:crypto";
import type { ImportSource } from "../import-engine/types";
import { expandZipSource } from "../import-engine/zip";
import {
  TemplateFileStore,
  TemplateFileStoreError,
} from "../templates/file-store";
import {
  calculateTemplatePackageHash,
  MAX_TEMPLATE_ARCHIVE_BYTES,
  MAX_TEMPLATE_FILE_BYTES,
  parseTemplateMetadata,
  TemplateValidationError,
  validateTemplateFile,
} from "../templates/validation";
import type { TemplateFileExtension, TemplateMetadata, TemplateSelection } from "../templates/types";
import {
  TemplateRepository,
  TemplateRepositoryError,
  type TemplateAddVersionResult,
  type TemplateFileRecordInput,
  type TemplateRecord,
  type TemplateVersionRecord,
} from "../persistence/templates/repository";
import { sanitizeRelativeImportPath } from "../import-engine/source-path";

export const MAX_TEMPLATE_UPLOAD_FILES = 32;
export const MAX_TEMPLATE_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_TEMPLATE_EXPANDED_FILES = 500;
export const MAX_TEMPLATE_METADATA_BYTES = 64 * 1024;
export const MAX_TEMPLATE_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
export const MAX_TEMPLATE_ZIP_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_TEMPLATE_ZIP_RATIO = 100;
export const MAX_TEMPLATE_ZIP_NESTING_DEPTH = 1;

export interface TemplateUploadFile {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface TemplateLibraryLimits {
  readonly maxUploadFiles: number;
  readonly maxTotalUploadBytes: number;
  readonly maxExpandedFiles: number;
  readonly maxFileBytes: number;
  readonly maxArchiveBytes: number;
  readonly maxZipEntries: number;
  readonly maxZipEntryBytes: number;
  readonly maxZipTotalBytes: number;
  readonly maxZipCompressionRatio: number;
}

export interface TemplateLibraryServiceOptions {
  /** Test-only injection point; production uses the fixed documented safety limits. */
  readonly limits?: Partial<TemplateLibraryLimits>;
}

const DEFAULT_LIMITS: TemplateLibraryLimits = Object.freeze({
  maxUploadFiles: MAX_TEMPLATE_UPLOAD_FILES,
  maxTotalUploadBytes: MAX_TEMPLATE_TOTAL_UPLOAD_BYTES,
  maxExpandedFiles: MAX_TEMPLATE_EXPANDED_FILES,
  maxFileBytes: MAX_TEMPLATE_FILE_BYTES,
  maxArchiveBytes: MAX_TEMPLATE_ARCHIVE_BYTES,
  maxZipEntries: 500,
  maxZipEntryBytes: MAX_TEMPLATE_ZIP_ENTRY_BYTES,
  maxZipTotalBytes: MAX_TEMPLATE_ZIP_TOTAL_BYTES,
  maxZipCompressionRatio: MAX_TEMPLATE_ZIP_RATIO,
});

export type TemplateIntegrityStatus = "available" | "missing" | "corrupt" | "hash-mismatch";

export interface TemplateFileInspection {
  readonly fileId: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly extension: TemplateFileExtension;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly status: "available" | "missing" | "corrupt";
}

export interface TemplateSelectionInspection {
  readonly selection: TemplateSelection;
  readonly status: TemplateIntegrityStatus;
  readonly version: TemplateVersionRecord | null;
  readonly files: readonly TemplateFileInspection[];
}

export class TemplateLibraryError extends Error {
  constructor(
    readonly code: "TEMPLATE_PACKAGE_INVALID" | "TEMPLATE_UPLOAD_LIMIT" | "TEMPLATE_NOT_FOUND",
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TemplateLibraryError";
  }
}

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

function validateLimits(overrides: Partial<TemplateLibraryLimits> | undefined): TemplateLibraryLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Template library limit ${key} must be a positive safe integer.`);
  }
  return limits;
}

function templateMetadata(metadata: TemplateMetadata): TemplateMetadata {
  return {
    name: metadata.name,
    source: metadata.source,
    version: metadata.version,
    paper: metadata.paper,
    cardFormat: metadata.cardFormat,
    orientation: metadata.orientation,
    ...(metadata.recommendedBleedMm === undefined ? {} : { recommendedBleedMm: metadata.recommendedBleedMm }),
    registrationType: metadata.registrationType,
  };
}

function metadataForHash(version: TemplateVersionRecord): TemplateMetadata {
  return {
    name: version.name,
    source: version.source,
    version: version.version,
    paper: version.paper,
    cardFormat: version.cardFormat,
    orientation: version.orientation,
    ...(version.recommendedBleedMm === undefined ? {} : { recommendedBleedMm: version.recommendedBleedMm }),
    registrationType: version.registrationType,
  };
}

function normalizeZipPath(path: string, archiveName: string): string {
  const prefix = `${archiveName}!/`;
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  try {
    const safe = sanitizeRelativeImportPath(relative);
    if (!safe) throw new TypeError("empty path");
    return `${archiveName}.contents/${safe}`;
  } catch (error) {
    throw new TemplateLibraryError("TEMPLATE_PACKAGE_INVALID", "ZIP package contains an invalid relative entry path.", error);
  }
}

function bytesFromSource(source: ImportSource): Uint8Array {
  if (!source.originalBytes) throw new TemplateLibraryError("TEMPLATE_PACKAGE_INVALID", "ZIP package entry has no original bytes.");
  return source.originalBytes;
}

function addValidatedFile(
  records: Array<{ input: TemplateFileRecordInput; bytes: Uint8Array }>,
  fileName: string,
  relativePath: string,
  bytes: Uint8Array,
  maximumBytes: number,
): void {
  const validated = validateTemplateFile(fileName, bytes, { maxFileBytes: maximumBytes });
  const normalizedPath = sanitizeRelativeImportPath(relativePath);
  if (!normalizedPath || new Set(records.map(({ input }) => input.relativePath.toLowerCase())).has(normalizedPath.toLowerCase())) {
    throw new TemplateLibraryError("TEMPLATE_PACKAGE_INVALID", "Template package contains an empty or duplicate associated file path.");
  }
  records.push({
    input: {
      relativePath: normalizedPath,
      fileName: validated.fileName,
      extension: validated.extension,
      mediaType: validated.mediaType,
      contentHash: validated.contentHash,
      byteLength: validated.byteLength,
    },
    bytes,
  });
}

/** Ingests opaque originals and safe ZIP packages without interpreting .studio3 or extracting to disk. */
export class TemplateLibraryService {
  private readonly limits: TemplateLibraryLimits;

  constructor(
    private readonly repository: TemplateRepository,
    private readonly fileStore: TemplateFileStore,
    options: TemplateLibraryServiceOptions = {},
  ) {
    this.limits = validateLimits(options.limits);
  }

  list(): TemplateRecord[] {
    return this.repository.list();
  }

  remove(templateId: string): void {
    this.repository.delete(templateId);
  }

  async importTemplate(metadataInput: unknown, uploads: readonly TemplateUploadFile[], templateId?: string): Promise<TemplateAddVersionResult> {
    const metadata = parseTemplateMetadata(metadataInput);
    if (!Array.isArray(uploads) || uploads.length === 0 || uploads.length > this.limits.maxUploadFiles) {
      throw new TemplateLibraryError("TEMPLATE_UPLOAD_LIMIT", `Upload must include between 1 and ${this.limits.maxUploadFiles} files.`);
    }
    let uploadedBytes = 0;
    const records: Array<{ input: TemplateFileRecordInput; bytes: Uint8Array }> = [];
    for (const upload of uploads) {
      if (!upload || typeof upload.fileName !== "string" || !(upload.bytes instanceof Uint8Array)) {
        throw new TemplateValidationError("TEMPLATE_FILE_INVALID", "Template upload contains an invalid file entry.");
      }
      uploadedBytes += upload.bytes.byteLength;
      if (!Number.isSafeInteger(uploadedBytes) || uploadedBytes > this.limits.maxTotalUploadBytes) {
        throw new TemplateLibraryError("TEMPLATE_UPLOAD_LIMIT", `Template uploads exceed ${this.limits.maxTotalUploadBytes} total bytes.`);
      }
      const extension = fileExtension(upload.fileName);
      const maxBytes = extension === "zip" ? this.limits.maxArchiveBytes : this.limits.maxFileBytes;
      const validated = validateTemplateFile(upload.fileName, upload.bytes, { maxFileBytes: maxBytes });
      if (validated.extension !== "zip") {
        addValidatedFile(records, validated.fileName, validated.fileName, upload.bytes, this.limits.maxFileBytes);
        continue;
      }

      addValidatedFile(records, validated.fileName, validated.fileName, upload.bytes, this.limits.maxArchiveBytes);
      const source: ImportSource = {
        id: randomUUID(),
        kind: "file",
        filename: validated.fileName,
        order: 0,
        sizeBytes: upload.bytes.byteLength,
        originalBytes: upload.bytes,
        sha256: validated.contentHash,
      };
      let expanded;
      try {
        expanded = await expandZipSource(source, {
          limits: {
            maxZipArchiveBytes: this.limits.maxArchiveBytes,
            maxZipEntries: this.limits.maxZipEntries,
            maxZipEntryBytes: this.limits.maxZipEntryBytes,
            maxZipTotalUncompressedBytes: this.limits.maxZipTotalBytes,
            maxZipCompressionRatio: this.limits.maxZipCompressionRatio,
            maxZipNestingDepth: MAX_TEMPLATE_ZIP_NESTING_DEPTH,
          },
        });
      } catch (error) {
        throw new TemplateLibraryError("TEMPLATE_PACKAGE_INVALID", "Template ZIP could not be safely expanded.", error);
      }
      if (expanded.errors.length > 0) {
        const first = expanded.errors[0]!;
        throw new TemplateLibraryError("TEMPLATE_PACKAGE_INVALID", `Template ZIP rejected (${first.code}): ${first.message}`);
      }
      if (expanded.sources.some((entry) => fileExtension(entry.filename ?? "") === "zip")) {
        throw new TemplateLibraryError("TEMPLATE_PACKAGE_INVALID", "Nested ZIP files are not allowed in a template package.");
      }
      for (const entry of expanded.sources) {
        const entryName = entry.filename ?? "";
        const relativePath = normalizeZipPath(entry.sourcePath ?? entryName, validated.fileName);
        addValidatedFile(records, entryName, relativePath, bytesFromSource(entry), this.limits.maxZipEntryBytes);
      }
      if (records.length > this.limits.maxExpandedFiles) {
        throw new TemplateLibraryError("TEMPLATE_UPLOAD_LIMIT", `Template package exceeds ${this.limits.maxExpandedFiles} associated files.`);
      }
    }
    if (records.length > this.limits.maxExpandedFiles) {
      throw new TemplateLibraryError("TEMPLATE_UPLOAD_LIMIT", `Template package exceeds ${this.limits.maxExpandedFiles} associated files.`);
    }
    const files = records.map(({ input }) => input);
    const packageHash = calculateTemplatePackageHash(metadata, files);

    // All names, formats, ZIP paths and limits are checked before storing any originals or DB rows.
    for (const { bytes, input } of records) {
      const stored = await this.fileStore.put(bytes);
      if (stored.contentHash !== input.contentHash || stored.byteLength !== input.byteLength) {
        throw new TemplateFileStoreError("TEMPLATE_FILE_CORRUPT", "Stored template original differs from validated upload bytes.");
      }
    }
    return this.repository.addVersion({ templateId, metadata, packageHash, files });
  }

  async readFile(fileId: string): Promise<Uint8Array> {
    const file = this.repository.getFile(fileId);
    if (!file) throw new TemplateLibraryError("TEMPLATE_NOT_FOUND", "Template file was not found.");
    return this.fileStore.get(file.contentHash, file.byteLength);
  }

  async inspectSelection(selection: TemplateSelection): Promise<TemplateSelectionInspection> {
    const version = this.repository.getVersion(selection.templateId, selection.version);
    if (!version) return { selection, status: "missing", version: null, files: [] };
    const files: TemplateFileInspection[] = await Promise.all(version.files.map(async (file) => {
      let status: TemplateFileInspection["status"] = "available";
      try { await this.fileStore.get(file.contentHash, file.byteLength); }
      catch (error) {
        if (error instanceof TemplateFileStoreError && error.code === "TEMPLATE_FILE_MISSING") status = "missing";
        else status = "corrupt";
      }
      return {
        fileId: file.fileId,
        fileName: file.fileName,
        relativePath: file.relativePath,
        extension: file.extension,
        contentHash: file.contentHash,
        byteLength: file.byteLength,
        status,
      };
    }));
    const expectedPackageHash = calculateTemplatePackageHash(metadataForHash(version), version.files.map(({ relativePath, contentHash, byteLength }) => ({ relativePath, contentHash, byteLength })));
    const status = selection.packageHash !== version.packageHash || expectedPackageHash !== version.packageHash ? "hash-mismatch"
      : files.some(({ status: fileStatus }) => fileStatus === "missing") ? "missing"
        : files.some(({ status: fileStatus }) => fileStatus === "corrupt") ? "corrupt" : "available";
    return { selection, status, version, files };
  }
}
