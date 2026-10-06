import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS, type ProjectSnapshotV1 } from "../../persistence/projects/serializer";
import type { ProjectDto, ProjectSummaryDto } from "../../services/project-api";
import {
  createProjectSessionState,
  projectSessionReducer,
  createNewProjectDocument,
  projectSnapshotKey,
  projectSnapshotValue,
} from "../../src/app/project-session";
import type { WorkingCard } from "../../core/cards/types";
import { createPhysicalOrder } from "../../core/cards/physical-instance-order";

function emptySnapshot(): ProjectSnapshotV1 {
  return { projectSchemaVersion: 6, cards: [], settings: DEFAULT_PROJECT_SETTINGS, physicalOrder: createPhysicalOrder([]) };
}

function project(id: string, revision = 1, snapshot = emptySnapshot()): ProjectDto {
  return {
    id,
    name: "Novo projeto",
    projectSchemaVersion: 2,
    revision,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    snapshot,
    templateSelection: null,
  };
}

function summary(value: ProjectDto): ProjectSummaryDto {
  const { snapshot: _snapshot, templateSelection: _templateSelection, ...metadata } = value;
  return metadata;
}

describe("Project autosave snapshot identity", () => {
  it("includes template ID, version, and package hash in the dirty-state key", () => {
    const snapshot = emptySnapshot();
    const v5 = { templateId: "template-a4", version: "5", packageHash: "5".repeat(64) };
    const v6 = { templateId: "template-a4", version: "6", packageHash: "6".repeat(64) };

    expect(projectSnapshotValue(snapshot, v5)).not.toBe(projectSnapshotValue(snapshot, v6));
    expect(projectSnapshotValue(snapshot, v5)).not.toBe(projectSnapshotValue(snapshot, { ...v5, packageHash: "f".repeat(64) }));
    expect(projectSnapshotKey([], DEFAULT_PROJECT_SETTINGS, v5)).not.toBe(projectSnapshotKey([], DEFAULT_PROJECT_SETTINGS, null));
  });
});

describe("new Project creation snapshot", () => {
  it("starts from product defaults without inheriting template or Working Set content", () => {
    const document = createNewProjectDocument();

    expect(document.snapshot.cards).toEqual([]);
    expect(document.snapshot.settings).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(document.snapshot.physicalOrder).toEqual({ nextInstanceId: 1, instances: [] });
    expect(document.templateSelection).toBeNull();
  });
});

function card(id: string, order: number): WorkingCard {
  return {
    id,
    quantity: 1,
    order,
    importSource: { sourceId: "source", importKind: "text", entryKind: "card" },
    identityHints: { name: id },
    identity: null,
    identityResolution: { status: "unresolved", candidates: [], confirmed: false },
    faces: [{ id: "front", side: "front", name: id }, { id: "back", side: "back", name: `${id} back` }],
    selectedArtworkByFace: {},
    backMode: "project-default",
    backModeSelectionPolicy: "automatic",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  };
}

