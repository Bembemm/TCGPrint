import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { WorkingCard } from "../../core/cards/types";
import { openProjectDatabase } from "../../persistence/projects/database";
import { ProjectRepository } from "../../persistence/projects/repository";
import { DEFAULT_PROJECT_SETTINGS, deserializeProjectSnapshot, serializeProjectSnapshot } from "../../persistence/projects/serializer";
import { openArtworkDatabase } from "../../persistence/sqlite";
import { createDefaultRegistrationConfig } from "../../core/registration";
import { TemplateRepository } from "../../persistence/templates/repository";
import { calculateTemplatePackageHash, parseTemplateMetadata } from "../../templates/validation";

describe("project repository", () => {
  let directory: string | undefined;
  let database: ReturnType<typeof openProjectDatabase> | undefined;
  let artworkDatabase: ReturnType<typeof openProjectDatabase> | undefined;
  let repository: ProjectRepository | undefined;

  afterEach(async () => {
    database?.close();
    database = undefined;
    artworkDatabase?.close();
    artworkDatabase = undefined;
    repository = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function setup() {
    directory = await mkdtemp(join(tmpdir(), "tcgprint-project-repository-"));
    database = openProjectDatabase(join(directory, "projects.sqlite"));
    let id = 0;
    let time = 0;
    repository = new ProjectRepository(database, {
      idFactory: () => `project-${++id}`,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, time++)).toISOString(),
    });
    return repository;
  }

  it("creates, lists, and opens an empty project at explicit initial revision one", async () => {
    const projects = await setup();

    const created = projects.create();

    expect(created).toEqual({
      id: "project-1",
      name: "Novo projeto",
      projectSchemaVersion: 2,
      revision: 1,
      snapshot: {
        projectSchemaVersion: 2,
        cards: [],
        settings: {
          bleedMm: 0.625,
          roundedCorners: false,
          cutGuides: {
            trim: { enabled: false, extentMm: 1, color: "blue" },
          external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
        },
        pageOrientation: "portrait",
        cardOrientation: "portrait",
        paperFormat: { name: "A4", widthMm: 210, heightMm: 297 },
        cardFormat: { id: "magic-standard", name: "Magic Standard", widthMm: 63.5, heightMm: 88.9, cornerRadiusMm: 3.175 },
        marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
        horizontalGapMm: 0,
        verticalGapMm: 0,
        registration: { type: "none", orientation: "portrait" },
        layout: { skippedSlotIndices: [] },
        },
      },
      templateSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      autosavedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(projects.list()).toEqual([{
      id: "project-1",
      name: "Novo projeto",
      projectSchemaVersion: 2,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      autosavedAt: "2026-01-01T00:00:00.000Z",
    }]);
    expect(projects.open("project-1")).toEqual(created);
    expect(projects.get("missing-project")).toBeUndefined();
  });

  it("persists registration and skipped-slot settings through save, reopen, duplicate, and recovery promotion", async () => {
    const projects = await setup();
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      pageOrientation: "landscape" as const,
      cardOrientation: "portrait" as const,
      marginsMm: { top: 4, right: 5, bottom: 6, left: 7 },
      horizontalGapMm: 2,
      verticalGapMm: 3,
      registration: createDefaultRegistrationConfig("four-point", "landscape", { insetXMm: 13 }),
      layout: {
        rows: 1,
        columns: 2,
        skippedSlotIndices: [1],
        templateGeometry: {
          orientation: "landscape" as const,
          cardOrientation: "portrait" as const,
          pageSizeMm: { widthMm: 297, heightMm: 210 },
          cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
          rows: 1,
          columns: 2,
          slots: [
            { index: 0, row: 0, column: 0, xMm: 20, yMm: 60.55 },
            { index: 1, row: 0, column: 1, xMm: 100, yMm: 60.55 },
          ],
        },
      },
    };
    const initial = deserializeProjectSnapshot(serializeProjectSnapshot([], settings));
    const created = projects.create(initial);
    const saved = projects.save(created.id, created.revision, initial);
    const reopened = projects.open(saved.id);

    expect(reopened.snapshot.settings).toEqual(settings);
    const duplicate = projects.duplicate(reopened.id);
    expect(duplicate.snapshot.settings).toEqual(settings);
    const staged = projects.stageRecovery(reopened.id, reopened.revision, initial);
    expect(projects.promoteRecovery(reopened.id).snapshot.settings).toEqual(staged.snapshot.settings);
  });

  it("binds Project template geometry to the exact selected package version across save and recovery", async () => {
    const projects = await setup();
    let templateId = 0;
    const templates = new TemplateRepository(database!, { idFactory: () => `template-${++templateId}` });
    const geometry = (xMm: number) => ({
      orientation: "portrait" as const,
      cardOrientation: "portrait" as const,
      pageSizeMm: { widthMm: 210, heightMm: 297 },
      cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      rows: 1,
      columns: 1,
      slots: [{ index: 0, row: 0, column: 0, xMm, yMm: 104.05 }],
    });
    const addVersion = (version: string, templateGeometry: ReturnType<typeof geometry> | undefined) => {
      const metadata = parseTemplateMetadata({
        name: "Version-bound geometry",
        source: "test fixture",
        version,
        paper: "a4",
        cardFormat: "standard",
        orientation: "portrait",
        registrationType: "none",
        ...(templateGeometry ? { templateGeometry } : {}),
      });
      const packageHashFiles = [{ relativePath: "template.svg", contentHash: "a".repeat(64), byteLength: 1 }];
      const packageHash = calculateTemplatePackageHash(metadata, packageHashFiles);
      const result = templates.addVersion({
        metadata,
        packageHash,
        files: [{
          ...packageHashFiles[0]!,
          fileName: "template.svg",
          extension: "svg",
          mediaType: "image/svg+xml",
        }],
      });
      return { ...result, packageHash };
    };
    const v5 = addVersion("v5", geometry(73.25));
    const v5Selection = { templateId: v5.templateId, version: "v5", packageHash: v5.packageHash };
    const v5Snapshot = deserializeProjectSnapshot(serializeProjectSnapshot([], {
      ...DEFAULT_PROJECT_SETTINGS,
      layout: { skippedSlotIndices: [], templateGeometry: geometry(73.25) },
    }));
    const created = projects.create(v5Snapshot, v5Selection);
    const legacySnapshotJson = serializeProjectSnapshot([], DEFAULT_PROJECT_SETTINGS);
    database!.prepare("UPDATE projects SET snapshot_json = ? WHERE id = ?").run(legacySnapshotJson, created.id);
    addVersion("v6", geometry(74.25));

    expect(projects.open(created.id)?.snapshot.settings.layout.templateGeometry).toEqual(geometry(73.25));
    expect(database!.prepare("SELECT snapshot_json FROM projects WHERE id = ?").get(created.id)).toEqual({ snapshot_json: legacySnapshotJson });
    const v6Snapshot = deserializeProjectSnapshot(serializeProjectSnapshot([], {
      ...DEFAULT_PROJECT_SETTINGS,
      layout: { skippedSlotIndices: [], templateGeometry: geometry(74.25) },
    }));
    expect(() => projects.save(created.id, created.revision, v6Snapshot))
      .toThrowError(expect.objectContaining({ code: "PROJECT_TEMPLATE_GEOMETRY_MISMATCH" }));
    expect(() => projects.stageRecovery(created.id, created.revision, v6Snapshot, v5Selection))
      .toThrowError(expect.objectContaining({ code: "PROJECT_TEMPLATE_GEOMETRY_MISMATCH" }));

    const v4 = addVersion("v4", undefined);
    const v4Selection = { templateId: v4.templateId, version: "v4", packageHash: v4.packageHash };
    const projectWithoutVersionGeometry = projects.create(undefined, v4Selection);
    expect(() => projects.save(projectWithoutVersionGeometry.id, projectWithoutVersionGeometry.revision, v6Snapshot))
      .toThrowError(expect.objectContaining({ code: "PROJECT_TEMPLATE_GEOMETRY_MISMATCH" }));
    expect(() => projects.stageRecovery(projectWithoutVersionGeometry.id, projectWithoutVersionGeometry.revision, v6Snapshot, v4Selection))
      .toThrowError(expect.objectContaining({ code: "PROJECT_TEMPLATE_GEOMETRY_MISMATCH" }));
  });

  it("opens legacy v1 snapshots with explicit v2 defaults without rewriting the stored bytes", async () => {
    const projects = await setup();
    const created = projects.create();
    const legacy = JSON.stringify({
      projectSchemaVersion: 1,
      cards: [],
      settings: {
        bleedMm: 1.25,
        roundedCorners: true,
        cutGuides: DEFAULT_PROJECT_SETTINGS.cutGuides,
      },
    });
    database!.prepare("UPDATE projects SET project_schema_version = 1, snapshot_json = ? WHERE id = ?").run(legacy, created.id);

    const opened = projects.open(created.id);

    expect(opened.projectSchemaVersion).toBe(2);
    expect(opened.snapshot).toMatchObject({
      projectSchemaVersion: 2,
      settings: { bleedMm: 1.25, roundedCorners: true, registration: { type: "none", orientation: "portrait" } },
    });
    expect(database!.prepare("SELECT snapshot_json FROM projects WHERE id = ?").get(created.id)).toEqual({ snapshot_json: legacy });
  });

  it("creates and saves a project with a confirmed custom card identity", async () => {
    const projects = await setup();
    const customCard: WorkingCard = {
      id: "working-card-custom",
      quantity: 1,
      order: 0,
      importSource: { sourceId: "source-custom", importKind: "text", entryKind: "card" },
      identityHints: { name: "Custom card" },
      identity: null,
      identityResolution: { status: "custom", method: "custom", candidates: [], confirmed: true },
      faces: [{ id: "front", side: "front", name: "Custom card" }],
      selectedArtworkByFace: {},
      localArtworkIds: [],
      mpcReferences: [],
      faceAssociations: [],
    };
    const initialSnapshot = {
      projectSchemaVersion: 2 as const,
      cards: [customCard],
      settings: DEFAULT_PROJECT_SETTINGS,
    };

    const created = projects.create(initialSnapshot);
    const saved = projects.save(created.id, created.revision, created.snapshot);

    expect(created.snapshot.cards[0].identity).toBeNull();
    expect(created.snapshot.cards[0].identityResolution).toEqual(customCard.identityResolution);
    expect(saved.revision).toBe(2);
    expect(saved.snapshot.cards[0].identityResolution).toEqual(customCard.identityResolution);
  });

  it("increments revisions with compare-and-swap and rejects stale writes", async () => {
    const projects = await setup();
    const created = projects.create();
    const nextSnapshot = {
      ...created.snapshot,
      settings: { ...created.snapshot.settings, bleedMm: 1 },
    };

    const saved = projects.save(created.id, 1, nextSnapshot);

    expect(saved.revision).toBe(2);
    expect(saved.snapshot.settings.bleedMm).toBe(1);
    expect(saved.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(saved.updatedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(saved.autosavedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(() => projects.save(created.id, 1, created.snapshot))
      .toThrowError(expect.objectContaining({ code: "PROJECT_REVISION_CONFLICT", expectedRevision: 1, actualRevision: 2 }));
    expect(projects.open(created.id)).toEqual(saved);
  });

  it("does not recreate a project when a save arrives after deletion", async () => {
    const projects = await setup();
    const created = projects.create();
    database!.prepare("DELETE FROM projects WHERE id = ?").run(created.id);

    expect(() => projects.save(created.id, 1, created.snapshot))
      .toThrowError(expect.objectContaining({ code: "PROJECT_NOT_FOUND" }));
    expect(database!.prepare("SELECT id FROM projects WHERE id = ?").get(created.id)).toBeUndefined();
  });

  it("does not rewrite future or corrupt stored snapshots when opening them", async () => {
    const projects = await setup();
    const future = projects.create();
    const corrupt = projects.create();
    const futureJson = JSON.stringify({ projectSchemaVersion: 3, cards: [], settings: {} });
    const corruptJson = "{";
    database!.prepare("UPDATE projects SET project_schema_version = 3, snapshot_json = ? WHERE id = ?").run(futureJson, future.id);
    database!.prepare("UPDATE projects SET snapshot_json = ? WHERE id = ?").run(corruptJson, corrupt.id);
    const readRaw = (projectId: string) => database!.prepare("SELECT project_schema_version, revision, snapshot_json FROM projects WHERE id = ?").get(projectId);
    const futureBefore = readRaw(future.id);
    const corruptBefore = readRaw(corrupt.id);

    expect(() => projects.open(future.id)).toThrowError(expect.objectContaining({ code: "FUTURE_PROJECT_SCHEMA_VERSION" }));
    expect(() => projects.open(corrupt.id)).toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));

    expect(readRaw(future.id)).toEqual(futureBefore);
    expect(readRaw(corrupt.id)).toEqual(corruptBefore);
  });

  it("duplicates the canonical snapshot under a new project ID while preserving WorkingCard IDs", async () => {
    const projects = await setup();
    const card: WorkingCard = {
      id: "working-card-stable-id",
      quantity: 2,
      order: 0,
      importSource: { sourceId: "source-1", importKind: "text", entryKind: "card" },
      identityHints: { name: "Island" },
      identity: null,
      identityResolution: { status: "unresolved", candidates: [], confirmed: false },
      faces: [{ id: "front", side: "front", name: "Island" }],
      selectedArtworkByFace: {},
      localArtworkIds: [`upload:${"b".repeat(64)}`],
      mpcReferences: [],
      faceAssociations: [],
    };
    const initial = deserializeProjectSnapshot(serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS));
    const original = projects.create(initial);

    const duplicate = projects.duplicate(original.id);

    expect(duplicate.id).toBe("project-2");
    expect(duplicate.name).toBe("Novo projeto (cópia)");
    expect(duplicate.revision).toBe(1);
    expect(duplicate.createdAt).toBe("2026-01-01T00:00:01.000Z");
    expect(duplicate.snapshot.cards.map(({ id }) => id)).toEqual(["working-card-stable-id"]);
    expect(duplicate.snapshot).toEqual(original.snapshot);
    expect(duplicate.snapshot).not.toBe(original.snapshot);
    expect(projects.open(original.id)).toEqual(original);
  });

  it("duplicates under one write transaction so another connection cannot delete the source between read and insert", async () => {
    const projects = await setup();
    const original = projects.create();
    const competingDatabase = new Database(join(directory!, "projects.sqlite"), { timeout: 0 });
    let competingError: unknown;
    const duplicateRepository = new ProjectRepository(database!, {
      idFactory: () => {
        try {
          competingDatabase.prepare("DELETE FROM projects WHERE id = ?").run(original.id);
        } catch (error) {
          competingError = error;
        }
        return "project-copy";
      },
      now: () => "2026-01-01T00:00:10.000Z",
    });

    try {
      const duplicate = duplicateRepository.duplicate(original.id);

      expect(competingError).toMatchObject({ code: "SQLITE_BUSY" });
      expect(duplicate.name).toBe("Novo projeto (cópia)");
      expect(duplicate.revision).toBe(1);
      expect(duplicate.snapshot).toEqual(original.snapshot);
      expect(projects.open(original.id)).toEqual(original);
      expect(projects.open(duplicate.id)).toEqual(duplicate);
    } finally {
      competingDatabase.close();
    }
  });

  it("leaves no duplicate when insertion fails", async () => {
    const projects = await setup();
    const original = projects.create();
    database!.exec(`
      CREATE TRIGGER reject_project_copy
      BEFORE INSERT ON projects
      WHEN NEW.name = 'Novo projeto (cópia)'
      BEGIN SELECT RAISE(ABORT, 'project copy insert blocked'); END
    `);

    expect(() => projects.duplicate(original.id)).toThrow(/project copy insert blocked/);

    expect(projects.list().map(({ id }) => id)).toEqual([original.id]);
    expect(projects.open(original.id)).toEqual(original);
  });

  it("deletes only the selected project rows and leaves artwork storage untouched", async () => {
    const projects = await setup();
    const target = projects.create();
    const retained = projects.create();
    const artworkPath = join(directory!, "artwork-cache.sqlite");
    artworkDatabase = openArtworkDatabase(artworkPath);
    artworkDatabase.exec("CREATE TABLE isolation_marker (value TEXT NOT NULL); INSERT INTO isolation_marker VALUES ('preserve artwork');");
    const assetDirectory = join(directory!, "artwork-originals");
    await mkdir(assetDirectory);
    const assetPath = join(assetDirectory, "shared-original.png");
    await writeFile(assetPath, new Uint8Array([137, 80, 78, 71, 1, 2, 3]));

    projects.delete(target.id);

    expect(projects.get(target.id)).toBeUndefined();
    expect(projects.list().map(({ id }) => id)).toEqual([retained.id]);
    expect(artworkDatabase.prepare("SELECT value FROM isolation_marker").get()).toEqual({ value: "preserve artwork" });
    expect(await readFile(assetPath)).toEqual(Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  });

  it("stages a recovery candidate separately while leaving the canonical snapshot unchanged", async () => {
    const projects = await setup();
    const canonical = projects.create();
    const candidate = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };

    const staged = projects.stageRecovery(canonical.id, 1, candidate);

    expect(staged).toEqual({
      projectId: canonical.id,
      baseRevision: 1,
      projectSchemaVersion: 2,
      snapshot: candidate,
      templateSelection: null,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(projects.open(canonical.id)).toEqual(canonical);
    expect(projects.readRecovery(canonical.id)).toEqual(staged);
  });

  it("acknowledges a repeated identical recovery stage without replacing its timestamp", async () => {
    const projects = await setup();
    const canonical = projects.create();
    const candidate = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };
    const first = projects.stageRecovery(canonical.id, canonical.revision, candidate);

    const repeated = projects.stageRecovery(canonical.id, canonical.revision, candidate);

    expect(repeated).toEqual(first);
    expect(projects.readRecovery(canonical.id)).toEqual(first);
  });

  it("promotes a recovery candidate by compare-and-swap and removes it atomically", async () => {
    const projects = await setup();
    const canonical = projects.create();
    const candidate = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };
    projects.stageRecovery(canonical.id, 1, candidate);
    expect(projects.open(canonical.id)).toEqual(canonical);

    const promoted = projects.promoteRecovery(canonical.id);

    expect(promoted.revision).toBe(2);
    expect(promoted.snapshot.settings.bleedMm).toBe(2);
    expect(promoted.updatedAt).toBe("2026-01-01T00:00:02.000Z");
    expect(promoted.autosavedAt).toBe("2026-01-01T00:00:02.000Z");
    expect(projects.readRecovery(canonical.id)).toBeUndefined();
  });

  it("discards a staged recovery without changing the canonical snapshot", async () => {
    const projects = await setup();
    const canonical = projects.create();
    const candidate = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };
    projects.stageRecovery(canonical.id, 1, candidate);

    projects.discardRecovery(canonical.id);

    expect(projects.open(canonical.id)).toEqual(canonical);
    expect(projects.readRecovery(canonical.id)).toBeUndefined();
    expect(() => projects.discardRecovery(canonical.id))
      .toThrowError(expect.objectContaining({ code: "PROJECT_RECOVERY_NOT_FOUND" }));
  });

  it("keeps a staged candidate readable after an interruption before promotion", async () => {
    const projects = await setup();
    const canonical = projects.create();
    const candidate = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };
    projects.stageRecovery(canonical.id, 1, candidate);

    database!.close();
    database = openProjectDatabase(join(directory!, "projects.sqlite"));
    repository = new ProjectRepository(database, { idFactory: () => "unused", now: () => "2026-01-01T00:00:10.000Z" });

    expect(repository.readRecovery(canonical.id)).toMatchObject({ baseRevision: 1, snapshot: candidate });
    expect(repository.open(canonical.id)).toEqual(canonical);
    const promoted = repository.promoteRecovery(canonical.id);
    expect(promoted.revision).toBe(2);
    expect(promoted.snapshot.settings.bleedMm).toBe(2);
    expect(repository.readRecovery(canonical.id)).toBeUndefined();
  });

  it("keeps stale recovery readable and never overwrites a later canonical revision", async () => {
    const projects = await setup();
    const canonical = projects.create();
    const recoveryCandidate = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };
    projects.stageRecovery(canonical.id, 1, recoveryCandidate);
    const newerCanonical = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 1 } };
    const saved = projects.save(canonical.id, 1, newerCanonical);

    expect(() => projects.promoteRecovery(canonical.id))
      .toThrowError(expect.objectContaining({ code: "PROJECT_REVISION_CONFLICT", expectedRevision: 1, actualRevision: 2 }));
    expect(projects.open(canonical.id)).toEqual(saved);
    expect(projects.readRecovery(canonical.id)).toMatchObject({ baseRevision: 1, snapshot: recoveryCandidate });
    const duplicate = projects.duplicate(canonical.id);
    expect(duplicate.snapshot).toEqual(saved.snapshot);
    expect(duplicate.snapshot.settings.bleedMm).toBe(1);
    expect(projects.readRecovery(canonical.id)).toMatchObject({ snapshot: recoveryCandidate });
    projects.discardRecovery(canonical.id);
    expect(projects.readRecovery(canonical.id)).toBeUndefined();
  });

  it("copies a stale recovery into a new project and removes the candidate without changing the source", async () => {
    const projects = await setup();
    const card: WorkingCard = {
      id: "working-card-recovery-copy",
      quantity: 2,
      order: 5,
      importSource: { sourceId: "source-recovery", importKind: "text", entryKind: "card" },
      identityHints: { name: "Recovery card" },
      identity: null,
      identityResolution: { status: "unresolved", candidates: [], confirmed: false },
      faces: [{ id: "front", side: "front", name: "Recovery card" }],
      selectedArtworkByFace: {
        front: {
          candidateId: `upload:${"a".repeat(64)}`,
          source: "upload",
          identityId: null,
          faceId: "front",
          selectionPolicy: "user-selected",
        },
      },
      localArtworkIds: [`upload:${"a".repeat(64)}`],
      mpcReferences: [],
      faceAssociations: [],
    };
    const canonical = projects.create();
    const candidate = deserializeProjectSnapshot(serializeProjectSnapshot([card], {
      ...DEFAULT_PROJECT_SETTINGS,
      bleedMm: 2,
    }));
    projects.stageRecovery(canonical.id, canonical.revision, candidate);
    const newerCanonical = projects.save(canonical.id, canonical.revision, {
      ...canonical.snapshot,
      settings: { ...canonical.snapshot.settings, bleedMm: 1 },
    });

    const copy = projects.copyRecovery(canonical.id);

    expect(copy).toMatchObject({
      id: "project-2",
      name: "Novo projeto (recuperado)",
      revision: 1,
      snapshot: candidate,
    });
    expect(copy.snapshot.cards[0]).toMatchObject({
      id: "working-card-recovery-copy",
      selectedArtworkByFace: { front: { candidateId: `upload:${"a".repeat(64)}` } },
    });
    expect(projects.open(canonical.id)).toEqual(newerCanonical);
    expect(projects.readRecovery(canonical.id)).toBeUndefined();
  });

  it("rolls back canonical promotion when removing the staged row fails", async () => {
    const projects = await setup();
    const canonical = projects.create();
    const candidate = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };
    const staged = projects.stageRecovery(canonical.id, 1, candidate);
    database!.exec(`CREATE TRIGGER reject_recovery_delete BEFORE DELETE ON project_recovery BEGIN SELECT RAISE(ABORT, 'recovery delete blocked'); END`);

    expect(() => projects.promoteRecovery(canonical.id)).toThrow(/recovery delete blocked/);

    expect(projects.open(canonical.id)).toEqual(canonical);
    expect(projects.readRecovery(canonical.id)).toEqual(staged);
  });
});
