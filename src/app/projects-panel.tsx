"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkingCard } from "../../core/cards/types";
import type { ProjectSettingsV1 } from "../../persistence/projects/serializer";
import type { ProjectDto, ProjectOpenDto, ProjectSaveState } from "../../services/project-api";
import type { TemplateSelection } from "../../templates/types";
import type { CutSourceSelection } from "../../core/cut";
import type { CutPreviewDto } from "../../services/cut-api";
import { createPhysicalOrder, type PhysicalOrder } from "../../core/cards/physical-instance-order";
import { createProjectApiClient, ProjectApiClientError } from "./project-api-client";
import { createProjectListRequestGuard } from "./project-list-request-guard";
import { ProjectAutosaveQueue } from "./project-autosave";
import { saveProjectWithRecovery } from "./project-autosave-persistence";
import TemplateLibraryPanel from "./template-library-panel";
import type { TemplateRegistrationDefaults } from "./template-library-panel";
import type { TemplateRegistrationStatus } from "./template-registration-compat";
import { resolveProjectRecoveryChoice, type ProjectRecoveryChoice } from "./project-recovery-decision";
import ProjectHeader from "./project-header";
import { useWorkspaceProjectHeaderHost } from "./workspace-project-header-context";
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
  readonly view?: ProjectsPanelView;
  readonly cards: readonly WorkingCard[];
  readonly physicalOrder?: PhysicalOrder;
  readonly settings: ProjectSettingsV1;
  readonly onProjectOpen: (project: ProjectDto) => void;
  readonly onTemplateDefaults?: (defaults: TemplateRegistrationDefaults | null) => void;
  readonly onCutSourceSelectionChange?: (selection: CutSourceSelection | null) => void;
  readonly onCutGeometryPreviewChange?: (preview: CutPreviewDto | null) => void;
  readonly selectedCutPageNumber: number;
  readonly onCutPageNumberChange: (pageNumber: number) => void;
  readonly onProjectSyncStateChange?: (state: { readonly projectId: string; readonly revision: number; readonly saved: boolean } | null) => void;
  readonly onTemplateRegistrationStatusChange?: (status: TemplateRegistrationStatus) => void;
  readonly onProjectInteractionLockChange?: (locked: boolean) => void;
  readonly disabled?: boolean;
}

export type ProjectsPanelView = "all" | "project" | "templates" | "cut" | "settings" | "export" | "hidden";

function errorMessage(error: unknown): string {
  if (error instanceof ProjectApiClientError) return error.message;
  return error instanceof Error ? error.message : "A operação de Project falhou.";
}