describe("project session", () => {
  it("keeps selection and visual face changes out of the persisted dirty state", () => {
    const cards = [card("first", 9), card("second", 3)];
    const key = projectSnapshotKey(cards, DEFAULT_PROJECT_SETTINGS);
    const saved = project("project-1", 1, { projectSchemaVersion: 6, cards, settings: DEFAULT_PROJECT_SETTINGS, physicalOrder: createPhysicalOrder(cards) });
    const state = projectSessionReducer(createProjectSessionState(key), {
      type: "activate-project",
      project: saved,
      currentSnapshotKey: key,
    });

    expect(state.status).toBe("Salvo");
    expect(projectSnapshotKey(cards, DEFAULT_PROJECT_SETTINGS)).toBe(key);
    expect(projectSessionReducer(state, { type: "content-changed", snapshotKey: key }).status).toBe("Salvo");
  });

  it("moves through Dirty, Salvando and Salvo while only a successful CAS updates revision", () => {
    const initial = project("project-1");
    const activated = projectSessionReducer(createProjectSessionState("empty"), {
      type: "activate-project",
      project: initial,
      currentSnapshotKey: "empty",
    });
    const dirty = projectSessionReducer(activated, { type: "content-changed", snapshotKey: "changed" });
    const saving = projectSessionReducer(dirty, {
      type: "save-started",
      projectId: "project-1",
      expectedRevision: 1,
      snapshotKey: "changed",
    });
    const saved = projectSessionReducer(saving, {
      type: "save-succeeded",
      projectId: "project-1",
      expectedRevision: 1,
      project: project("project-1", 2, { projectSchemaVersion: 6, cards: [], settings: DEFAULT_PROJECT_SETTINGS, physicalOrder: createPhysicalOrder([]) }),
      snapshotKey: "changed",
    });

    expect(dirty.status).toBe("Dirty");
    expect(saving.status).toBe("Salvando");
    expect(saving.activeProject?.revision).toBe(1);
    expect(saved.status).toBe("Salvo");
    expect(saved.activeProject?.revision).toBe(2);
  });

  it("shows Erro without advancing revision after a failed save, then Dirty after another edit", () => {
    const activated = projectSessionReducer(createProjectSessionState("empty"), {
      type: "activate-project",
      project: project("project-1", 7),
      currentSnapshotKey: "empty",
    });
    const dirty = projectSessionReducer(activated, { type: "content-changed", snapshotKey: "changed" });
    const saving = projectSessionReducer(dirty, {
      type: "save-started",
      projectId: "project-1",
      expectedRevision: 7,
      snapshotKey: "changed",
    });
    const failed = projectSessionReducer(saving, {
      type: "save-failed",
      projectId: "project-1",
      expectedRevision: 7,
      snapshotKey: "changed",
      message: "Project revision conflict.",
    });
    const edited = projectSessionReducer(failed, { type: "content-changed", snapshotKey: "newer-local-content" });

    expect(failed.status).toBe("Erro");
    expect(failed.activeProject?.revision).toBe(7);
    expect(failed.error).toBe("Project revision conflict.");
    expect(edited.status).toBe("Dirty");
    expect(edited.activeProject?.revision).toBe(7);
  });

  it("shows Erro when content changes while a save request is pending and that request fails", () => {
    const activated = projectSessionReducer(createProjectSessionState("saved"), {
      type: "activate-project",
      project: project("project-1", 7),
      currentSnapshotKey: "saved",
    });
    const saving = projectSessionReducer(
      projectSessionReducer(activated, { type: "content-changed", snapshotKey: "request-snapshot" }),
      { type: "save-started", projectId: "project-1", expectedRevision: 7, snapshotKey: "request-snapshot" },
    );
    const editedWhileSaving = projectSessionReducer(saving, { type: "content-changed", snapshotKey: "newer-local-snapshot" });
    const failed = projectSessionReducer(editedWhileSaving, {
      type: "save-failed",
      projectId: "project-1",
      expectedRevision: 7,
      snapshotKey: "request-snapshot",
      message: "Request failed.",
    });

    expect(failed.status).toBe("Erro");
    expect(failed.activeProject?.revision).toBe(7);
    expect(failed.savedSnapshotKey).toBe(activated.savedSnapshotKey);
  });

  it("shows Conflito after a stale revision and keeps the conflict visible while local edits continue", () => {
    const activated = projectSessionReducer(createProjectSessionState("saved"), {
      type: "activate-project",
      project: project("project-1", 7),
      currentSnapshotKey: "saved",
    });
    const saving = projectSessionReducer(activated, { type: "save-started", projectId: "project-1", expectedRevision: 7, snapshotKey: "local-copy" });
    const conflict = projectSessionReducer(saving, {
      type: "save-failed",
      projectId: "project-1",
      expectedRevision: 7,
      snapshotKey: "local-copy",
      message: "Project revision conflict.",
      conflict: true,
    });

    const edited = projectSessionReducer(conflict, { type: "content-changed", snapshotKey: "newer-local-copy" });

    expect(conflict.status).toBe("Conflito");
    expect(conflict.activeProject?.revision).toBe(7);
    expect(edited.status).toBe("Conflito");
    expect(edited.activeProject?.revision).toBe(7);
    expect(edited.error).toBe("Project revision conflict.");
  });

  it("keeps the local snapshot marked conflicted when a failed operation discovers a newer canonical Project", () => {
    const local = projectSessionReducer(createProjectSessionState("local-snapshot"), {
      type: "activate-project",
      project: project("project-1", 7),
      currentSnapshotKey: "local-snapshot",
    });
    const conflicted = projectSessionReducer(local, {
      type: "revision-conflict",
      project: project("project-1", 8, { ...emptySnapshot(), settings: { ...DEFAULT_PROJECT_SETTINGS, bleedMm: 2 } }),
      currentSnapshotKey: "local-snapshot",
      message: "The canonical Project changed while the local copy was open.",
    });

    expect(conflicted.status).toBe("Conflito");
    expect(conflicted.activeProject?.revision).toBe(8);
    expect(conflicted.currentSnapshotKey).toBe("local-snapshot");
    expect(conflicted.savedSnapshotKey).toBe(projectSnapshotKey([], { ...DEFAULT_PROJECT_SETTINGS, bleedMm: 2 }));
  });

  it("keeps an inactive delete away from the active session and leaves no invented project after active delete", () => {
    const active = project("active");
    const inactive = project("inactive");
    const activated = projectSessionReducer(createProjectSessionState("local"), {
      type: "activate-project",
      project: active,
      currentSnapshotKey: "local",
    });
    const bothListed = projectSessionReducer(activated, { type: "projects-loaded", projects: [summary(active), summary(inactive)] });
    const inactiveDeleted = projectSessionReducer(bothListed, { type: "project-deleted", projectId: "inactive" });
    const activeDeleted = projectSessionReducer(inactiveDeleted, { type: "project-deleted", projectId: "active" });

    expect(inactiveDeleted.activeProject?.id).toBe("active");
    expect(inactiveDeleted.currentSnapshotKey).toBe("local");
    expect(activeDeleted.activeProject).toBeNull();
    expect(activeDeleted.projects).toEqual([]);
    expect(activeDeleted.currentSnapshotKey).toBe("local");
    expect(activeDeleted.status).toBe("Dirty");
  });

  it("keeps the current Working Set when activating a new empty revision-one project and duplicating", () => {
    const created = project("new-project");
    const activated = projectSessionReducer(createProjectSessionState("current-working-set"), {
      type: "activate-project",
      project: created,
      currentSnapshotKey: "current-working-set",
    });
    const duplicated = projectSessionReducer(activated, { type: "project-duplicated", project: project("new-copy") });

    expect(activated.activeProject?.revision).toBe(1);
    expect(activated.activeProject?.snapshot.cards).toEqual([]);
    expect(activated.status).toBe("Dirty");
    expect(duplicated.activeProject?.id).toBe("new-project");
    expect(duplicated.projects.map(({ id }) => id)).toEqual(["new-copy", "new-project"]);
    expect(duplicated.currentSnapshotKey).toBe("current-working-set");
  });
});
