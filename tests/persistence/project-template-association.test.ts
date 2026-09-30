import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDatabase } from "../../persistence/projects/database";
import { ProjectRepository } from "../../persistence/projects/repository";
import type { TemplateSelection } from "../../templates/types";

describe("project template association", () => {
  let directory: string | undefined;
  let database: ReturnType<typeof openProjectDatabase> | undefined;

  afterEach(async () => {
    database?.close();
    database = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function seedTemplateVersion(version: string, hashCharacter: string): TemplateSelection {
    const selection = { templateId: "alan-a4", version, packageHash: hashCharacter.repeat(64) };
    database!.prepare("INSERT OR IGNORE INTO templates (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("alan-a4", "Alan A4", "local", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database!.prepare(`INSERT INTO template_versions
      (template_id, version, package_hash, paper, card_format, orientation, recommended_bleed_mm, registration_type, created_at)
      VALUES (?, ?, ?, 'a4', 'standard', 'portrait', NULL, 'none', ?)`)
      .run(selection.templateId, selection.version, selection.packageHash, "2026-01-01T00:00:00.000Z");
    return selection;
  }

  async function setup() {
    directory = await mkdtemp(join(tmpdir(), "tcgprint-project-template-"));
    database = openProjectDatabase(join(directory, "projects.sqlite"));
    let projectId = 0;
    return new ProjectRepository(database, { idFactory: () => `project-${++projectId}` });
  }

  it("persists an exact template ID, version, and package hash and rejects a mismatched hash", async () => {
    const projects = await setup();
    const v5 = seedTemplateVersion("5", "5");
    const project = projects.create(undefined, v5);

    expect(projects.open(project.id).templateSelection).toEqual(v5);
    expect(() => projects.save(project.id, 1, project.snapshot, { ...v5, packageHash: "f".repeat(64) }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_TEMPLATE_NOT_FOUND" }));
    expect(projects.open(project.id).templateSelection).toEqual(v5);
  });

  it("keeps v5 on existing Projects when v6 is added and copies the association on duplicate", async () => {
    const projects = await setup();
    const v5 = seedTemplateVersion("5", "5");
    const original = projects.create(undefined, v5);
    seedTemplateVersion("6", "6");

    const duplicate = projects.duplicate(original.id);

    expect(projects.open(original.id).templateSelection).toEqual(v5);
    expect(duplicate.templateSelection).toEqual(v5);
  });

  it("reopens canonical and recovery selections from SQLite without changing either package hash", async () => {
    const projects = await setup();
    const v5 = seedTemplateVersion("5", "5");
    const v6 = seedTemplateVersion("6", "6");
    const canonical = projects.create(undefined, v5);
    projects.stageRecovery(canonical.id, canonical.revision, canonical.snapshot, v6);

    database!.close();
    database = openProjectDatabase(join(directory!, "projects.sqlite"));
    const reopened = new ProjectRepository(database, { idFactory: () => "unused" });

    expect(reopened.open(canonical.id).templateSelection).toEqual(v5);
    expect(reopened.readRecovery(canonical.id)?.templateSelection).toEqual(v6);
    expect(reopened.promoteRecovery(canonical.id).templateSelection).toEqual(v6);
  });

  it("persists and promotes a recovery selection and copies a stale recovery selection", async () => {
    const projects = await setup();
    const v5 = seedTemplateVersion("5", "5");
    const v6 = seedTemplateVersion("6", "6");
    const canonical = projects.create(undefined, v5);
    projects.stageRecovery(canonical.id, canonical.revision, canonical.snapshot, v6);

    expect(projects.readRecovery(canonical.id)?.templateSelection).toEqual(v6);
    const promoted = projects.promoteRecovery(canonical.id);
    expect(promoted.templateSelection).toEqual(v6);

    projects.stageRecovery(canonical.id, promoted.revision, canonical.snapshot, v5);
    const newer = projects.save(canonical.id, promoted.revision, promoted.snapshot, v6);
    expect(() => projects.promoteRecovery(canonical.id)).toThrowError(expect.objectContaining({ code: "PROJECT_REVISION_CONFLICT" }));
    const copy = projects.copyRecovery(canonical.id);
    expect(newer.templateSelection).toEqual(v6);
    expect(copy.templateSelection).toEqual(v5);
  });
});
