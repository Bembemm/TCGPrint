import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProjectSnapshotV1 } from "./serializer";
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
}

export interface ProjectRecoveryRecord {
  readonly projectId: string;
  readonly baseRevision: number;
  readonly projectSchemaVersion: number;
  readonly snapshot: ProjectSnapshotV1;
  readonly createdAt: string;
}

export class ProjectRepositoryError extends Error {
  constructor(
    readonly code:
      | "PROJECT_NOT_FOUND"
      | "PROJECT_REVISION_CONFLICT"
      | "PROJECT_RECOVERY_NOT_FOUND"
      | "PROJECT_RECOVERY_EXISTS"
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

  create(initialSnapshot: ProjectSnapshotV1 = emptySnapshot()): ProjectRecord {
    const snapshot = deserializeProjectSnapshot(initialSnapshot);
    return this.insertFreshProject(DEFAULT_PROJECT_NAME, snapshot);
  }

  duplicate(projectId: string): ProjectRecord {
    const original = this.open(projectId);
    return this.insertFreshProject(`${original.name} (cópia)`, original.snapshot);
  }

  delete(projectId: string): void {
    this.database.transaction(() => {
      const result = this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      if (result.changes !== 1) throw this.notFound(projectId);
    }).immediate();
  }

  stageRecovery(projectId: string, baseRevision: number, candidateSnapshot: ProjectSnapshotV1): ProjectRecoveryRecord {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Recovery base revision must be a positive integer.");
    }
    const snapshot = deserializeProjectSnapshot(candidateSnapshot);
    const snapshotJson = serializeProjectSnapshot(snapshot.cards, snapshot.settings);
    return this.database.transaction(() => {
      const project = this.database.prepare(`
        SELECT id, name, project_schema_version, revision, snapshot_json, created_at, updated_at, autosaved_at
        FROM projects WHERE id = ?
      `).get(projectId) as ProjectRow | undefined;
      if (!project) throw this.notFound(projectId);
      this.recordFromRow(project);
      if (project.revision !== baseRevision) {
        throw new ProjectRepositoryError(
          "PROJECT_REVISION_CONFLICT",
          `Project ${projectId} is at revision ${project.revision}; recovery is based on revision ${baseRevision}.`,
          baseRevision,
          project.revision,
        );
      }
      const existing = this.database.prepare("SELECT project_id FROM project_recovery WHERE project_id = ?").get(projectId);
      if (existing) {
        throw new ProjectRepositoryError("PROJECT_RECOVERY_EXISTS", `Project ${projectId} already has a staged recovery candidate.`);
      }
      const createdAt = this.timestamp();
      this.database.prepare(`
        INSERT INTO project_recovery (project_id, base_revision, project_schema_version, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, baseRevision, snapshot.projectSchemaVersion, snapshotJson, createdAt);
      return { projectId, baseRevision, projectSchemaVersion: snapshot.projectSchemaVersion, snapshot, createdAt };
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
        updatedAt: now,
        autosavedAt: now,
      };
    })();
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

  private insertFreshProject(name: string, snapshot: ProjectSnapshotV1): ProjectRecord {
    const snapshotJson = serializeProjectSnapshot(snapshot.cards, snapshot.settings);
    const id = this.newProjectId();
    const now = this.timestamp();
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO projects
          (id, name, project_schema_version, revision, snapshot_json, created_at, updated_at, autosaved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, snapshot.projectSchemaVersion, INITIAL_PROJECT_REVISION, snapshotJson, now, now, now);
    }).immediate();
    return {
      id,
      name,
      projectSchemaVersion: snapshot.projectSchemaVersion,
      revision: INITIAL_PROJECT_REVISION,
      snapshot,
      createdAt: now,
      updatedAt: now,
      autosavedAt: now,
    };
  }

  save(projectId: string, expectedRevision: number, nextSnapshot: ProjectSnapshotV1): ProjectRecord {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Expected project revision must be a positive integer.");
    }
    const snapshot = deserializeProjectSnapshot(nextSnapshot);
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
      this.recordFromRow(row);
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
      return {
        ...metadata,
        projectSchemaVersion: snapshot.projectSchemaVersion,
        revision: nextRevision,
        snapshot,
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
    const snapshot = deserializeProjectSnapshot(row.snapshot_json);
    if (row.project_schema_version !== snapshot.projectSchemaVersion) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", `Project ${row.id} database and snapshot schema versions do not match.`);
    }
    return { ...metadata, snapshot };
  }

  private recoveryFromRow(row: ProjectRecoveryRow): ProjectRecoveryRecord {
    if (typeof row.project_id !== "string" || !row.project_id
      || !Number.isSafeInteger(row.base_revision) || row.base_revision < 1
      || !Number.isSafeInteger(row.project_schema_version) || row.project_schema_version < 1
      || typeof row.snapshot_json !== "string") {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", "Project recovery metadata is invalid.");
    }
    const snapshot = deserializeProjectSnapshot(row.snapshot_json);
    if (row.project_schema_version !== snapshot.projectSchemaVersion) {
      throw new ProjectSnapshotError("INVALID_PROJECT_SNAPSHOT", `Project ${row.project_id} recovery schema versions do not match.`);
    }
    return {
      projectId: row.project_id,
      baseRevision: row.base_revision,
      projectSchemaVersion: row.project_schema_version,
      snapshot,
      createdAt: this.readTimestamp(row.created_at),
    };
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
      projectSchemaVersion: row.project_schema_version,
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
