import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { parseTemplateLayoutGeometry, type TemplateLayoutGeometryMm } from "../../core/geometry";
import type { ProjectSnapshotV1 } from "./serializer";
import type { TemplateSelection } from "../../templates/types";
import { verifyPrinterProfileSnapshot } from "../printer-profiles/hash";
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  DEFAULT_PROJECT_SETTINGS,
  ProjectSnapshotError,
  deserializeProjectSnapshot,
  serializeProjectSnapshot,
} from "./serializer";

export const DEFAULT_PROJECT_NAME = "Novo projeto";
export const INITIAL_PROJECT_REVISION = 1;

export interface ProjectMetadata {
  readonly id: string;
  readonly name: string;
  readonly projectSchemaVersion: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly autosavedAt: string;
}

export interface ProjectRecord extends ProjectMetadata {
  readonly snapshot: ProjectSnapshotV1;
  readonly templateSelection: TemplateSelection | null;
}

export interface ProjectRecoveryRecord {
  readonly projectId: string;
  readonly baseRevision: number;
  readonly projectSchemaVersion: number;
  readonly snapshot: ProjectSnapshotV1;
  readonly templateSelection: TemplateSelection | null;
  readonly createdAt: string;
}

export class ProjectRepositoryError extends Error {
  constructor(
    readonly code:
      | "PROJECT_NOT_FOUND"
      | "PROJECT_REVISION_CONFLICT"
      | "PROJECT_RECOVERY_NOT_FOUND"
      | "PROJECT_RECOVERY_EXISTS"
      | "PROJECT_TEMPLATE_NOT_FOUND"
      | "PROJECT_TEMPLATE_GEOMETRY_MISMATCH"
      | "PROJECT_CUT_SOURCE_NOT_FOUND"
      | "INVALID_PROJECT_TIMESTAMP",
    message: string,
    readonly expectedRevision?: number,
    readonly actualRevision?: number,
  ) {
    super(message);
    this.name = "ProjectRepositoryError";
  }
}

export interface ProjectRepositoryOptions {
  readonly idFactory?: () => string;
  readonly now?: () => string;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly project_schema_version: number;
  readonly revision: number;
  readonly snapshot_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly autosaved_at: string;
}

interface ProjectRecoveryRow {
  readonly project_id: string;
  readonly base_revision: number;
  readonly project_schema_version: number;
  readonly snapshot_json: string;
  readonly created_at: string;
}

function emptySnapshot(): ProjectSnapshotV1 {
  return {
    projectSchemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    cards: [],
    settings: DEFAULT_PROJECT_SETTINGS,
  };
}

export class ProjectRepository {
  private readonly idFactory: () => string;
  private readonly now: () => string;

