import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { migrateProjectDatabase } from "../projects/migrations";
import { calculateTemplatePackageHash, parseTemplateMetadata, TemplateValidationError } from "../../templates/validation";
import type {
  TemplateCardFormat,
  TemplateFileExtension,
  TemplateMetadata,
  TemplateOrientation,
  TemplatePackageHashFile,
  TemplatePaper,
  TemplateRegistrationType,
} from "../../templates/types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TEMPLATE_FILES = 500;
const EXTENSIONS = new Set<TemplateFileExtension>(["studio3", "dxf", "svg", "json", "zip"]);
const MIME_TYPES: Readonly<Record<TemplateFileExtension, string>> = {
  studio3: "application/octet-stream",
  dxf: "application/dxf",
  svg: "image/svg+xml",
  json: "application/json",
  zip: "application/zip",
};

export interface TemplateFileRecord {
  readonly fileId: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly extension: TemplateFileExtension;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly createdAt: string;
}

export interface TemplateFileRecordInput extends Omit<TemplateFileRecord, "fileId" | "createdAt"> {}

export interface TemplateVersionRecord extends TemplateMetadata {
  readonly templateId: string;
  readonly packageHash: string;
  readonly createdAt: string;
  readonly files: readonly TemplateFileRecord[];
}

export interface TemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly versions: readonly TemplateVersionRecord[];
}

export interface TemplateAddVersionInput {
  readonly templateId?: string;
  readonly metadata: TemplateMetadata;
  readonly packageHash: string;
  readonly files: readonly TemplateFileRecordInput[];
}

export interface TemplateAddVersionResult {
  readonly templateId: string;
  readonly version: TemplateVersionRecord;
  readonly created: boolean;
}

export class TemplateRepositoryError extends Error {
  constructor(
    readonly code:
      | "TEMPLATE_NOT_FOUND"
      | "TEMPLATE_VERSION_CONFLICT"
      | "TEMPLATE_REFERENCED"
      | "TEMPLATE_IDENTITY_MISMATCH"
      | "TEMPLATE_INVALID"
      | "INVALID_TEMPLATE_TIMESTAMP",
    message: string,
    readonly referenceCount?: number,
  ) {
    super(message);
    this.name = "TemplateRepositoryError";
  }
}

export interface TemplateRepositoryOptions {
  readonly idFactory?: () => string;
  readonly now?: () => string;
}

interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TemplateVersionRow {
  readonly template_id: string;
  readonly version: string;
  readonly package_hash: string;
  readonly paper: TemplatePaper;
  readonly card_format: TemplateCardFormat;
  readonly orientation: TemplateOrientation;
  readonly recommended_bleed_mm: number | null;
  readonly registration_type: TemplateRegistrationType;
  readonly created_at: string;
}

interface TemplateFileRow {
  readonly file_id: string;
  readonly template_id: string;
  readonly version: string;
  readonly relative_path: string;
  readonly file_name: string;
  readonly extension: TemplateFileExtension;
  readonly media_type: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly created_at: string;
}

interface JoinedTemplateVersionRow extends TemplateVersionRow {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly template_created_at: string;
  readonly template_updated_at: string;
}

function normalizedFiles(files: readonly TemplateFileRecordInput[]): TemplateFileRecordInput[] {
  if (files.length === 0 || files.length > MAX_TEMPLATE_FILES) {
    throw new TemplateRepositoryError("TEMPLATE_INVALID", `A template version must have between 1 and ${MAX_TEMPLATE_FILES} associated files.`);
  }
  const normalized = files.map((file) => {
    if (typeof file.relativePath !== "string" || file.relativePath.length > 1024
      || file.relativePath.includes("\0") || /[\u0001-\u001f\u007f]/.test(file.relativePath)) {
      throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template associated file path is invalid.");
    }
    const path = file.relativePath.normalize("NFC").replace(/\\/g, "/");
    const segments = path.split("/");
    if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template associated file path must be safe and relative.");
    }
    if (typeof file.fileName !== "string" || !file.fileName.trim() || file.fileName.length > 255
      || /[\\/\u0000-\u001f\u007f]/.test(file.fileName)) {
      throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template associated file name is invalid.");
    }
    const dot = file.fileName.lastIndexOf(".");
    const extensionFromName = dot > 0 ? file.fileName.slice(dot + 1).toLowerCase() : "";
    if (segments.at(-1) !== file.fileName.normalize("NFC") || extensionFromName !== file.extension) {
      throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template file name, relative path, and extension must agree.");
    }
    if (!EXTENSIONS.has(file.extension) || file.mediaType !== MIME_TYPES[file.extension]
      || !SHA256_PATTERN.test(file.contentHash) || !Number.isSafeInteger(file.byteLength) || file.byteLength <= 0) {
      throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template associated file format, media type, hash, or byte length is invalid.");
    }
    return { ...file, relativePath: path, fileName: file.fileName.normalize("NFC") };
  }).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  if (new Set(normalized.map(({ relativePath }) => relativePath.toLocaleLowerCase("en-US"))).size !== normalized.length) {
    throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template version contains duplicate associated file paths.");
  }
  if (!normalized.some(({ extension }) => extension === "studio3" || extension === "dxf" || extension === "svg")) {
    throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template package must contain at least one .studio3, .dxf, or .svg file.");
  }
  return normalized;
}