export default function ProjectsPanel({
  view = "all",
  cards,
  physicalOrder,
  settings,
  onProjectOpen,
  onTemplateDefaults,
  onCutSourceSelectionChange,
  onCutGeometryPreviewChange,
  selectedCutPageNumber,
  onCutPageNumberChange,
  onProjectSyncStateChange,
  onTemplateRegistrationStatusChange,
  onProjectInteractionLockChange,
  disabled = false,
}: ProjectsPanelProps) {
  const [templateSelection, setTemplateSelection] = useState<TemplateSelection | null>(null);
  const currentSnapshot = useMemo(() => {
    try {
      const document = projectSnapshotDocument(cards, settings, templateSelection, physicalOrder ?? createPhysicalOrder(cards));
      return {
        key: projectSaveStateValue(document),
        document,
        error: undefined,
      };
    } catch (error) {
      return { key: null, document: null, error: errorMessage(error) };
    }
  }, [cards, physicalOrder, settings, templateSelection]);
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
  const projectHeaderHost = useWorkspaceProjectHeaderHost();

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
      onCutPageNumberChange(1);
      onCutGeometryPreviewChange?.(null);
      setCutPreviewLoading(false);
      return () => { current = false; abort.abort(); };
    }
    setCutPreview(null);
    setCutPreviewError(null);
    onCutPageNumberChange(1);
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
    }).catch((error: unknown) => {
      if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
      setCutPreviewError(errorMessage(error));
    }).finally(() => {
      if (current) setCutPreviewLoading(false);
    });
    return () => { current = false; abort.abort(); };
  }, [session.activeProject?.id, session.activeProject?.revision, session.status, onCutGeometryPreviewChange, onCutPageNumberChange]);

  useEffect(() => {
    if (!cutPreview) return;
    const page = cutPreview.pages.find(({ pageNumber }) => pageNumber === selectedCutPageNumber) ?? cutPreview.pages[0];
    if (!page) return;
    onCutGeometryPreviewChange?.({
      ...cutPreview,
      geometry: page.geometry,
      activeGeometry: page.activeGeometry,
      slotPaths: page.slotPaths,
      layout: page.layout,
    });
  }, [cutPreview, selectedCutPageNumber, onCutGeometryPreviewChange]);

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
      const initialDocument = createNewProjectDocument();
      const project = await api.create(initialDocument.snapshot, initialDocument.templateSelection);
      onProjectOpen(project);
      activateProject(project, projectSnapshotValue(project.snapshot, project.templateSelection));
      void refreshProjects();
    } catch (error) {
      dispatchSession({ type: "request-failed", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function saveAsProject() {
    if (projectActionsDisabled || projectOpenLock.isLocked()) return;
    const snapshotKey = currentSnapshotKeyRef.current;
    const document = currentSnapshotDocumentRef.current;
    if (snapshotKey === null || document === null) {
      dispatchSession({ type: "request-failed", message: currentSnapshotErrorRef.current ?? "O Working Set atual não forma um snapshot válido." });
      return;
    }
    setOperation("creating");
    try {
      const project = await api.create(document.snapshot, document.templateSelection);
      activateProject(project, snapshotKey);
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

  async function exportCut(format: "svg" | "dxf", pageNumber: number) {
    const project = session.activeProject;
    if (!project || session.status !== "Salvo" || cutExportBusy || projectActionsDisabled) return;
    setCutExportBusy(true);
    setCutPreviewError(null);
    try {
      const pageQuery = (cutPreview?.pageCount ?? 1) > 1 ? `?page=${pageNumber}` : "";
      const response = await fetch(`/api/cut/export/${format}${pageQuery}`, {
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
      link.download = `tcgprint-cut${(cutPreview?.pageCount ?? 1) > 1 ? `-page-${String(pageNumber).padStart(2, "0")}` : ""}.${format}`;
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

  const selectedCutPage = cutPreview?.pages.find(({ pageNumber }) => pageNumber === selectedCutPageNumber) ?? cutPreview?.pages[0];
  const showTemplates = view === "all" || view === "templates" || view === "settings";
  const showCutPreview = view === "all" || view === "cut" || view === "settings";
  const showCutExport = view === "all" || view === "cut" || view === "export";

  const projectHeader = <ProjectHeader
    activeProject={session.activeProject}
    projects={session.projects}
    status={session.status}
    error={session.error}
    recoveryDecision={recoveryDecision}
    actionsDisabled={projectActionsDisabled || projectOpenLock.isLocked()}
    recoveryActionsDisabled={recoveryActionDisabled}
    onNewProject={() => void createProject()}
    onSaveAsProject={() => void saveAsProject()}
    onOpenProject={(projectId) => void openProject(projectId)}
    onSaveNow={() => void saveProject()}
    onDuplicateProject={(projectId) => void duplicateProject(projectId)}
    onDeleteProject={(projectId) => void deleteProject(projectId)}
    onSaveLocalCopy={() => void saveLocalCopy()}
    onOpenCanonicalAfterConflict={() => void openCanonicalAfterConflict()}
    onChooseRecovery={(choice) => void chooseRecovery(choice)}
    onKeepCurrentWorkingSet={keepCurrentWorkingSet}
  />;

  return (
    <>
    {projectHeaderHost ? createPortal(projectHeader, projectHeaderHost) : <div className="workspace-project-header-fallback">{projectHeader}</div>}
    <section
      className="panel projects-panel"
      aria-label={view === "settings" ? "Configurações" : view === "export" ? "Exportar" : view === "templates" ? "Templates" : view === "cut" ? "Corte" : "Projects"}
      hidden={view === "hidden"}
    >
      <TemplateLibraryPanel view={view === "all" || view === "settings" ? "all" : showTemplates ? "library" : showCutPreview ? "cut" : "hidden"} selection={templateSelection} cutSourceSelection={settings.cutSourceSelection} onCutSourceSelect={onCutSourceSelectionChange} onRegistrationStatusChange={onTemplateRegistrationStatusChange} onSelect={(selection, defaults) => {
        const sameTemplateSelection = templateSelection?.templateId === selection?.templateId
          && templateSelection?.version === selection?.version
          && templateSelection?.packageHash === selection?.packageHash;
        setTemplateSelection(selection);
        if (!sameTemplateSelection) onCutSourceSelectionChange?.(null);
        if (defaults) onTemplateDefaults?.(defaults);
        else if (selection === null) onTemplateDefaults?.(null);
      }} disabled={projectActionsDisabled} />

      <div className="projects-panel-cut-view" hidden={!showCutPreview}>
      <section className="cut-export-panel" aria-label="Preview e validação de corte">
        <div>
          <h3>Preview de corte</h3>
          <p>Confira a geometria que será usada nos arquivos de corte.</p>
          {cutPreview?.geometry.source.kind === "project-layout" && <p className="muted">Sem SVG/DXF selecionado: os exports manuais geram somente retângulos de canto reto a partir dos trims ativos do layout PDF. Nenhum canto ou curva é inferido.</p>}
        </div>
        {session.activeProject === null
          ? <p className="muted">Abra ou crie um Project para validar os paths de corte.</p>
          : session.status !== "Salvo"
            ? <p className="muted" aria-live="polite">Aguardando autosave para validar a revisão atual do Project.</p>
            : cutPreviewLoading
              ? <p className="muted" aria-live="polite">Validando geometria de corte…</p>
              : cutPreview
                ? <>
                  <p className="cut-human-summary">Folha {cutPreview.layout.pageSizeMm.widthMm} × {cutPreview.layout.pageSizeMm.heightMm} mm · {selectedCutPage?.slotPaths.filter(({ state }) => state === "active").length ?? 0} paths ativos</p>
                  {cutPreview.alternateSources.map((source) => source.status === "divergent" || source.status === "unreadable"
                    ? <p key={source.fileId} className="error-message" role="alert">Fonte de corte {source.fileName}: {source.status === "divergent" ? "geometria divergente" : "não pôde ser lida"}{source.message ? ` · ${source.message}` : ""}.</p>
                    : null)}
                  <details className="cut-technical-details">
                    <summary>Detalhes técnicos</summary>
                    <p>Project {cutPreview.projectId} · revisão {cutPreview.projectRevision} · parser {cutPreview.parserVersion}</p>
                    {cutPreview.alternateSources.filter(({ status }) => status === "equivalent" || status === "not-compared").map((source) => <p key={source.fileId}>Fonte {source.fileName}: {source.status === "equivalent" ? "geometria equivalente" : source.message}</p>)}
                  </details>
                </>
                : <p className="muted">Cut preview indisponível.</p>}
        {cutPreviewError && <p className="error-message" role="alert">{cutPreviewError}</p>}
      </section>
      </div>

      <div className="projects-panel-cut-export-view" hidden={!showCutExport}>
      <section className="cut-export-panel" aria-label="SVG e DXF Cut">
        <h3>Arquivos de corte</h3>
        {session.activeProject === null
          ? <p className="muted">Abra ou crie um Project em Configurações para validar e exportar os paths de corte.</p>
          : session.status !== "Salvo"
            ? <p className="muted" aria-live="polite">Aguardando autosave para validar a revisão atual do Project.</p>
            : cutPreviewLoading
              ? <p className="muted" aria-live="polite">Validando geometria de corte…</p>
              : cutPreview && selectedCutPage
                ? <>
                  <p className="cut-human-summary">Página {selectedCutPage.pageNumber} · {selectedCutPage.slotPaths.filter(({ state }) => state === "active").length} paths de corte</p>
                  {cutPreview.pageCount > 1 && <label className="cut-page-picker">Página PDF
                    <select aria-label="Página PDF correspondente ao cut file" value={selectedCutPage.pageNumber} onChange={(event) => onCutPageNumberChange(Number(event.currentTarget.value))}>
                      {cutPreview.pages.map((page) => <option key={page.pageNumber} value={page.pageNumber}>Página {page.pageNumber} · cartas {page.firstCardNumber}–{page.lastCardNumber}</option>)}
                    </select>
                  </label>}
                  <div className="cut-export-actions">
                    <button className="button secondary" type="button" disabled={projectActionsDisabled || cutExportBusy || !selectedCutPage.activeGeometry} onClick={() => void exportCut("svg", selectedCutPage.pageNumber)}>{cutExportBusy ? "Exportando…" : `Exportar SVG Cut · página ${selectedCutPage.pageNumber}`}</button>
                    <button className="button secondary" type="button" disabled={projectActionsDisabled || cutExportBusy || !selectedCutPage.activeGeometry} onClick={() => void exportCut("dxf", selectedCutPage.pageNumber)}>{cutExportBusy ? "Exportando…" : `Exportar DXF Cut · página ${selectedCutPage.pageNumber}`}</button>
                  </div>
                  <details className="cut-technical-details">
                    <summary>Detalhes técnicos</summary>
                    <p>Project {cutPreview.projectId} · revisão {cutPreview.projectRevision} · parser {cutPreview.parserVersion} · folha {cutPreview.layout.pageSizeMm.widthMm} × {cutPreview.layout.pageSizeMm.heightMm} mm</p>
                  </details>
                </>
                : <p className="muted">Cut preview indisponível.</p>}
        {cutPreviewError && <p className="error-message" role="alert">{cutPreviewError}</p>}
      </section>
      </div>

    </section>
    </>
  );
}
