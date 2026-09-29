"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { WorkingCard } from "../../core/cards/types";
import type { ProjectSettingsV1 } from "../../persistence/projects/serializer";
import { deserializeProjectSnapshot } from "../../persistence/projects/serializer";
import type { ProjectDto } from "../../services/project-api";
import { createProjectApiClient, ProjectApiClientError } from "./project-api-client";
import { createProjectListRequestGuard } from "./project-list-request-guard";
import {
  createProjectSessionState,
  projectSessionReducer,
  projectSnapshotKey,
  projectSnapshotValue,
} from "./project-session";

export interface ProjectsPanelProps {
  readonly cards: readonly WorkingCard[];
  readonly settings: ProjectSettingsV1;
  readonly onProjectOpen: (project: ProjectDto) => void;
  readonly onProjectOpenStart?: () => void;
  readonly onProjectOpenEnd?: () => void;
  readonly disabled?: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof ProjectApiClientError) return error.message;
  return error instanceof Error ? error.message : "A operação de Project falhou.";
}

export default function ProjectsPanel({
  cards,
  settings,
  onProjectOpen,
  onProjectOpenStart,
  onProjectOpenEnd,
  disabled = false,
}: ProjectsPanelProps) {
  const currentSnapshot = useMemo(() => {
    try {
      return { key: projectSnapshotKey(cards, settings), error: undefined };
    } catch (error) {
      return { key: null, error: errorMessage(error) };
    }
  }, [cards, settings]);
  const currentSnapshotKeyRef = useRef(currentSnapshot.key);
  currentSnapshotKeyRef.current = currentSnapshot.key;
  const currentSnapshotErrorRef = useRef(currentSnapshot.error);
  currentSnapshotErrorRef.current = currentSnapshot.error;
  const api = useMemo(() => createProjectApiClient(), []);
  const projectListRequestGuard = useRef(createProjectListRequestGuard());
  const [session, dispatchSession] = useReducer(
    projectSessionReducer,
    currentSnapshot.key,
    createProjectSessionState,
  );
  const [operation, setOperation] = useState<"creating" | "opening" | "duplicating" | "deleting" | null>(null);
  const operationDisabled = disabled || operation !== null || session.saving !== null;

  useEffect(() => {
    dispatchSession({ type: "content-changed", snapshotKey: currentSnapshot.key });
  }, [currentSnapshot.key]);

  const refreshProjects = useCallback(async () => {
    const requestId = projectListRequestGuard.current.begin();
    try {
      const projects = await api.list();
      if (projectListRequestGuard.current.isCurrent(requestId)) {
        dispatchSession({ type: "projects-loaded", projects });
      }
    } catch (error) {
      if (projectListRequestGuard.current.isCurrent(requestId)) {
        dispatchSession({ type: "request-failed", message: errorMessage(error) });
      }
    }
  }, [api, dispatchSession]);

  useEffect(() => {
    void refreshProjects();
    return () => { projectListRequestGuard.current.invalidate(); };
  }, [refreshProjects]);

  async function createProject() {
    if (operationDisabled) return;
    setOperation("creating");
    try {
      const project = await api.create();
      dispatchSession({
        type: "activate-project",
        project,
        currentSnapshotKey: currentSnapshotKeyRef.current,
      });
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function openProject(projectId: string) {
    if (operationDisabled) return;
    setOperation("opening");
    onProjectOpenStart?.();
    try {
      const project = await api.open(projectId);
      const snapshotKey = projectSnapshotValue(project.snapshot);
      onProjectOpen(project);
      dispatchSession({ type: "activate-project", project, currentSnapshotKey: snapshotKey });
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      onProjectOpenEnd?.();
      setOperation(null);
    }
  }

  async function saveProject() {
    const activeProject = session.activeProject;
    if (!activeProject || operationDisabled) return;
    const snapshotKey = currentSnapshotKeyRef.current;
    const projectId = activeProject.id;
    const expectedRevision = activeProject.revision;
    dispatchSession({ type: "save-started", projectId, expectedRevision, snapshotKey });
    try {
      if (snapshotKey === null) {
        throw new Error(currentSnapshotErrorRef.current ?? "O Working Set atual não forma um snapshot válido.");
      }
      const snapshot = deserializeProjectSnapshot(snapshotKey);
      const saved = await api.save(projectId, expectedRevision, snapshot);
      dispatchSession({ type: "save-succeeded", projectId, expectedRevision, project: saved, snapshotKey });
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "save-failed", projectId, expectedRevision, snapshotKey, message: errorMessage(error) });
    }
  }

  async function duplicateProject(projectId: string) {
    if (operationDisabled) return;
    setOperation("duplicating");
    try {
      const project = await api.duplicate(projectId);
      dispatchSession({ type: "project-duplicated", project });
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function deleteProject(projectId: string) {
    if (operationDisabled) return;
    setOperation("deleting");
    try {
      await api.delete(projectId);
      dispatchSession({ type: "project-deleted", projectId });
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  return (
    <section className="panel projects-panel" aria-label="Projects">
      <div className="panel-heading">
        <div>
          <h2>Projects</h2>
          <p>Abra um snapshot salvo ou crie um Project vazio. Salvar é sempre explícito.</p>
        </div>
        <div className="project-save-controls">
          <span className="status" aria-label="Estado do salvamento" aria-live="polite">{session.status}</span>
          <button className="button primary" type="button" onClick={() => void createProject()} disabled={operationDisabled}>
            Criar Project vazio
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => void saveProject()}
            disabled={operationDisabled || !session.activeProject || session.status === "Salvo"}
          >
            Salvar
          </button>
        </div>
      </div>

      {session.activeProject
        ? <p className="project-active-label">Aberto: {session.activeProject.name} · revisão {session.activeProject.revision}</p>
        : <p className="project-active-label">Nenhum Project aberto</p>}

      {session.projects.length > 0 ? <ul className="project-list">
        {session.projects.map((project) => <li className="project-list-row" key={project.id}>
          <div>
            <strong>{project.name}</strong>
            <span>revisão {project.revision} · atualizado em {project.updatedAt}</span>
          </div>
          <div className="project-row-actions">
            <button className="button secondary" type="button" aria-label={`Abrir ${project.name} ${project.id}`} disabled={operationDisabled} onClick={() => void openProject(project.id)}>Abrir</button>
            <button className="button secondary" type="button" aria-label={`Duplicar ${project.name} ${project.id}`} disabled={operationDisabled} onClick={() => void duplicateProject(project.id)}>Duplicar</button>
            <button className="button secondary" type="button" aria-label={`Excluir ${project.name} ${project.id}`} disabled={operationDisabled} onClick={() => void deleteProject(project.id)}>Excluir</button>
          </div>
        </li>)}
      </ul> : <p className="muted">Nenhum Project salvo.</p>}

      {session.error && <p className="error-message" role="alert">{session.error}</p>}
    </section>
  );
}
