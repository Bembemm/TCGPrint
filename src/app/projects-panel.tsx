"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { WorkingCard } from "../../core/cards/types";
import type { ProjectSettingsV1 } from "../../persistence/projects/serializer";
import type { ProjectDto, ProjectOpenDto, ProjectSaveState } from "../../services/project-api";
import type { TemplateSelection } from "../../templates/types";
import type { CutSourceSelection } from "../../core/cut";
import type { CutPreviewDto } from "../../services/cut-api";
import { createProjectApiClient, ProjectApiClientError } from "./project-api-client";
import { createProjectListRequestGuard } from "./project-list-request-guard";
import { ProjectAutosaveQueue } from "./project-autosave";
import { saveProjectWithRecovery } from "./project-autosave-persistence";
import TemplateLibraryPanel from "./template-library-panel";
import type { TemplateRegistrationDefaults } from "./template-library-panel";
import type { TemplateRegistrationStatus } from "./template-registration-compat";
import { resolveProjectRecoveryChoice, type ProjectRecoveryChoice } from "./project-recovery-decision";
import {
  createProjectOpenInteractionLock,
  keepCurrentProjectWorkingSet,
  openProjectWithInteractionLock,
  resolveProjectRecoveryWithInteractionLock,
} from "./project-interaction-lock";
import {
  createNewProjectDocument,
  createProjectSessionState,
  projectSessionReducer,
  projectSnapshotDocument,
  projectSaveStateValue,
  projectSnapshotValue,
} from "./project-session";

