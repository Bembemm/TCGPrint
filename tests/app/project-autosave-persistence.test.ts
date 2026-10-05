import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import type { ProjectDto, ProjectOpenDto } from "../../services/project-api";
import type { WorkingCard } from "../../core/cards/types";
import { createPhysicalOrder } from "../../core/cards/physical-instance-order";
import { saveProjectWithRecovery } from "../../src/app/project-autosave-persistence";

function project(revision: number, bleedMm: number): ProjectDto {
  return {
    id: "project-1",
    name: "Project teste",
    projectSchemaVersion: 2,
    revision,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    templateSelection: null,
    snapshot: {
      projectSchemaVersion: 2,
      cards: [],
      settings: { ...DEFAULT_PROJECT_SETTINGS, bleedMm },
      physicalOrder: createPhysicalOrder([]),
    },
  };
}

describe("saveProjectWithRecovery", () => {
  it("reconciles a lost promotion response by reading the committed canonical snapshot", async () => {
    const state = { snapshot: project(1, 2).snapshot, templateSelection: null };
    const open = vi.fn(async () => ({ ...project(2, 2), recovery: null }) satisfies ProjectOpenDto);
    const api = {
      stageRecovery: vi.fn(async () => ({ recovery: {} as never })),
      promoteRecovery: vi.fn(async () => { throw new TypeError("connection reset after commit"); }),
      open,
    };

    const saved = await saveProjectWithRecovery(api, "project-1", 1, state);

    expect(saved).toMatchObject({ revision: 2, snapshot: state.snapshot });
    expect(api.stageRecovery).toHaveBeenCalledWith("project-1", 1, state.snapshot, null);
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

    await expect(saveProjectWithRecovery(api, "project-1", 1, { snapshot: project(1, 2).snapshot, templateSelection: null })).rejects.toBe(promotionError);
  });

  it("reconciles a prior committed save when a retry hits the old revision during staging", async () => {
    const state = { snapshot: project(1, 2).snapshot, templateSelection: null };
    const api = {
      stageRecovery: vi.fn(async () => { throw Object.assign(new Error("revision conflict"), { status: 409 }); }),
      promoteRecovery: vi.fn(async () => project(3, 2)),
      open: vi.fn(async () => ({ ...project(2, 2), recovery: null }) satisfies ProjectOpenDto),
    };

    const saved = await saveProjectWithRecovery(api, "project-1", 1, state);

    expect(saved).toMatchObject({ revision: 2, snapshot: state.snapshot });
    expect(api.promoteRecovery).not.toHaveBeenCalled();
    expect(api.open).toHaveBeenCalledWith("project-1");
  });

  it("stages and promotes the exact manual physical back selection in the autosaved snapshot", async () => {
    const manualBackArtwork = {
      candidateId: `upload:${"a".repeat(64)}`, source: "upload" as const, identityId: null,
      faceId: "front", providerAssetId: "validated-original", selectionPolicy: "user-selected",
    };
    const card: WorkingCard = {
      id: "simple-with-manual-back", quantity: 1, order: 0,
      importSource: { sourceId: "source", importKind: "fixture", entryKind: "card" },
      identityHints: { name: "Simple" }, identity: null,
      identityResolution: { status: "unresolved", candidates: [], confirmed: false },
      faces: [{ id: "front", side: "front" }], selectedArtworkByFace: {},
      backMode: "manual", backModeSelectionPolicy: "explicit", manualBackArtwork,
      localArtworkIds: [], mpcReferences: [], faceAssociations: [],
    };
    const state = {
      snapshot: { ...project(1, 2).snapshot, cards: [card], physicalOrder: createPhysicalOrder([card]) },
      templateSelection: null,
    };
    const api = {
      stageRecovery: vi.fn(async () => ({ recovery: {} as never })),
      promoteRecovery: vi.fn(async () => ({ ...project(2, 2), snapshot: state.snapshot })),
      open: vi.fn(),
    };

    const saved = await saveProjectWithRecovery(api, "project-1", 1, state);

    expect(api.stageRecovery).toHaveBeenCalledWith("project-1", 1, state.snapshot, null);
    expect(saved.snapshot.cards[0]?.manualBackArtwork).toEqual(manualBackArtwork);
    expect(saved.snapshot.cards[0]?.backModeSelectionPolicy).toBe("explicit");
  });
});