  constructor(private readonly database: Database.Database, options: ProjectRepositoryOptions = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(): ProjectMetadata[] {
    const rows = this.database.prepare(`
      SELECT id, name, project_schema_version, revision, created_at, updated_at, autosaved_at
      FROM projects
      ORDER BY updated_at DESC, id ASC
    `).all() as ProjectRow[];
    return rows.map((row) => this.metadataFromRow(row));
  }

  get(projectId: string): ProjectRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, name, project_schema_version, revision, snapshot_json, created_at, updated_at, autosaved_at
      FROM projects WHERE id = ?
    `).get(projectId) as ProjectRow | undefined;
    return row ? this.recordFromRow(row) : undefined;
  }

  open(projectId: string): ProjectRecord {
    const project = this.get(projectId);
    if (!project) throw this.notFound(projectId);
    return project;
  }

  create(initialSnapshot: ProjectSnapshotV1 = emptySnapshot(), templateSelection: TemplateSelection | null = null): ProjectRecord {
    return this.insertFreshProject(DEFAULT_PROJECT_NAME, initialSnapshot, templateSelection);
  }

  duplicate(projectId: string): ProjectRecord {
    return this.database.transaction(() => {
      const original = this.open(projectId);
      const duplicate = this.freshProjectRecord(`${original.name} (cópia)`, original.snapshot, original.templateSelection);
      this.insertProject(duplicate);
      return duplicate;
    }).immediate();
  }

  delete(projectId: string): void {
    this.database.transaction(() => {
      const result = this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      if (result.changes !== 1) throw this.notFound(projectId);
    }).immediate();
  }

  stageRecovery(
    projectId: string,
    baseRevision: number,
    candidateSnapshot: ProjectSnapshotV1,
    candidateSelection?: TemplateSelection | null,
  ): ProjectRecoveryRecord {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Recovery base revision must be a positive integer.");
    }
    const snapshot = deserializeProjectSnapshot(candidateSnapshot);
    this.validateCalibrationSelection(snapshot);
    const snapshotJson = serializeProjectSnapshot(snapshot.cards, snapshot.settings);
    return this.database.transaction(() => {
      const project = this.database.prepare(`
        SELECT id, name, project_schema_version, revision, snapshot_json, created_at, updated_at, autosaved_at
        FROM projects WHERE id = ?
      `).get(projectId) as ProjectRow | undefined;
      if (!project) throw this.notFound(projectId);
      const canonical = this.recordFromRow(project);
      if (project.revision !== baseRevision) {
        throw new ProjectRepositoryError(
          "PROJECT_REVISION_CONFLICT",
          `Project ${projectId} is at revision ${project.revision}; recovery is based on revision ${baseRevision}.`,
          baseRevision,
          project.revision,
        );
      }
      const existing = this.database.prepare(`
        SELECT project_id, base_revision, project_schema_version, snapshot_json, created_at
        FROM project_recovery WHERE project_id = ?
      `).get(projectId) as ProjectRecoveryRow | undefined;
      const selection = candidateSelection === undefined ? canonical.templateSelection : candidateSelection;
      this.validateTemplateSelection(selection, snapshot);
      if (existing) {
        const recovery = this.recoveryFromRow(existing);
        if (recovery.baseRevision === baseRevision && existing.snapshot_json === snapshotJson
          && this.sameSelection(recovery.templateSelection, selection)) return recovery;
        throw new ProjectRepositoryError("PROJECT_RECOVERY_EXISTS", `Project ${projectId} already has a staged recovery candidate.`);
      }
      const createdAt = this.timestamp();
      this.database.prepare(`
        INSERT INTO project_recovery (project_id, base_revision, project_schema_version, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, baseRevision, snapshot.projectSchemaVersion, snapshotJson, createdAt);
      this.writeRecoveryTemplateSelection(projectId, selection);
      return { projectId, baseRevision, projectSchemaVersion: snapshot.projectSchemaVersion, snapshot, templateSelection: selection, createdAt };
    }).immediate();
  }

  readRecovery(projectId: string): ProjectRecoveryRecord | undefined {
    const project = this.database.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) throw this.notFound(projectId);
    const row = this.database.prepare(`
      SELECT project_id, base_revision, project_schema_version, snapshot_json, created_at
      FROM project_recovery WHERE project_id = ?
    `).get(projectId) as ProjectRecoveryRow | undefined;
    return row ? this.recoveryFromRow(row) : undefined;
  }

  promoteRecovery(projectId: string): ProjectRecord {
    return this.database.transaction(() => {
      const project = this.database.prepare(`
        SELECT id, name, project_schema_version, revision, snapshot_json, created_at, updated_at, autosaved_at
        FROM projects WHERE id = ?
      `).get(projectId) as ProjectRow | undefined;
      if (!project) throw this.notFound(projectId);
      const staged = this.database.prepare(`
        SELECT project_id, base_revision, project_schema_version, snapshot_json, created_at
        FROM project_recovery WHERE project_id = ?
      `).get(projectId) as ProjectRecoveryRow | undefined;
      if (!staged) {
        throw new ProjectRepositoryError("PROJECT_RECOVERY_NOT_FOUND", `Project ${projectId} has no staged recovery candidate.`);
      }
      const current = this.recordFromRow(project);
      const recovery = this.recoveryFromRow(staged);
      this.validateTemplateSelection(recovery.templateSelection, recovery.snapshot);
      if (project.revision !== recovery.baseRevision) {
        throw new ProjectRepositoryError(
          "PROJECT_REVISION_CONFLICT",
          `Recovery for project ${projectId} is based on revision ${recovery.baseRevision}, but the project is at revision ${project.revision}.`,
          recovery.baseRevision,
          project.revision,
        );
      }
      const now = this.timestamp();
      const revision = recovery.baseRevision + 1;
      this.writeProjectTemplateSelection(projectId, recovery.templateSelection);
      const update = this.database.prepare(`
        UPDATE projects
        SET project_schema_version = ?, revision = ?, snapshot_json = ?, updated_at = ?, autosaved_at = ?
        WHERE id = ? AND revision = ?
      `).run(recovery.projectSchemaVersion, revision, staged.snapshot_json, now, now, projectId, recovery.baseRevision);
      if (update.changes !== 1) {
        const row = this.database.prepare("SELECT revision FROM projects WHERE id = ?").get(projectId) as { revision: number } | undefined;
        if (!row) throw this.notFound(projectId);
        throw new ProjectRepositoryError("PROJECT_REVISION_CONFLICT", `Project ${projectId} changed during recovery.`, recovery.baseRevision, row.revision);
      }
      const discarded = this.database.prepare("DELETE FROM project_recovery WHERE project_id = ? AND base_revision = ?").run(projectId, recovery.baseRevision);
      if (discarded.changes !== 1) {
        throw new ProjectRepositoryError("PROJECT_RECOVERY_NOT_FOUND", `Project ${projectId} recovery candidate changed during promotion.`);
      }
      return {
        ...current,
        projectSchemaVersion: recovery.projectSchemaVersion,
        revision,
        snapshot: recovery.snapshot,
        templateSelection: recovery.templateSelection,
        updatedAt: now,
        autosavedAt: now,
      };
    }).immediate();
  }

  discardRecovery(projectId: string): void {
    this.database.transaction(() => {
      const project = this.database.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
      if (!project) throw this.notFound(projectId);
      const result = this.database.prepare("DELETE FROM project_recovery WHERE project_id = ?").run(projectId);
      if (result.changes !== 1) {
        throw new ProjectRepositoryError("PROJECT_RECOVERY_NOT_FOUND", `Project ${projectId} has no staged recovery candidate.`);
      }
    }).immediate();
  }

  /** Copies a staged candidate to a new Project when its canonical base is no longer current. */
  copyRecovery(projectId: string): ProjectRecord {
    return this.database.transaction(() => {
      const source = this.database.prepare(`
        SELECT id, name, project_schema_version, revision, snapshot_json, created_at, updated_at, autosaved_at
        FROM projects WHERE id = ?
      `).get(projectId) as ProjectRow | undefined;
      if (!source) throw this.notFound(projectId);
      this.recordFromRow(source);

      const staged = this.database.prepare(`
        SELECT project_id, base_revision, project_schema_version, snapshot_json, created_at
        FROM project_recovery WHERE project_id = ?
      `).get(projectId) as ProjectRecoveryRow | undefined;
      if (!staged) {
        throw new ProjectRepositoryError("PROJECT_RECOVERY_NOT_FOUND", `Project ${projectId} has no staged recovery candidate.`);
      }
      const recovery = this.recoveryFromRow(staged);
      const copy = this.freshProjectRecord(`${source.name} (recuperado)`, recovery.snapshot, recovery.templateSelection);
      this.insertProject(copy);
      const removed = this.database.prepare(`
        DELETE FROM project_recovery WHERE project_id = ? AND base_revision = ?
      `).run(projectId, recovery.baseRevision);
      if (removed.changes !== 1) {
        throw new ProjectRepositoryError("PROJECT_RECOVERY_NOT_FOUND", `Project ${projectId} recovery candidate changed during copy.`);
      }
      return copy;
    }).immediate();
  }

  private insertFreshProject(name: string, snapshot: ProjectSnapshotV1, templateSelection: TemplateSelection | null): ProjectRecord {
    const project = this.freshProjectRecord(name, snapshot, templateSelection);
    this.database.transaction(() => this.insertProject(project)).immediate();
    return project;
  }

  private freshProjectRecord(name: string, snapshot: ProjectSnapshotV1, templateSelection: TemplateSelection | null = null): ProjectRecord {
    const validatedSnapshot = deserializeProjectSnapshot(snapshot);
    this.validateCalibrationSelection(validatedSnapshot);
    const id = this.newProjectId();
    const now = this.timestamp();
    return {
      id,
      name,
      projectSchemaVersion: validatedSnapshot.projectSchemaVersion,
      revision: INITIAL_PROJECT_REVISION,
      snapshot: validatedSnapshot,
      templateSelection,
      createdAt: now,
      updatedAt: now,
      autosavedAt: now,
    };
  }

  private insertProject(project: ProjectRecord): void {
    this.validateTemplateSelection(project.templateSelection, project.snapshot);
    const snapshotJson = serializeProjectSnapshot(project.snapshot.cards, project.snapshot.settings);
    this.database.prepare(`
      INSERT INTO projects
        (id, name, project_schema_version, revision, snapshot_json, created_at, updated_at, autosaved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id,
      project.name,
      project.projectSchemaVersion,
      project.revision,
      snapshotJson,
      project.createdAt,
      project.updatedAt,
      project.autosavedAt,
    );
    this.writeProjectTemplateSelection(project.id, project.templateSelection);
  }

  save(
    projectId: string,
    expectedRevision: number,
    nextSnapshot: ProjectSnapshotV1,
    nextSelection?: TemplateSelection | null,
  ): ProjectRecord {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Expected project revision must be a positive integer.");
    }
    const snapshot = deserializeProjectSnapshot(nextSnapshot);
    this.validateCalibrationSelection(snapshot);
    const snapshotJson = serializeProjectSnapshot(snapshot.cards, snapshot.settings);
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT id, name, project_schema_version, revision, snapshot_json, created_at, updated_at, autosaved_at
        FROM projects WHERE id = ?
      `).get(projectId) as ProjectRow | undefined;
      if (!row) throw this.notFound(projectId);
      const metadata = this.metadataFromRow(row);
      if (row.revision !== expectedRevision) {
        throw new ProjectRepositoryError(
          "PROJECT_REVISION_CONFLICT",
          `Project ${projectId} is at revision ${row.revision}; expected revision ${expectedRevision}.`,
          expectedRevision,
          row.revision,
        );
      }
      const current = this.recordFromRow(row);
      const selection = nextSelection === undefined ? current.templateSelection : nextSelection;
      this.validateTemplateSelection(selection, snapshot);
      const now = this.timestamp();
      const nextRevision = row.revision + 1;
      const result = this.database.prepare(`
        UPDATE projects
        SET project_schema_version = ?, revision = ?, snapshot_json = ?, updated_at = ?, autosaved_at = ?
        WHERE id = ? AND revision = ?
      `).run(snapshot.projectSchemaVersion, nextRevision, snapshotJson, now, now, projectId, expectedRevision);
      if (result.changes !== 1) {
        const current = this.database.prepare("SELECT revision FROM projects WHERE id = ?").get(projectId) as { revision: number } | undefined;
        if (!current) throw this.notFound(projectId);
        throw new ProjectRepositoryError("PROJECT_REVISION_CONFLICT", `Project ${projectId} changed during save.`, expectedRevision, current.revision);
      }
      this.writeProjectTemplateSelection(projectId, selection);
      return {
        ...metadata,
        projectSchemaVersion: snapshot.projectSchemaVersion,
        revision: nextRevision,
        snapshot,
        templateSelection: selection,
        updatedAt: now,
        autosavedAt: now,
      };
    }).immediate();
  }

  private recordFromRow(row: ProjectRow): ProjectRecord {
    const metadata = this.metadataFromRow(row);
    if (typeof row.snapshot_json !== "string") {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", `Project ${row.id} snapshot must be stored as JSON text.`);
    }
    let snapshot = deserializeProjectSnapshot(row.snapshot_json);
    this.validateCalibrationSelection(snapshot);
    if (row.project_schema_version !== snapshot.projectSchemaVersion && (row.project_schema_version < 1 || row.project_schema_version > 4)) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", `Project ${row.id} database and snapshot schema versions do not match.`);
    }
    const templateSelection = this.readProjectTemplateSelection(row.id);
    snapshot = this.restoreVersionedTemplateGeometry(snapshot, templateSelection);
    return { ...metadata, projectSchemaVersion: snapshot.projectSchemaVersion, snapshot, templateSelection };
  }

  private recoveryFromRow(row: ProjectRecoveryRow): ProjectRecoveryRecord {
    if (typeof row.project_id !== "string" || !row.project_id
      || !Number.isSafeInteger(row.base_revision) || row.base_revision < 1
      || !Number.isSafeInteger(row.project_schema_version) || row.project_schema_version < 1
      || typeof row.snapshot_json !== "string") {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Project recovery metadata is invalid.");
    }
    let snapshot = deserializeProjectSnapshot(row.snapshot_json);
    this.validateCalibrationSelection(snapshot);
    if (row.project_schema_version !== snapshot.projectSchemaVersion && (row.project_schema_version < 1 || row.project_schema_version > 4)) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", `Project ${row.project_id} recovery schema versions do not match.`);
    }
    const templateSelection = this.readRecoveryTemplateSelection(row.project_id);
    snapshot = this.restoreVersionedTemplateGeometry(snapshot, templateSelection);
    return {
      projectId: row.project_id,
      baseRevision: row.base_revision,
      projectSchemaVersion: snapshot.projectSchemaVersion,
      snapshot,
      templateSelection,
      createdAt: this.readTimestamp(row.created_at),
    };
  }

  private readProjectTemplateSelection(projectId: string): TemplateSelection | null {
    const row = this.database.prepare(`
      SELECT template_id, version, package_hash FROM project_template_selections WHERE project_id = ?
    `).get(projectId) as { template_id: string; version: string; package_hash: string } | undefined;
    return row ? { templateId: row.template_id, version: row.version, packageHash: row.package_hash } : null;
  }

  private readRecoveryTemplateSelection(projectId: string): TemplateSelection | null {
    const row = this.database.prepare(`
      SELECT template_id, version, package_hash FROM project_recovery_template_selections WHERE project_id = ?
    `).get(projectId) as { template_id: string; version: string; package_hash: string } | undefined;
    return row ? { templateId: row.template_id, version: row.version, packageHash: row.package_hash } : null;
  }

  private validateCalibrationSelection(snapshot: ProjectSnapshotV1): void {
    if (snapshot.settings.printerProfileSelection) verifyPrinterProfileSnapshot(snapshot.settings.printerProfileSelection);
  }

  private validateTemplateSelection(selection: TemplateSelection | null, snapshot: ProjectSnapshotV1): void {
    const cutSource = snapshot.settings.cutSourceSelection;
    if (selection === null) {
      if (cutSource !== null) throw new ProjectRepositoryError("PROJECT_CUT_SOURCE_NOT_FOUND", "A cut source must belong to the Project's exact selected template version.");
      return;
    }
    if (!selection || typeof selection.templateId !== "string" || !selection.templateId
      || typeof selection.version !== "string" || !selection.version
      || !/^[a-f0-9]{64}$/.test(selection.packageHash)) {
      throw new ProjectRepositoryError("PROJECT_TEMPLATE_NOT_FOUND", "Project template selection is invalid.");
    }
    const version = this.database.prepare(`
      SELECT template_geometry_json FROM template_versions WHERE template_id = ? AND version = ? AND package_hash = ?
    `).get(selection.templateId, selection.version, selection.packageHash);
    if (!version) {
      throw new ProjectRepositoryError("PROJECT_TEMPLATE_NOT_FOUND", "The selected template ID, version, and hash are not present in the library.");
    }
    if (cutSource !== null) {
      const file = this.database.prepare(`
        SELECT f.extension, f.content_hash
        FROM template_files f
        INNER JOIN template_versions v ON v.template_id = f.template_id AND v.version = f.version
        WHERE f.file_id = ? AND f.template_id = ? AND f.version = ? AND v.package_hash = ?
      `).get(cutSource.fileId, selection.templateId, selection.version, selection.packageHash) as { extension: string; content_hash: string } | undefined;
      if (!file || (file.extension !== "svg" && file.extension !== "dxf") || file.content_hash !== cutSource.fileHash
        || (cutSource.dxfUnitsOverride !== undefined && file.extension !== "dxf")) {
        throw new ProjectRepositoryError("PROJECT_CUT_SOURCE_NOT_FOUND", "The selected SVG/DXF file and SHA-256 do not belong to the exact Project template version.");
      }
    }
    const geometry = this.templateGeometryFromVersion((version as { template_geometry_json: string | null }).template_geometry_json);
    const projectGeometry = snapshot.settings.layout.templateGeometry;
    if ((geometry === undefined) !== (projectGeometry === undefined)
      || (geometry !== undefined && JSON.stringify(geometry) !== JSON.stringify(projectGeometry))) {
      throw new ProjectRepositoryError(
        "PROJECT_TEMPLATE_GEOMETRY_MISMATCH",
        `Project geometry does not match template ${selection.templateId} version ${selection.version} (${selection.packageHash}); this version's immutable geometry must be used exactly.`,
      );
    }
  }

  private restoreVersionedTemplateGeometry(snapshot: ProjectSnapshotV1, selection: TemplateSelection | null): ProjectSnapshotV1 {
    if (!selection || snapshot.settings.layout.templateGeometry) return snapshot;
    const row = this.database.prepare(`
      SELECT template_geometry_json FROM template_versions WHERE template_id = ? AND version = ? AND package_hash = ?
    `).get(selection.templateId, selection.version, selection.packageHash) as { template_geometry_json: string | null } | undefined;
    if (!row) return snapshot;
    const geometry = this.templateGeometryFromVersion(row.template_geometry_json);
    if (!geometry) return snapshot;
    return deserializeProjectSnapshot({
      ...snapshot,
      settings: {
        ...snapshot.settings,
        layout: { ...snapshot.settings.layout, templateGeometry: geometry },
      },
    });
  }

  private templateGeometryFromVersion(value: string | null): TemplateLayoutGeometryMm | undefined {
    if (value === null) return undefined;
    try {
      return parseTemplateLayoutGeometry(JSON.parse(value) as unknown);
    } catch (error) {
      throw new ProjectRepositoryError(
        "PROJECT_TEMPLATE_NOT_FOUND",
        `Selected template version contains invalid immutable geometry: ${error instanceof Error ? error.message : "invalid JSON"}`,
      );
    }
  }

  private writeProjectTemplateSelection(projectId: string, selection: TemplateSelection | null): void {
    if (selection === null) {
      this.database.prepare("DELETE FROM project_template_selections WHERE project_id = ?").run(projectId);
      return;
    }
    this.database.prepare(`
      INSERT INTO project_template_selections (project_id, template_id, version, package_hash) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET template_id = excluded.template_id, version = excluded.version, package_hash = excluded.package_hash
    `).run(projectId, selection.templateId, selection.version, selection.packageHash);
  }

  private writeRecoveryTemplateSelection(projectId: string, selection: TemplateSelection | null): void {
    if (selection === null) {
      this.database.prepare("DELETE FROM project_recovery_template_selections WHERE project_id = ?").run(projectId);
      return;
    }
    this.database.prepare(`
      INSERT INTO project_recovery_template_selections (project_id, template_id, version, package_hash) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET template_id = excluded.template_id, version = excluded.version, package_hash = excluded.package_hash
    `).run(projectId, selection.templateId, selection.version, selection.packageHash);
  }

  private sameSelection(left: TemplateSelection | null, right: TemplateSelection | null): boolean {
    return left === null ? right === null : right !== null
      && left.templateId === right.templateId && left.version === right.version && left.packageHash === right.packageHash;
  }

  private metadataFromRow(row: ProjectRow): ProjectMetadata {
    if (typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !row.name
      || !Number.isSafeInteger(row.project_schema_version) || row.project_schema_version < 1
      || !Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Project database metadata is invalid.");
    }
    return {
      id: row.id,
      name: row.name,
      projectSchemaVersion: row.project_schema_version <= 4 ? CURRENT_PROJECT_SCHEMA_VERSION : row.project_schema_version,
      revision: row.revision,
      createdAt: this.readTimestamp(row.created_at),
      updatedAt: this.readTimestamp(row.updated_at),
      autosavedAt: this.readTimestamp(row.autosaved_at),
    };
  }

  private timestamp(): string {
    const value = this.now();
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new ProjectRepositoryError("INVALID_PROJECT_TIMESTAMP", "Project timestamps must be valid ISO date strings.");
    }
    return date.toISOString();
  }

  private readTimestamp(value: string): string {
    if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Project database timestamps are invalid.");
    }
    return value;
  }

  private newProjectId(): string {
    const id = this.idFactory();
    if (typeof id !== "string" || !id.trim() || id.length > 180 || /[\u0000-\u001f]/.test(id)) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Project ID factory returned an invalid ID.");
    }
    return id;
  }

  private notFound(projectId: string): ProjectRepositoryError {
    return new ProjectRepositoryError("PROJECT_NOT_FOUND", `Project ${projectId} was not found.`);
  }
}
