import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkingCard } from "../../core/cards/types";
import { openProjectDatabase } from "../../persistence/projects/database";
import { ProjectRepository } from "../../persistence/projects/repository";
import { DEFAULT_PROJECT_SETTINGS, deserializeProjectSnapshot, serializeProjectSnapshot } from "../../persistence/projects/serializer";
import { openArtworkDatabase } from "../../persistence/sqlite";

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
      projectSchemaVersion: 1,
      revision: 1,
      snapshot: {
        projectSchemaVersion: 1,
        cards: [],
        settings: {
          bleedMm: 0.625,
          roundedCorners: false,
          cutGuides: {
            trim: { enabled: false, extentMm: 1, color: "blue" },
            external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
          },
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      autosavedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(projects.list()).toEqual([{
      id: "project-1",
      name: "Novo projeto",
      projectSchemaVersion: 1,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      autosavedAt: "2026-01-01T00:00:00.000Z",
    }]);
    expect(projects.open("project-1")).toEqual(created);
    expect(projects.get("missing-project")).toBeUndefined();
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
    const futureJson = JSON.stringify({ projectSchemaVersion: 2, cards: [], settings: {} });
    const corruptJson = "{";
    database!.prepare("UPDATE projects SET project_schema_version = 2, snapshot_json = ? WHERE id = ?").run(futureJson, future.id);
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
      projectSchemaVersion: 1,
      snapshot: candidate,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(projects.open(canonical.id)).toEqual(canonical);
    expect(projects.readRecovery(canonical.id)).toEqual(staged);
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
