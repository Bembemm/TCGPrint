"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { WorkingCard } from "../../core/cards/types";
import { deserializeProjectSnapshot, type ProjectSettingsV1, type ProjectSnapshotV1 } from "../../persistence/projects/serializer";
import type { ProjectDto, ProjectOpenDto } from "../../services/project-api";
import { createProjectApiClient, ProjectApiClientError } from "./project-api-client";
import { createProjectListRequestGuard } from "./project-list-request-guard";
import { ProjectAutosaveQueue } from "./project-autosave";
import { saveProjectWithRecovery } from "./project-autosave-persistence";
import { resolveProjectRecoveryChoice, type ProjectRecoveryChoice } from "./project-recovery-decision";
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
  readonly onProjectInteractionStart?: () => void;
  readonly onProjectInteractionEnd?: () => void;
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
  onProjectInteractionStart,
  onProjectInteractionEnd,
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
  const [recoveryDecision, setRecoveryDecision] = useState<ProjectOpenDto | null>(null);
  const operationDisabled = disabled || operation !== null || session.saving !== null;
  const projectActionsDisabled = operationDisabled || recoveryDecision !== null;

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

  const autosave = useMemo(() => new ProjectAutosaveQueue<ProjectSnapshotV1, ProjectDto>({
    save: ({ projectId, expectedRevision, snapshot }) => saveProjectWithRecovery(api, projectId, expectedRevision, snapshot),
    onSaveStarted: ({ projectId, expectedRevision, snapshotKey }) => {
      dispatchSession({ type: "save-started", projectId, expectedRevision, snapshotKey });
    },
    onSaveSucceeded: (request, project) => {
      dispatchSession({
        type: "save-succeeded",
        projectId: request.projectId,
        expectedRevision: request.expectedRevision,
        project,
        snapshotKey: request.snapshotKey,
      });
      void refreshProjects();
    },
    onSaveFailed: (request, error, kind) => {
      dispatchSession({
        type: "save-failed",
        projectId: request.projectId,
        expectedRevision: request.expectedRevision,
        snapshotKey: request.snapshotKey,
        message: errorMessage(error),
        conflict: kind === "conflict",
      });
    },
    isConflict: (error) => error instanceof ProjectApiClientError && error.status === 409,
    isRetryable: (error) => !(error instanceof ProjectApiClientError) || error.status >= 500,
  }), [api, dispatchSession, refreshProjects]);

  useEffect(() => () => autosave.dispose(), [autosave]);

  useEffect(() => {
    if (session.activeProject && currentSnapshot.key !== null) {
      autosave.observe(currentSnapshot.key, deserializeProjectSnapshot(currentSnapshot.key));
    }
  }, [autosave, currentSnapshot.key, session.activeProject?.id]);

  function activateProject(project: ProjectDto, currentSnapshotKey: string | null) {
    autosave.activate({
      projectId: project.id,
      revision: project.revision,
      savedSnapshotKey: projectSnapshotValue(project.snapshot),
    });
    dispatchSession({ type: "activate-project", project, currentSnapshotKey });
  }

  async function flushActiveProject() {
    if (!session.activeProject) return;
    const snapshotKey = currentSnapshotKeyRef.current;
    if (snapshotKey === null) throw new Error(currentSnapshotErrorRef.current ?? "O Working Set atual não forma um snapshot válido.");
    const context = autosave.getContext();
    if (!context || context.projectId !== session.activeProject.id) {
      throw new Error("O autosave deste Project não está ativo. O Working Set local foi mantido.");
    }
    if (snapshotKey === context.savedSnapshotKey) return;
    autosave.observe(snapshotKey, deserializeProjectSnapshot(snapshotKey));
    const result = await autosave.flushNow();
    if (result === "error" || result === "conflict") {
      throw new Error(result === "conflict"
        ? "Há um conflito de revisão. Salve uma cópia local ou descarte as alterações antes de continuar."
        : "O autosave falhou. Tente novamente ou salve uma cópia local antes de continuar.");
    }
  }

  useEffect(() => {
    void refreshProjects();
    return () => { projectListRequestGuard.current.invalidate(); };
  }, [refreshProjects]);

  async function createProject() {
    if (projectActionsDisabled) return;
    setOperation("creating");
    try {
      await flushActiveProject();
      const project = await api.create();
      activateProject(project, currentSnapshotKeyRef.current);
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function openProject(projectId: string, discardLocalConflict = false) {
    if (projectActionsDisabled) return;
    setOperation("opening");
    let restoreStart = false;
    try {
      if (!discardLocalConflict) await flushActiveProject();
      onProjectOpenStart?.();
      restoreStart = true;
      const project = await api.open(projectId);
      if (project.recovery) {
        setRecoveryDecision(project);
      } else {
        onProjectOpen(project);
        activateProject(project, projectSnapshotValue(project.snapshot));
      }
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      if (restoreStart) onProjectOpenEnd?.();
      setOperation(null);
    }
  }

  async function saveProject() {
    if (!session.activeProject || operationDisabled) return;
    try {
      await flushActiveProject();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    }
  }

  async function saveLocalCopy() {
    if (operationDisabled || !session.activeProject) return;
    const snapshotKey = currentSnapshotKeyRef.current;
    if (snapshotKey === null) {
      dispatchSession({ type: "request-failed", message: currentSnapshotErrorRef.current ?? "O Working Set atual não forma um snapshot válido." });
      return;
    }
    setOperation("creating");
    try {
      const copy = await api.create(deserializeProjectSnapshot(snapshotKey));
      activateProject(copy, snapshotKey);
      setRecoveryDecision(null);
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function openCanonicalAfterConflict() {
    const activeProjectId = session.activeProject?.id;
    if (!activeProjectId || operationDisabled) return;
    await openProject(activeProjectId, true);
  }

  async function chooseRecovery(choice: ProjectRecoveryChoice) {
    const pending = recoveryDecision;
    if (!pending || operationDisabled) return;
    setOperation("opening");
    try {
      const project = await resolveProjectRecoveryChoice(pending, choice, api);
      onProjectOpen(project);
      activateProject(project, projectSnapshotValue(project.snapshot));
      setRecoveryDecision(null);
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
      try {
        const latest = await api.open(pending.id);
        if (latest.recovery) setRecoveryDecision(latest);
        else setRecoveryDecision(null);
      } catch { /* Keep the candidate and local Working Set visible for another explicit choice. */ }
    } finally {
      setOperation(null);
    }
  }

  async function duplicateProject(projectId: string) {
    if (projectActionsDisabled) return;
    setOperation("duplicating");
    try {
      if (session.activeProject?.id === projectId) await flushActiveProject();
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
    if (projectActionsDisabled) return;
    setOperation("deleting");
    const deletingActive = session.activeProject?.id === projectId;
    let autosaveDisposed = false;
    try {
      if (deletingActive) {
        onProjectInteractionStart?.();
        await flushActiveProject();
        autosave.dispose();
        autosaveDisposed = true;
      }
      await api.delete(projectId);
      dispatchSession({ type: "project-deleted", projectId });
      void refreshProjects();
    } catch (error) {
      if (deletingActive && autosaveDisposed) {
        try {
          const latest = await api.open(projectId);
          const currentKey = currentSnapshotKeyRef.current;
          const canonicalKey = projectSnapshotValue(latest.snapshot);
          if (latest.recovery) setRecoveryDecision(latest);
          if (currentKey === canonicalKey) {
            activateProject(latest, currentKey);
          } else {
            autosave.dispose();
            dispatchSession({
              type: "revision-conflict",
              project: latest,
              currentSnapshotKey: currentKey,
              message: "O Project mudou enquanto a exclusão era processada. O Working Set local foi mantido.",
            });
          }
        } catch (openError) {
          if (openError instanceof ProjectApiClientError && openError.status === 404) {
            dispatchSession({ type: "project-deleted", projectId });
          }
        }
      }
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      if (deletingActive) onProjectInteractionEnd?.();
      setOperation(null);
    }
  }

  return (
    <section className="panel projects-panel" aria-label="Projects">
      <div className="panel-heading">
        <div>
          <h2>Projects</h2>
          <p>Autosave do Working Set aberto · recuperação antes de substituir um Project.</p>
        </div>
        <div className="project-save-controls">
          <span className="status" aria-label="Estado do salvamento" aria-live="polite">{session.status}</span>
          <button className="button primary" type="button" onClick={() => void createProject()} disabled={projectActionsDisabled}>
            Criar Project vazio
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => void saveProject()}
            disabled={projectActionsDisabled || !session.activeProject || session.status === "Salvo" || session.status === "Conflito"}
          >
            {session.status === "Erro" ? "Tentar novamente" : "Salvar agora"}
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
            <button className="button secondary" type="button" aria-label={`Abrir ${project.name} ${project.id}`} disabled={projectActionsDisabled} onClick={() => void openProject(project.id)}>Abrir</button>
            <button className="button secondary" type="button" aria-label={`Duplicar ${project.name} ${project.id}`} disabled={projectActionsDisabled} onClick={() => void duplicateProject(project.id)}>Duplicar</button>
            <button className="button secondary" type="button" aria-label={`Excluir ${project.name} ${project.id}`} disabled={projectActionsDisabled} onClick={() => void deleteProject(project.id)}>Excluir</button>
          </div>
        </li>)}
      </ul> : <p className="muted">Nenhum Project salvo.</p>}

      {(session.status === "Conflito" || session.status === "Erro") && session.activeProject && <section className="project-conflict" aria-label={session.status === "Conflito" ? "Conflito de revisão" : "Falha no autosave"}>
        <p role="alert">{session.status === "Conflito"
          ? "A revisão salva mudou em outro lugar. O Working Set local continua aberto e não foi sobrescrito."
          : "O autosave não concluiu. O Working Set local continua aberto."}</p>
        <div className="project-row-actions">
          <button className="button primary" type="button" disabled={operationDisabled} onClick={() => void saveLocalCopy()}>Salvar cópia local como novo Project</button>
          {session.status === "Conflito" && <button className="button secondary" type="button" disabled={operationDisabled} onClick={() => void openCanonicalAfterConflict()}>Descartar alterações locais e abrir a versão atual</button>}
        </div>
      </section>}

      {recoveryDecision && <section className="project-recovery-choice" role="dialog" aria-modal="true" aria-labelledby="project-recovery-heading">
        {recoveryDecision.recovery && recoveryDecision.recovery.baseRevision === recoveryDecision.revision ? <>
          <h3 id="project-recovery-heading">Autosave recuperado</h3>
          <p>Existe uma recuperação baseada na revisão atual de {recoveryDecision.name}. Escolha antes de carregar este Project.</p>
          <div className="project-row-actions">
            <button className="button primary" type="button" disabled={operationDisabled} onClick={() => void chooseRecovery("restore")}>Restaurar recuperação</button>
            <button className="button secondary" type="button" disabled={operationDisabled} onClick={() => void chooseRecovery("discard")}>Descartar recuperação e abrir a versão salva</button>
            <button className="button secondary" type="button" disabled={operationDisabled} onClick={() => setRecoveryDecision(null)}>Manter Working Set atual</button>
          </div>
        </> : <>
          <h3 id="project-recovery-heading">Recovery de revisão antiga</h3>
          <p>A recuperação de {recoveryDecision.name} parte da revisão {recoveryDecision.recovery?.baseRevision}; a versão canônica está na revisão {recoveryDecision.revision}. Escolha antes de carregar o Project.</p>
          <div className="project-row-actions">
            <button className="button primary" type="button" disabled={operationDisabled} onClick={() => void chooseRecovery("copy")}>Salvar recuperação como novo Project</button>
            <button className="button secondary" type="button" disabled={operationDisabled} onClick={() => void chooseRecovery("discard")}>Descartar recovery e abrir a versão atual</button>
            <button className="button secondary" type="button" disabled={operationDisabled} onClick={() => setRecoveryDecision(null)}>Manter Working Set atual</button>
          </div>
        </>}
      </section>}

      {session.error && <p className="error-message" role="alert">{session.error}</p>}
    </section>
  );
}
