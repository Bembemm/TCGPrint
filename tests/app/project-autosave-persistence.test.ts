import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import type { ProjectDto, ProjectOpenDto } from "../../services/project-api";
import { saveProjectWithRecovery } from "../../src/app/project-autosave-persistence";

function project(revision: number, bleedMm: number): ProjectDto {
  return {
    id: "project-1",
    name: "Project teste",
    projectSchemaVersion: 1,
    revision,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      projectSchemaVersion: 1,
      cards: [],
      settings: { ...DEFAULT_PROJECT_SETTINGS, bleedMm },
    },
  };
}

describe("saveProjectWithRecovery", () => {
  it("reconciles a lost promotion response by reading the committed canonical snapshot", async () => {
    const snapshot = project(1, 2).snapshot;
    const open = vi.fn(async () => ({ ...project(2, 2), recovery: null }) satisfies ProjectOpenDto);
    const api = {
      stageRecovery: vi.fn(async () => ({ recovery: {} as never })),
      promoteRecovery: vi.fn(async () => { throw new TypeError("connection reset after commit"); }),
      open,
    };

    const saved = await saveProjectWithRecovery(api, "project-1", 1, snapshot);

    expect(saved).toMatchObject({ revision: 2, snapshot });
    expect(api.stageRecovery).toHaveBeenCalledWith("project-1", 1, snapshot);
    expect(api.promoteRecovery).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("project-1");
  });

  it("keeps the promotion failure when the canonical Project does not contain the candidate", async () => {
    const promotionError = new TypeError("connection reset before commit");
    const api = {
      stageRecovery: vi.fn(async () => ({ recovery: {} as never })),
      promoteRecovery: vi.fn(async () => { throw promotionError; }),
      open: vi.fn(async () => ({ ...project(1, 1), recovery: null }) satisfies ProjectOpenDto),
    };

    await expect(saveProjectWithRecovery(api, "project-1", 1, project(1, 2).snapshot)).rejects.toBe(promotionError);
  });

  it("reconciles a prior committed save when a retry hits the old revision during staging", async () => {
    const snapshot = project(1, 2).snapshot;
    const api = {
      stageRecovery: vi.fn(async () => { throw Object.assign(new Error("revision conflict"), { status: 409 }); }),
      promoteRecovery: vi.fn(async () => project(3, 2)),
      open: vi.fn(async () => ({ ...project(2, 2), recovery: null }) satisfies ProjectOpenDto),
    };

    const saved = await saveProjectWithRecovery(api, "project-1", 1, snapshot);

    expect(saved).toMatchObject({ revision: 2, snapshot });
    expect(api.promoteRecovery).not.toHaveBeenCalled();
    expect(api.open).toHaveBeenCalledWith("project-1");
  });
});
