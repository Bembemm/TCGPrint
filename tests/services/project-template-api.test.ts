import { afterEach, describe, expect, it } from "vitest";
import { openProjectDatabase } from "../../persistence/projects/database";
import { ProjectRepository } from "../../persistence/projects/repository";
import {
  DEFAULT_PROJECT_SETTINGS,
  type ProjectSnapshotV1,
} from "../../persistence/projects/serializer";
import {
  handleProjectCreate,
  handleProjectDuplicate,
  handleProjectOpen,
  handleProjectPromoteRecovery,
  handleProjectSave,
  handleProjectStageRecovery,
} from "../../services/project-api";
import type { TemplateSelection } from "../../templates/types";

describe("Project template API persistence", () => {
  let database: ReturnType<typeof openProjectDatabase> | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function setup() {
    database = openProjectDatabase(":memory:");
    const projects = new ProjectRepository(database, { idFactory: (() => { let id = 0; return () => `project-${++id}`; })() });
    for (const [version, digit] of [["5", "5"], ["6", "6"]] as const) {
      database.prepare("INSERT OR IGNORE INTO templates (id, name, source, created_at, updated_at) VALUES ('template-a4', 'Alan A4', 'Local', ?, ?)")
        .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      database.prepare(`INSERT INTO template_versions
        (template_id, version, package_hash, paper, card_format, orientation, recommended_bleed_mm, registration_type, created_at)
        VALUES ('template-a4', ?, ?, 'a4', 'standard', 'portrait', 0.625, 'three-point', ?)`)
        .run(version, digit.repeat(64), "2026-01-01T00:00:00.000Z");
    }
    return {
      projects,
      v5: { templateId: "template-a4", version: "5", packageHash: "5".repeat(64) } satisfies TemplateSelection,
      v6: { templateId: "template-a4", version: "6", packageHash: "6".repeat(64) } satisfies TemplateSelection,
    };
  }

  function request(method: string, body?: unknown): Request {
    return new Request("http://localhost/api/projects/project-1", {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  it("keeps a v5 autosave exact through API reopen, recovery promotion, and duplicate", async () => {
    const { projects, v5, v6 } = setup();
    const createdResponse = await handleProjectCreate(request("POST", { templateSelection: v5 }), projects);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; revision: number; templateSelection: TemplateSelection };
    expect(created.templateSelection).toEqual(v5);

    const snapshot: ProjectSnapshotV1 = {
      projectSchemaVersion: 1,
      cards: [],
      settings: { ...DEFAULT_PROJECT_SETTINGS, bleedMm: 1.25 },
    };
    const savedResponse = await handleProjectSave(request("PUT", { expectedRevision: 1, snapshot, templateSelection: v5 }), created.id, projects);
    expect(savedResponse.status).toBe(200);
    expect(await savedResponse.json()).toMatchObject({ revision: 2, templateSelection: v5 });
    expect(await (await handleProjectOpen(request("GET"), created.id, projects)).json()).toMatchObject({ templateSelection: v5 });

    const stagedResponse = await handleProjectStageRecovery(request("POST", { expectedRevision: 2, snapshot, templateSelection: v6 }), created.id, projects);
    expect(await stagedResponse.json()).toMatchObject({ recovery: { templateSelection: v6 } });
    expect(projects.open(created.id).templateSelection).toEqual(v5);
    expect(await (await handleProjectOpen(request("GET"), created.id, projects)).json()).toMatchObject({ recovery: { templateSelection: v6 } });

    const promotedResponse = await handleProjectPromoteRecovery(request("POST"), created.id, projects);
    expect(await promotedResponse.json()).toMatchObject({ revision: 3, templateSelection: v6 });
    const duplicateResponse = await handleProjectDuplicate(request("POST"), created.id, projects);
    expect(await duplicateResponse.json()).toMatchObject({ templateSelection: v6 });
  });

  it("rejects an unknown or hash-mismatched selection without changing the Project", async () => {
    const { projects, v5 } = setup();
    const created = projects.create();
    const response = await handleProjectSave(request("PUT", {
      expectedRevision: 1,
      snapshot: created.snapshot,
      templateSelection: { ...v5, packageHash: "f".repeat(64) },
    }), created.id, projects);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "PROJECT_TEMPLATE_NOT_FOUND" });
    expect(projects.open(created.id)).toMatchObject({ revision: 1, templateSelection: null });
  });
});
