import type { WorkingCard } from "../../core/cards/types";
import type { ProjectDto, ProjectSaveState, ProjectSummaryDto } from "../../services/project-api";
import { serializeProjectSnapshot, type ProjectSettingsV1, type ProjectSnapshotV1 } from "../../persistence/projects/serializer";
import type { TemplateSelection } from "../../templates/types";

export type ProjectSaveStatus = "Dirty" | "Salvando" | "Salvo" | "Erro" | "Conflito";

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
    readonly conflict: boolean;
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
  | { readonly type: "save-failed"; readonly projectId: string; readonly expectedRevision: number; readonly snapshotKey: string | null; readonly message: string; readonly conflict?: boolean }
  | { readonly type: "revision-conflict"; readonly project: ProjectDto; readonly currentSnapshotKey: string | null; readonly message: string }
  | { readonly type: "project-duplicated"; readonly project: ProjectDto }
  | { readonly type: "project-deleted"; readonly projectId: string }
  | { readonly type: "request-failed"; readonly message: string };

function summary(project: ProjectDto): ProjectSummaryDto {
  const { snapshot: _snapshot, templateSelection: _templateSelection, ...metadata } = project;
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
      ? saveError.conflict ? "Conflito" : "Erro"
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

export function projectSnapshotDocument(
  cards: readonly WorkingCard[],
  settings: ProjectSettingsV1,
  templateSelection: TemplateSelection | null = null,
): ProjectSaveState {
  const snapshotJson = serializeProjectSnapshot(cards, settings);
  return { snapshot: JSON.parse(snapshotJson) as ProjectSnapshotV1, templateSelection };
}

export function projectSnapshotKey(
  cards: readonly WorkingCard[],
  settings: ProjectSettingsV1,
  templateSelection: TemplateSelection | null = null,
): string {
  return projectSaveStateValue(projectSnapshotDocument(cards, settings, templateSelection));
}

export function projectSnapshotValue(snapshot: ProjectSnapshotV1, templateSelection: TemplateSelection | null = null): string {
  return projectSaveStateValue({ snapshot, templateSelection });
}

export function projectSaveStateValue(state: ProjectSaveState): string {
  return JSON.stringify({ snapshot: JSON.parse(serializeProjectSnapshot(state.snapshot.cards, state.snapshot.settings)), templateSelection: state.templateSelection });
}

export function projectSessionReducer(state: ProjectSessionState, action: ProjectSessionAction): ProjectSessionState {
  switch (action.type) {
    case "projects-loaded":
      return { ...state, projects: [...action.projects], error: undefined };
    case "activate-project": {
      const savedSnapshotKey = projectSnapshotValue(action.project.snapshot, action.project.templateSelection);
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
        ...(state.saveError && !state.saveError.conflict && state.saveError.snapshotKey !== action.snapshotKey
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
        saveError: { projectId: action.projectId, snapshotKey: action.snapshotKey, message: action.message, conflict: action.conflict === true },
        error: action.message,
      });
    case "revision-conflict":
      return withStatus({
        ...state,
        projects: withProjectSummary(state.projects, action.project),
        activeProject: action.project,
        currentSnapshotKey: action.currentSnapshotKey,
        savedSnapshotKey: projectSnapshotValue(action.project.snapshot, action.project.templateSelection),
        saving: null,
        saveError: {
          projectId: action.project.id,
          snapshotKey: action.currentSnapshotKey,
          message: action.message,
          conflict: true,
        },
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