export interface ProjectsPanelProps {
  readonly cards: readonly WorkingCard[];
  readonly settings: ProjectSettingsV1;
  readonly onProjectOpen: (project: ProjectDto) => void;
  readonly onTemplateDefaults?: (defaults: TemplateRegistrationDefaults | null) => void;
  readonly onCutSourceSelectionChange?: (selection: CutSourceSelection | null) => void;
  readonly onCutGeometryPreviewChange?: (preview: CutPreviewDto | null) => void;
  readonly onProjectSyncStateChange?: (state: { readonly projectId: string; readonly revision: number; readonly saved: boolean } | null) => void;
  readonly onTemplateRegistrationStatusChange?: (status: TemplateRegistrationStatus) => void;
  readonly onProjectInteractionLockChange?: (locked: boolean) => void;
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
  onTemplateDefaults,
  onCutSourceSelectionChange,
  onCutGeometryPreviewChange,
  onProjectSyncStateChange,
  onTemplateRegistrationStatusChange,
  onProjectInteractionLockChange,
  disabled = false,
}: ProjectsPanelProps) {
  const [templateSelection, setTemplateSelection] = useState<TemplateSelection | null>(null);
  const currentSnapshot = useMemo(() => {
    try {
      const document = projectSnapshotDocument(cards, settings, templateSelection);
      return {
        key: projectSaveStateValue(document),
        document,
        error: undefined,
      };
    } catch (error) {
      return { key: null, document: null, error: errorMessage(error) };
    }
  }, [cards, settings, templateSelection]);
  const currentSnapshotKeyRef = useRef(currentSnapshot.key);
  currentSnapshotKeyRef.current = currentSnapshot.key;
  const currentSnapshotDocumentRef = useRef(currentSnapshot.document);
  currentSnapshotDocumentRef.current = currentSnapshot.document;
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
  const [cutPreview, setCutPreview] = useState<CutPreviewDto | null>(null);
  const [cutPreviewError, setCutPreviewError] = useState<string | null>(null);
  const [cutPreviewLoading, setCutPreviewLoading] = useState(false);
  const [cutExportBusy, setCutExportBusy] = useState(false);
  const recoveryChoiceInProgress = useRef(false);
  const interactionLockCallbackRef = useRef(onProjectInteractionLockChange);
  interactionLockCallbackRef.current = onProjectInteractionLockChange;
  const projectOpenLock = useMemo(() => createProjectOpenInteractionLock((locked) => {
    interactionLockCallbackRef.current?.(locked);
  }), []);
  const operationDisabled = disabled || operation !== null || session.saving !== null;
  const recoveryActionDisabled = operationDisabled;
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

  const autosave = useMemo(() => new ProjectAutosaveQueue<ProjectSaveState, ProjectDto>({
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
    const project = session.activeProject;
    let current = true;
    const abort = new AbortController();
    if (!project || session.status !== "Salvo") {
      setCutPreview(null);
      setCutPreviewError(null);
      onCutGeometryPreviewChange?.(null);
      setCutPreviewLoading(false);
      return () => { current = false; abort.abort(); };
    }
    setCutPreview(null);
    setCutPreviewError(null);
    setCutPreviewLoading(true);
    onCutGeometryPreviewChange?.(null);
    void fetch("/api/cut/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, expectedRevision: project.revision }),
      cache: "no-store",
      signal: abort.signal,
    }).then(async (response) => {
      const body = await response.json() as unknown;
      if (!response.ok) {
        const details = body && typeof body === "object" ? body as { message?: string } : {};
        throw new Error(details.message ?? "Cut preview validation failed.");
      }
      return body as CutPreviewDto;
    }).then((result) => {
      if (!current) return;
      setCutPreview(result);
      onCutGeometryPreviewChange?.(result);
    }).catch((error: unknown) => {
      if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
      setCutPreviewError(errorMessage(error));
    }).finally(() => {
      if (current) setCutPreviewLoading(false);
    });
    return () => { current = false; abort.abort(); };
  }, [session.activeProject?.id, session.activeProject?.revision, session.status, onCutGeometryPreviewChange]);

  useEffect(() => {
    const project = session.activeProject;
    onProjectSyncStateChange?.(project
      ? { projectId: project.id, revision: project.revision, saved: session.status === "Salvo" }
      : null);
  }, [session.activeProject?.id, session.activeProject?.revision, session.status, onProjectSyncStateChange]);

  useEffect(() => {
    if (session.activeProject && currentSnapshot.key !== null && currentSnapshot.document !== null) {
      autosave.observe(currentSnapshot.key, currentSnapshot.document);
    }
  }, [autosave, currentSnapshot.key, currentSnapshot.document, session.activeProject?.id]);

  function activateProject(project: ProjectDto, currentSnapshotKey: string | null) {
    setTemplateSelection(project.templateSelection);
    autosave.activate({
      projectId: project.id,
      revision: project.revision,
      savedSnapshotKey: projectSnapshotValue(project.snapshot, project.templateSelection),
    });
    dispatchSession({ type: "activate-project", project, currentSnapshotKey });
  }

  async function flushActiveProject() {
    if (!session.activeProject) return;
    const snapshotKey = currentSnapshotKeyRef.current;
    if (snapshotKey === null) throw new Error(currentSnapshotErrorRef.current ?? "O Working Set atual não forma um snapshot válido.");
    const document = currentSnapshotDocumentRef.current;
    if (document === null) throw new Error("O Working Set atual não forma um snapshot válido.");
    const context = autosave.getContext();
    if (!context || context.projectId !== session.activeProject.id) {
      throw new Error("O autosave deste Project não está ativo. O Working Set local foi mantido.");
    }
    if (snapshotKey === context.savedSnapshotKey) return;
    autosave.observe(snapshotKey, document);
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
    if (projectActionsDisabled || projectOpenLock.isLocked()) return;
    setOperation("creating");
    try {
      await flushActiveProject();
      const initialDocument = createNewProjectDocument(settings, templateSelection);
      const project = await api.create(initialDocument.snapshot, initialDocument.templateSelection);
      activateProject(project, currentSnapshotKeyRef.current);
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function openProject(projectId: string, discardLocalConflict = false) {
    if (projectActionsDisabled || projectOpenLock.isLocked()) return;
    setOperation("opening");
    try {
      const result = await openProjectWithInteractionLock(
        projectOpenLock,
        async () => {
          if (!discardLocalConflict) await flushActiveProject();
          return api.open(projectId);
        },
        (opened) => opened.recovery !== null,
        (opened) => {
          onProjectOpen(opened);
          activateProject(opened, projectSnapshotValue(opened.snapshot, opened.templateSelection));
        },
      );
      if (result.recoveryPending) setRecoveryDecision(result.project);
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function saveProject() {
    if (!session.activeProject || projectActionsDisabled || projectOpenLock.isLocked()) return;
    try {
      await flushActiveProject();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    }
  }

  async function saveLocalCopy() {
    if (projectActionsDisabled || projectOpenLock.isLocked() || !session.activeProject) return;
    const snapshotKey = currentSnapshotKeyRef.current;
    if (snapshotKey === null) {
      dispatchSession({ type: "request-failed", message: currentSnapshotErrorRef.current ?? "O Working Set atual não forma um snapshot válido." });
      return;
    }
    setOperation("creating");
    try {
      const document = currentSnapshotDocumentRef.current;
      if (document === null) throw new Error(currentSnapshotErrorRef.current ?? "O Working Set atual não forma um snapshot válido.");
      const copy = await api.create(document.snapshot, document.templateSelection);
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
    if (!activeProjectId || projectActionsDisabled || projectOpenLock.isLocked()) return;
    await openProject(activeProjectId, true);
  }

  async function chooseRecovery(choice: ProjectRecoveryChoice) {
    const pending = recoveryDecision;
    if (!pending || recoveryActionDisabled || recoveryChoiceInProgress.current) return;
    recoveryChoiceInProgress.current = true;
    setOperation("opening");
    try {
      await resolveProjectRecoveryWithInteractionLock(
        projectOpenLock,
        () => resolveProjectRecoveryChoice(pending, choice, api),
        (project) => {
          onProjectOpen(project);
          activateProject(project, projectSnapshotValue(project.snapshot, project.templateSelection));
          setRecoveryDecision(null);
        },
      );
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
      try {
        const latest = await api.open(pending.id);
        if (latest.recovery) {
          projectOpenLock.refreshRecovery(true);
          setRecoveryDecision(latest);
        } else {
          projectOpenLock.refreshRecovery(false);
          setRecoveryDecision(null);
        }
      } catch { /* Keep the candidate and local Working Set visible for another explicit choice. */ }
    } finally {
      recoveryChoiceInProgress.current = false;
      setOperation(null);
    }
  }

  function keepCurrentWorkingSet() {
    if (!recoveryDecision || recoveryActionDisabled || recoveryChoiceInProgress.current || !projectOpenLock.isLocked()) return;
    keepCurrentProjectWorkingSet(projectOpenLock, () => setRecoveryDecision(null));
  }

  async function duplicateProject(projectId: string) {
    if (projectActionsDisabled || projectOpenLock.isLocked()) return;
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
    if (projectActionsDisabled || projectOpenLock.isLocked()) return;
    setOperation("deleting");
    const deletingActive = session.activeProject?.id === projectId;
    let autosaveDisposed = false;
    try {
      if (deletingActive) {
        projectOpenLock.beginOpen();
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
          const canonicalKey = projectSnapshotValue(latest.snapshot, latest.templateSelection);
          if (latest.recovery) {
            projectOpenLock.recoveryFound();
            setRecoveryDecision(latest);
          }
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
      if (deletingActive) projectOpenLock.finishOpenRequest();
      setOperation(null);
    }
  }

  async function exportCut(format: "svg" | "dxf") {
    const project = session.activeProject;
    if (!project || session.status !== "Salvo" || cutExportBusy || projectActionsDisabled) return;
    setCutExportBusy(true);
    setCutPreviewError(null);
    try {
      const response = await fetch(`/api/cut/export/${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, expectedRevision: project.revision }),
        cache: "no-store",
      });
      if (!response.ok) {
        const body = await response.json() as unknown;
        const details = body && typeof body === "object" ? body as { message?: string } : {};
        throw new Error(details.message ?? `Cut ${format.toUpperCase()} export failed.`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `tcgprint-cut.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setCutPreviewError(errorMessage(error));
    } finally {
      setCutExportBusy(false);
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

      <TemplateLibraryPanel selection={templateSelection} cutSourceSelection={settings.cutSourceSelection} onCutSourceSelect={onCutSourceSelectionChange} onRegistrationStatusChange={onTemplateRegistrationStatusChange} onSelect={(selection, defaults) => {
        const sameTemplateSelection = templateSelection?.templateId === selection?.templateId
          && templateSelection?.version === selection?.version
          && templateSelection?.packageHash === selection?.packageHash;
        setTemplateSelection(selection);
        if (!sameTemplateSelection) onCutSourceSelectionChange?.(null);
        if (defaults) onTemplateDefaults?.(defaults);
        else if (selection === null) onTemplateDefaults?.(null);
      }} disabled={projectActionsDisabled} />

      <section className="cut-export-panel" aria-label="SVG e DXF Cut Export">
        <div>
          <h3>SVG/DXF Cut Export</h3>
          <p>Preview e exports usam a mesma geometria em milímetros. O arquivo contém somente caminhos dos slots com cartas atribuídas; slots pulados, reservados ou vazios ficam de fora.</p>
          {cutPreview?.geometry.source.kind === "project-layout" && <p className="muted">Sem SVG/DXF selecionado: os exports manuais geram somente retângulos de canto reto a partir dos trims ativos do layout PDF. Nenhum canto ou curva é inferido.</p>}
        </div>
        {session.activeProject === null
          ? <p className="muted">Abra ou crie um Project para validar e exportar os paths de corte.</p>
          : session.status !== "Salvo"
            ? <p className="muted" aria-live="polite">Aguardando autosave para validar a revisão atual do Project.</p>
            : cutPreviewLoading
              ? <p className="muted" aria-live="polite">Validando original, versão, hash e sincronização com o layout…</p>
              : cutPreview
                ? <>
                  <p>Project {cutPreview.projectId} · revisão {cutPreview.projectRevision} · parser {cutPreview.parserVersion} · página {cutPreview.layout.pageSizeMm.widthMm} × {cutPreview.layout.pageSizeMm.heightMm} mm · {cutPreview.slotPaths.filter(({ state }) => state === "active").length} paths ativos</p>
                  {cutPreview.alternateSources.map((source) => source.status === "divergent" || source.status === "unreadable"
                    ? <p key={source.fileId} className="error-message" role="alert">Fonte alternativa {source.fileName}: {source.status === "divergent" ? "geometria materialmente divergente" : "não pôde ser comparada"}{source.message ? ` · ${source.message}` : ""}. A seleção explícita do Project continua vinculada ao arquivo escolhido.</p>
                    : null)}
                  {cutPreview.alternateSources.filter(({ status }) => status === "equivalent" || status === "not-compared").map((source) => <p key={source.fileId} className="muted">Fonte alternativa {source.fileName}: {source.status === "equivalent" ? "geometria equivalente" : source.message}</p>)}
                  <div className="cut-export-actions">
                    <button className="button secondary" type="button" disabled={projectActionsDisabled || cutExportBusy || !cutPreview.activeGeometry} onClick={() => void exportCut("svg")}>{cutExportBusy ? "Exportando…" : "Exportar SVG Cut"}</button>
                    <button className="button secondary" type="button" disabled={projectActionsDisabled || cutExportBusy || !cutPreview.activeGeometry} onClick={() => void exportCut("dxf")}>{cutExportBusy ? "Exportando…" : "Exportar DXF Cut"}</button>
                  </div>
                </>
                : <p className="muted">Cut preview indisponível.</p>}
        {cutPreviewError && <p className="error-message" role="alert">{cutPreviewError}</p>}
      </section>

      {(session.status === "Conflito" || session.status === "Erro") && session.activeProject && <section className="project-conflict" aria-label={session.status === "Conflito" ? "Conflito de revisão" : "Falha no autosave"}>
        <p role="alert">{session.status === "Conflito"
          ? "A revisão salva mudou em outro lugar. O Working Set local continua aberto e não foi sobrescrito."
          : "O autosave não concluiu. O Working Set local continua aberto."}</p>
        <div className="project-row-actions">
          <button className="button primary" type="button" disabled={projectActionsDisabled} onClick={() => void saveLocalCopy()}>Salvar cópia local como novo Project</button>
          {session.status === "Conflito" && <button className="button secondary" type="button" disabled={projectActionsDisabled} onClick={() => void openCanonicalAfterConflict()}>Descartar alterações locais e abrir a versão atual</button>}
        </div>
      </section>}

      {recoveryDecision && <section className="project-recovery-choice" role="dialog" aria-modal="true" aria-labelledby="project-recovery-heading">
        {recoveryDecision.recovery && recoveryDecision.recovery.baseRevision === recoveryDecision.revision ? <>
          <h3 id="project-recovery-heading">Autosave recuperado</h3>
          <p>Existe uma recuperação baseada na revisão atual de {recoveryDecision.name}. Escolha antes de carregar este Project.</p>
          <div className="project-row-actions">
            <button className="button primary" type="button" disabled={recoveryActionDisabled} onClick={() => void chooseRecovery("restore")}>Restaurar recuperação</button>
            <button className="button secondary" type="button" disabled={recoveryActionDisabled} onClick={() => void chooseRecovery("discard")}>Descartar recuperação e abrir a versão salva</button>
            <button className="button secondary" type="button" disabled={recoveryActionDisabled} onClick={keepCurrentWorkingSet}>Manter Working Set atual</button>
          </div>
        </> : <>
          <h3 id="project-recovery-heading">Recovery de revisão antiga</h3>
          <p>A recuperação de {recoveryDecision.name} parte da revisão {recoveryDecision.recovery?.baseRevision}; a versão canônica está na revisão {recoveryDecision.revision}. Escolha antes de carregar o Project.</p>
          <div className="project-row-actions">
            <button className="button primary" type="button" disabled={recoveryActionDisabled} onClick={() => void chooseRecovery("copy")}>Salvar recuperação como novo Project</button>
            <button className="button secondary" type="button" disabled={recoveryActionDisabled} onClick={() => void chooseRecovery("discard")}>Descartar recovery e abrir a versão atual</button>
            <button className="button secondary" type="button" disabled={recoveryActionDisabled} onClick={keepCurrentWorkingSet}>Manter Working Set atual</button>
          </div>
        </>}
      </section>}

      {session.error && <p className="error-message" role="alert">{session.error}</p>}
    </section>
  );
}