function mapFile(row: TemplateFileRow): TemplateFileRecord {
  return {
    fileId: row.file_id,
    relativePath: row.relative_path,
    fileName: row.file_name,
    extension: row.extension,
    mediaType: row.media_type,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    createdAt: row.created_at,
  };
}

export class TemplateRepository {
  private readonly idFactory: () => string;
  private readonly now: () => string;

  constructor(private readonly database: Database.Database, options: TemplateRepositoryOptions = {}) {
    migrateProjectDatabase(database);
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(): TemplateRecord[] {
    const templates = this.database.prepare("SELECT id, name, source, created_at, updated_at FROM templates ORDER BY name COLLATE NOCASE, id")
      .all() as TemplateRow[];
    return templates.map((template) => ({
      id: template.id,
      name: template.name,
      source: template.source,
      createdAt: this.readTimestamp(template.created_at),
      updatedAt: this.readTimestamp(template.updated_at),
      versions: (this.database.prepare("SELECT * FROM template_versions WHERE template_id = ? ORDER BY created_at, version COLLATE NOCASE")
        .all(template.id) as TemplateVersionRow[]).map((version) => this.versionFromRow(template, version)),
    }));
  }

  getVersion(templateId: string, version: string): TemplateVersionRecord | undefined {
    const result = this.database.prepare(`
      SELECT t.id, t.name, t.source, t.created_at AS template_created_at, t.updated_at AS template_updated_at,
        v.template_id, v.version, v.package_hash, v.paper, v.card_format, v.orientation,
        v.recommended_bleed_mm, v.registration_type, v.created_at
      FROM templates t
      INNER JOIN template_versions v ON v.template_id = t.id
      WHERE t.id = ? AND v.version = ?
    `).get(templateId, version) as JoinedTemplateVersionRow | undefined;
    if (!result) return undefined;
    return this.versionFromRow({
      id: result.id,
      name: result.name,
      source: result.source,
      created_at: result.template_created_at,
      updated_at: result.template_updated_at,
    }, result);
  }

  getFile(fileId: string): TemplateFileRecord | undefined {
    const row = this.database.prepare("SELECT * FROM template_files WHERE file_id = ?").get(fileId) as TemplateFileRow | undefined;
    return row ? mapFile(row) : undefined;
  }

  addVersion(input: TemplateAddVersionInput): TemplateAddVersionResult {
    let metadata: TemplateMetadata;
    try {
      metadata = parseTemplateMetadata(input.metadata);
      // Package hash validation also normalizes the metadata and file list.
      const filesForHash: TemplatePackageHashFile[] = input.files.map(({ relativePath, contentHash, byteLength }) => ({ relativePath, contentHash, byteLength }));
      if (calculateTemplatePackageHash(metadata, filesForHash) !== input.packageHash) {
        throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template package hash does not match its metadata and associated file hashes.");
      }
    } catch (error) {
      if (error instanceof TemplateRepositoryError) throw error;
      if (error instanceof TemplateValidationError) throw new TemplateRepositoryError("TEMPLATE_INVALID", error.message);
      throw error;
    }
    if (!SHA256_PATTERN.test(input.packageHash)) throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template package hash must be a lowercase SHA-256 digest.");
    const files = normalizedFiles(input.files);

    return this.database.transaction(() => {
      const timestamp = this.timestamp();
      let templateId = input.templateId;
      let template: TemplateRow | undefined;
      if (templateId === undefined) {
        templateId = this.newId();
        this.database.prepare("INSERT INTO templates (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(templateId, metadata.name, metadata.source, timestamp, timestamp);
        template = { id: templateId, name: metadata.name, source: metadata.source, created_at: timestamp, updated_at: timestamp };
      } else {
        if (!this.validId(templateId)) throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template ID is invalid.");
        template = this.database.prepare("SELECT id, name, source, created_at, updated_at FROM templates WHERE id = ?")
          .get(templateId) as TemplateRow | undefined;
        if (!template) throw new TemplateRepositoryError("TEMPLATE_NOT_FOUND", "Template was not found.");
        if (template.name !== metadata.name || template.source !== metadata.source) {
          throw new TemplateRepositoryError("TEMPLATE_IDENTITY_MISMATCH", "A new version must keep the existing template name and source.");
        }
      }

      const current = this.database.prepare("SELECT * FROM template_versions WHERE template_id = ? AND version = ?")
        .get(templateId, metadata.version) as TemplateVersionRow | undefined;
      if (current) {
        if (current.package_hash !== input.packageHash
          || current.paper !== metadata.paper
          || current.card_format !== metadata.cardFormat
          || current.orientation !== metadata.orientation
          || current.recommended_bleed_mm !== (metadata.recommendedBleedMm ?? null)
          || current.registration_type !== metadata.registrationType
          || !this.sameVersionFiles(templateId, metadata.version, files)) {
          throw new TemplateRepositoryError("TEMPLATE_VERSION_CONFLICT", `Template ${templateId} version ${metadata.version} already exists with different content.`);
        }
        return { templateId, version: this.versionFromRow(template, current), created: false };
      }

      this.database.prepare(`
        INSERT INTO template_versions
          (template_id, version, package_hash, paper, card_format, orientation, recommended_bleed_mm, registration_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        templateId,
        metadata.version,
        input.packageHash,
        metadata.paper,
        metadata.cardFormat,
        metadata.orientation,
        metadata.recommendedBleedMm ?? null,
        metadata.registrationType,
        timestamp,
      );
      for (const file of files) {
        this.database.prepare(`
          INSERT INTO template_files
            (file_id, template_id, version, relative_path, file_name, extension, media_type, content_hash, byte_length, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(this.newId(), templateId, metadata.version, file.relativePath, file.fileName, file.extension, file.mediaType, file.contentHash, file.byteLength, timestamp);
      }
      this.database.prepare("UPDATE templates SET updated_at = ? WHERE id = ?").run(timestamp, templateId);
      const version = this.getVersion(templateId, metadata.version);
      if (!version) throw new TemplateRepositoryError("TEMPLATE_INVALID", "Inserted template version could not be read back.");
      return { templateId, version, created: true };
    }).immediate();
  }

  delete(templateId: string): void {
    if (!this.validId(templateId)) throw new TemplateRepositoryError("TEMPLATE_NOT_FOUND", "Template was not found.");
    this.database.transaction(() => {
      const template = this.database.prepare("SELECT id FROM templates WHERE id = ?").get(templateId);
      if (!template) throw new TemplateRepositoryError("TEMPLATE_NOT_FOUND", "Template was not found.");
      const canonical = this.database.prepare("SELECT COUNT(*) AS count FROM project_template_selections WHERE template_id = ?")
        .get(templateId) as { count: number };
      const recovery = this.database.prepare("SELECT COUNT(*) AS count FROM project_recovery_template_selections WHERE template_id = ?")
        .get(templateId) as { count: number };
      const referenceCount = canonical.count + recovery.count;
      if (referenceCount > 0) {
        throw new TemplateRepositoryError("TEMPLATE_REFERENCED", "Template cannot be removed while a Project or recovery references one of its versions.", referenceCount);
      }
      this.database.prepare("DELETE FROM templates WHERE id = ?").run(templateId);
      // Associated SHA-256 blobs are intentionally retained; metadata deletion never owns shared files.
    }).immediate();
  }

  private versionFromRow(template: TemplateRow, row: TemplateVersionRow): TemplateVersionRecord {
    if (template.id !== row.template_id) throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template and version IDs do not match.");
    return {
      templateId: template.id,
      name: template.name,
      source: template.source,
      version: row.version,
      paper: row.paper,
      cardFormat: row.card_format,
      orientation: row.orientation,
      ...(row.recommended_bleed_mm !== null ? { recommendedBleedMm: row.recommended_bleed_mm } : {}),
      registrationType: row.registration_type,
      packageHash: row.package_hash,
      createdAt: this.readTimestamp(row.created_at),
      files: (this.database.prepare("SELECT * FROM template_files WHERE template_id = ? AND version = ? ORDER BY relative_path COLLATE NOCASE, relative_path")
        .all(template.id, row.version) as TemplateFileRow[]).map(mapFile),
    };
  }

  private sameVersionFiles(templateId: string, version: string, files: readonly TemplateFileRecordInput[]): boolean {
    const stored = this.database.prepare("SELECT * FROM template_files WHERE template_id = ? AND version = ?")
      .all(templateId, version) as TemplateFileRow[];
    if (stored.length !== files.length) return false;
    const storedByPath = new Map(stored.map((row) => [row.relative_path, row] as const));
    if (storedByPath.size !== stored.length) return false;
    return files.every((input) => {
      const row = storedByPath.get(input.relativePath);
      return row !== undefined
        && row.relative_path === input.relativePath
        && row.file_name === input.fileName
        && row.extension === input.extension
        && row.media_type === input.mediaType
        && row.content_hash === input.contentHash
        && row.byte_length === input.byteLength;
    });
  }

  private timestamp(): string {
    const raw = this.now();
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) throw new TemplateRepositoryError("INVALID_TEMPLATE_TIMESTAMP", "Template timestamps must be valid ISO date strings.");
    return parsed.toISOString();
  }

  private readTimestamp(value: string): string {
    if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
      throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template database timestamp is invalid.");
    }
    return value;
  }

  private newId(): string {
    const value = this.idFactory();
    if (!this.validId(value)) throw new TemplateRepositoryError("TEMPLATE_INVALID", "Template ID factory returned an invalid ID.");
    return value;
  }

  private validId(value: string): boolean {
    return typeof value === "string" && value.trim().length > 0 && value.length <= 180 && !/[\u0000-\u001f]/.test(value);
  }
}
