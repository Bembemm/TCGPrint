import type { WorkingCard } from "../../core/cards/types";
import type { ProjectDto, ProjectSummaryDto } from "../../services/project-api";
import { serializeProjectSnapshot, type ProjectSettingsV1, type ProjectSnapshotV1 } from "../../persistence/projects/serializer";

export type ProjectSaveStatus = "Dirty" | "Salvando" | "Salvo" | "Erro";

export interface ProjectSessionState {
  readonly projects: readonly ProjectSummaryDto[];
  readonly activeProject: ProjectDto | null;
  readonly currentSnapshotKey: string | null;
  readonly savedSnapshotKey: string | null;
  readonly saving: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly snapshotKey: string | null;
  } | null;
  readonly saveError: {
    readonly projectId: string;
    readonly snapshotKey: string | null;
    readonly message: string;
  } | null;
  readonly status: ProjectSaveStatus;
  readonly error?: string;
}

export type ProjectSessionAction =
  | { readonly type: "projects-loaded"; readonly projects: readonly ProjectSummaryDto[] }
  | { readonly type: "activate-project"; readonly project: ProjectDto; readonly currentSnapshotKey: string | null }
  | { readonly type: "content-changed"; readonly snapshotKey: string | null }
  | { readonly type: "save-started"; readonly projectId: string; readonly expectedRevision: number; readonly snapshotKey: string | null }
  | { readonly type: "save-succeeded"; readonly projectId: string; readonly expectedRevision: number; readonly project: ProjectDto; readonly snapshotKey: string }
  | { readonly type: "save-failed"; readonly projectId: string; readonly expectedRevision: number; readonly snapshotKey: string | null; readonly message: string }
  | { readonly type: "project-duplicated"; readonly project: ProjectDto }
  | { readonly type: "project-deleted"; readonly projectId: string }
  | { readonly type: "request-failed"; readonly message: string };

function summary(project: ProjectDto): ProjectSummaryDto {
  const { snapshot: _snapshot, ...metadata } = project;
  return metadata;
}

function withProjectSummary(projects: readonly ProjectSummaryDto[], project: ProjectDto): ProjectSummaryDto[] {
  const next = projects.filter(({ id }) => id !== project.id);
  return [summary(project), ...next];
}

function withStatus(state: Omit<ProjectSessionState, "status">): ProjectSessionState {
  const { activeProject, currentSnapshotKey, savedSnapshotKey, saving, saveError } = state;
  const status: ProjectSaveStatus = saving
    ? "Salvando"
    : saveError !== null && saveError.projectId === activeProject?.id
      ? "Erro"
      : savedSnapshotKey !== null && currentSnapshotKey === savedSnapshotKey
        ? "Salvo"
        : "Dirty";
  return { ...state, status };
}

export function createProjectSessionState(currentSnapshotKey: string | null): ProjectSessionState {
  return withStatus({
    projects: [],
    activeProject: null,
    currentSnapshotKey,
    savedSnapshotKey: null,
    saving: null,
    saveError: null,
  });
}

export function projectSnapshotKey(cards: readonly WorkingCard[], settings: ProjectSettingsV1): string {
  return serializeProjectSnapshot(cards, settings);
}

export function projectSnapshotValue(snapshot: ProjectSnapshotV1): string {
  return serializeProjectSnapshot(snapshot.cards, snapshot.settings);
}

export function projectSessionReducer(state: ProjectSessionState, action: ProjectSessionAction): ProjectSessionState {
  switch (action.type) {
    case "projects-loaded":
      return { ...state, projects: [...action.projects], error: undefined };
    case "activate-project": {
      const savedSnapshotKey = projectSnapshotValue(action.project.snapshot);
      return withStatus({
        ...state,
        projects: withProjectSummary(state.projects, action.project),
        activeProject: action.project,
        currentSnapshotKey: action.currentSnapshotKey,
        savedSnapshotKey,
        saving: null,
        saveError: null,
        error: undefined,
      });
    }
    case "content-changed":
      return withStatus({
        ...state,
        currentSnapshotKey: action.snapshotKey,
        ...(state.saveError && state.saveError.snapshotKey !== action.snapshotKey
          ? { saveError: null, error: undefined }
          : {}),
      });
    case "save-started":
      if (state.activeProject?.id !== action.projectId || state.activeProject.revision !== action.expectedRevision) return state;
      return withStatus({
        ...state,
        saving: { projectId: action.projectId, expectedRevision: action.expectedRevision, snapshotKey: action.snapshotKey },
        saveError: null,
        error: undefined,
      });
    case "save-succeeded":
      if (state.activeProject?.id !== action.projectId
        || state.activeProject.revision !== action.expectedRevision
        || state.saving?.projectId !== action.projectId
        || state.saving.expectedRevision !== action.expectedRevision) return state;
      return withStatus({
        ...state,
        projects: withProjectSummary(state.projects, action.project),
        activeProject: action.project,
        savedSnapshotKey: action.snapshotKey,
        saving: null,
        saveError: null,
        error: undefined,
      });
    case "save-failed":
      if (state.activeProject?.id !== action.projectId
        || state.activeProject.revision !== action.expectedRevision
        || state.saving?.projectId !== action.projectId
        || state.saving.expectedRevision !== action.expectedRevision) return state;
      return withStatus({
        ...state,
        saving: null,
        saveError: { projectId: action.projectId, snapshotKey: action.snapshotKey, message: action.message },
        error: action.message,
      });
    case "project-duplicated":
      return { ...state, projects: withProjectSummary(state.projects, action.project), error: undefined };
    case "project-deleted": {
      const projects = state.projects.filter(({ id }) => id !== action.projectId);
      if (state.activeProject?.id !== action.projectId) return { ...state, projects, error: undefined };
      return withStatus({
        ...state,
        projects,
        activeProject: null,
        savedSnapshotKey: null,
        saving: null,
        saveError: null,
        error: undefined,
      });
    }
    case "request-failed":
      return { ...state, error: action.message };
  }
}
