import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import ProjectsPanel from "../../src/app/projects-panel";
import { resolveProjectRecoveryChoice } from "../../src/app/project-recovery-decision";
import { createProjectOpenInteractionLock, resolveProjectRecoveryWithInteractionLock } from "../../src/app/project-interaction-lock";
import type { ProjectDto, ProjectOpenDto } from "../../services/project-api";
import { createPhysicalOrder } from "../../core/cards/physical-instance-order";

function emptySnapshot() {
  return { projectSchemaVersion: 6, cards: [], settings: DEFAULT_PROJECT_SETTINGS, physicalOrder: createPhysicalOrder([]) };
}

function project(id: string, revision: number): ProjectDto {
  return {
    id,
    name: "Project teste",
    projectSchemaVersion: 2,
    revision,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    snapshot: emptySnapshot(),
    templateSelection: null,
  };
}

describe("Projects panel", () => {
  it("shows the empty Project controls and the initial unsaved session state", () => {
    const markup = renderToStaticMarkup(createElement(ProjectsPanel, {
      cards: [],
      settings: DEFAULT_PROJECT_SETTINGS,
      onProjectOpen: vi.fn(),
      selectedCutPageNumber: 1,
      onCutPageNumberChange: vi.fn(),
      disabled: false,
    }));

    expect(markup).toContain('aria-label="Projects"');
    expect(markup).toContain("Criar Project vazio");
    expect(markup).toContain("Silhouette Template Library");
    expect(markup).toContain(".studio3, .dxf, .svg, .json, .zip");
    expect(markup).toContain("Salvar");
    expect(markup).toContain("Dirty");
    expect(markup).toContain("Nenhum Project aberto");
  });

  it("promotes or discards recovery based on the current canonical revision", async () => {
    const canonical = project("project-1", 4);
    const opened: ProjectOpenDto = {
      ...canonical,
      recovery: {
        baseRevision: 4,
        projectSchemaVersion: 2,
        snapshot: emptySnapshot(),
        templateSelection: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    };
    const api = {
      open: vi.fn(async () => ({ ...canonical, recovery: null }) satisfies ProjectOpenDto),
      promoteRecovery: vi.fn(async () => project("project-1", 5)),
      discardRecovery: vi.fn(async () => ({ discarded: true as const, id: "project-1" })),
      copyRecovery: vi.fn(async () => project("project-copy", 1)),
    };

    const recovered = await resolveProjectRecoveryChoice(opened, "restore", api);
    const canonicalAfterDiscard = await resolveProjectRecoveryChoice(opened, "discard", api);

    expect(recovered.revision).toBe(5);
    expect(canonicalAfterDiscard).toMatchObject({ id: "project-1", revision: 4 });
    expect(api.promoteRecovery).toHaveBeenCalledTimes(1);
    expect(api.discardRecovery).toHaveBeenCalledTimes(1);
    expect(api.copyRecovery).not.toHaveBeenCalled();
  });

  it.each(["restore", "discard", "copy"] as const)("keeps the interaction lock through %s and releases after loading", async (choice) => {
    const canonical = project("project-1", 4);
    const opened: ProjectOpenDto = {
      ...canonical,
      recovery: {
        baseRevision: choice === "copy" ? 3 : 4,
        projectSchemaVersion: 2,
        snapshot: emptySnapshot(),
        templateSelection: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    };
    const api = {
      open: vi.fn(async () => ({ ...canonical, recovery: null }) satisfies ProjectOpenDto),
      promoteRecovery: vi.fn(async () => project("project-1", 5)),
      discardRecovery: vi.fn(async () => ({ discarded: true as const, id: "project-1" })),
      copyRecovery: vi.fn(async () => project("project-copy", 1)),
    };
    const lock = createProjectOpenInteractionLock(vi.fn());
    const loaded: ProjectDto[] = [];
    lock.beginOpen();
    lock.recoveryFound();
    lock.finishOpenRequest();

    const result = await resolveProjectRecoveryWithInteractionLock(
      lock,
      () => resolveProjectRecoveryChoice(opened, choice, api),
      (projectToLoad) => {
        expect(lock.isLocked()).toBe(true);
        loaded.push(projectToLoad);
      },
    );

    expect(loaded).toEqual([result]);
    expect(lock.isLocked()).toBe(false);
    if (choice === "restore") expect(result.revision).toBe(5);
    if (choice === "discard") expect(result.revision).toBe(4);
    if (choice === "copy") expect(result.id).toBe("project-copy");
  });

  it("copies or discards a stale recovery without replacing it with the stale canonical revision", async () => {
    const opened: ProjectOpenDto = {
      ...project("project-1", 6),
      recovery: {
        baseRevision: 4,
        projectSchemaVersion: 2,
        snapshot: emptySnapshot(),
        templateSelection: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    };
    const api = {
      open: vi.fn(async () => ({ ...project("project-1", 6), recovery: null }) satisfies ProjectOpenDto),
      promoteRecovery: vi.fn(async () => project("project-1", 7)),
      discardRecovery: vi.fn(async () => ({ discarded: true as const, id: "project-1" })),
      copyRecovery: vi.fn(async () => project("recovered-copy", 1)),
    };

    const recoveredCopy = await resolveProjectRecoveryChoice(opened, "copy", api);
    const canonicalAfterDiscard = await resolveProjectRecoveryChoice(opened, "discard", api);

    expect(recoveredCopy).toMatchObject({ id: "recovered-copy", revision: 1 });
    expect(canonicalAfterDiscard).toMatchObject({ id: "project-1", revision: 6 });
    expect(api.promoteRecovery).not.toHaveBeenCalled();
    expect(api.copyRecovery).toHaveBeenCalledTimes(1);
    expect(api.discardRecovery).toHaveBeenCalledTimes(1);
  });

  it("opens the latest canonical revision after discarding a recovery candidate", async () => {
    const opened: ProjectOpenDto = {
      ...project("project-1", 6),
      recovery: {
        baseRevision: 4,
        projectSchemaVersion: 2,
        snapshot: emptySnapshot(),
        templateSelection: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    };
    const api = {
      open: vi.fn(async () => ({ ...project("project-1", 8), recovery: null }) satisfies ProjectOpenDto),
      promoteRecovery: vi.fn(async () => project("project-1", 9)),
      discardRecovery: vi.fn(async () => ({ discarded: true as const, id: "project-1" })),
      copyRecovery: vi.fn(async () => project("recovered-copy", 1)),
    };

    const latest = await resolveProjectRecoveryChoice(opened, "discard", api);

    expect(api.discardRecovery).toHaveBeenCalledTimes(1);
    expect(api.open).toHaveBeenCalledWith("project-1");
    expect(latest.revision).toBe(8);
  });
});
