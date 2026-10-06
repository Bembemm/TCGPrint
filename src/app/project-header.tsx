"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectDto, ProjectOpenDto } from "../../services/project-api";
import type { ProjectSaveStatus, ProjectSessionState } from "./project-session";
import type { ProjectRecoveryChoice } from "./project-recovery-decision";

export interface ProjectHeaderProps {
  readonly activeProject: ProjectDto | null;
  readonly projects: ProjectSessionState["projects"];
  readonly status: ProjectSaveStatus;
  readonly error?: string;
  readonly recoveryDecision: ProjectOpenDto | null;
  readonly actionsDisabled: boolean;
  readonly recoveryActionsDisabled: boolean;
  readonly onNewProject: () => void;
  readonly onSaveAsProject: () => void;
  readonly onOpenProject: (projectId: string) => void;
  readonly onSaveNow: () => void;
  readonly onDuplicateProject: (projectId: string) => void;
  readonly onDeleteProject: (projectId: string) => void;
  readonly onSaveLocalCopy: () => void;
  readonly onOpenCanonicalAfterConflict: () => void;
  readonly onChooseRecovery: (choice: ProjectRecoveryChoice) => void;
  readonly onKeepCurrentWorkingSet: () => void;
}

export function projectSaveStatusLabel(status: ProjectSaveStatus): string {
  switch (status) {
    case "Dirty": return "Alterações pendentes";
    case "Salvando": return "Salvando…";
    case "Salvo": return "Salvo";
    case "Erro": return "Erro";
    case "Conflito": return "Conflito";
  }
}

function focusFirst(container: HTMLElement | null): void {
  container?.querySelector<HTMLElement>("button:not([disabled]), a[href], input, select, textarea")?.focus();
}

function trapDialogTab(event: KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== "Tab" || !container) return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.closest("[hidden]") && !element.closest("[inert]"));
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!container.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export default function ProjectHeader({
  activeProject,
  projects,
  status,
  error,
  recoveryDecision,
  actionsDisabled,
  recoveryActionsDisabled,
  onNewProject,
  onSaveAsProject,
  onOpenProject,
  onSaveNow,
  onDuplicateProject,
  onDeleteProject,
  onSaveLocalCopy,
  onOpenCanonicalAfterConflict,
  onChooseRecovery,
  onKeepCurrentWorkingSet,
}: ProjectHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectListOpen, setProjectListOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const projectListDialogRef = useRef<HTMLDivElement>(null);
  const projectListRestoreFocusRef = useRef<HTMLButtonElement | null>(null);
  const recoveryDialogRef = useRef<HTMLElement>(null);
  const wasMenuOpenRef = useRef(false);
  const wasProjectListOpenRef = useRef(false);
  const wasRecoveryOpenRef = useRef(false);
  const skipMenuFocusRestoreRef = useRef(false);

  useEffect(() => {
    if (wasMenuOpenRef.current && !menuOpen && !skipMenuFocusRestoreRef.current) menuTriggerRef.current?.focus();
    wasMenuOpenRef.current = menuOpen;
    if (!menuOpen) skipMenuFocusRestoreRef.current = false;
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    if (projectListOpen) {
      focusFirst(projectListDialogRef.current);
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setProjectListOpen(false);
          return;
        }
        trapDialogTab(event, projectListDialogRef.current);
      };
      window.addEventListener("keydown", handleKeyDown);
      wasProjectListOpenRef.current = true;
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
    if (wasProjectListOpenRef.current) projectListRestoreFocusRef.current?.focus();
    wasProjectListOpenRef.current = false;
  }, [projectListOpen]);

  useEffect(() => {
    if (recoveryDecision) {
      focusFirst(recoveryDialogRef.current);
      const handleKeyDown = (event: KeyboardEvent) => trapDialogTab(event, recoveryDialogRef.current);
      window.addEventListener("keydown", handleKeyDown);
      wasRecoveryOpenRef.current = true;
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
    if (wasRecoveryOpenRef.current) menuTriggerRef.current?.focus();
    wasRecoveryOpenRef.current = recoveryDecision !== null;
  }, [recoveryDecision]);

  function closeMenu(): void {
    setMenuOpen(false);
  }

  function openProjectList(): void {
    projectListRestoreFocusRef.current = menuTriggerRef.current;
    skipMenuFocusRestoreRef.current = true;
    setMenuOpen(false);
    setProjectListOpen(true);
  }

  function chooseProject(projectId: string): void {
    setProjectListOpen(false);
    onOpenProject(projectId);
  }

  function runMenuAction(action: () => void): void {
    closeMenu();
    action();
  }

  const label = activeProject ? projectSaveStatusLabel(status) : null;
  const conflict = activeProject && (status === "Conflito" || status === "Erro");

  return <div className="workspace-project-header" role="group" aria-label="Project ativo">
    <div className="workspace-project-header-summary">
      <strong className="workspace-project-header-name" title={activeProject?.name ?? "Projeto não salvo"}>
        {activeProject?.name ?? "Projeto não salvo"}
      </strong>
      {label && <span className="workspace-project-header-status" role="status" aria-label="Estado do salvamento" aria-live="polite">{label}</span>}
    </div>
    {!activeProject && <button className="button primary workspace-project-save-as" type="button" disabled={actionsDisabled} onClick={onSaveAsProject}>Salvar como projeto</button>}
    <button
      ref={menuTriggerRef}
      className="button secondary workspace-project-menu-trigger"
      type="button"
      aria-label="Abrir menu do Project"
      aria-expanded={menuOpen}
      aria-controls="workspace-project-menu"
      onClick={() => setMenuOpen((open) => !open)}
    >Project ▾</button>

    {menuOpen && <div id="workspace-project-menu" className="workspace-project-menu" role="group" aria-label="Ações do Project">
      <button type="button" disabled={actionsDisabled} onClick={() => runMenuAction(onNewProject)}>Novo projeto</button>
      {activeProject && <button type="button" disabled={actionsDisabled} onClick={() => runMenuAction(onSaveAsProject)}>Salvar como projeto</button>}
      <button type="button" disabled={actionsDisabled} onClick={openProjectList}>Abrir projeto</button>
      {activeProject && <>
        <button type="button" disabled={actionsDisabled} onClick={() => runMenuAction(() => onDuplicateProject(activeProject.id))}>Duplicar</button>
        {status !== "Salvo" && status !== "Conflito" && <button type="button" disabled={actionsDisabled} onClick={() => runMenuAction(onSaveNow)}>Salvar agora</button>}
        <button className="is-destructive" type="button" disabled={actionsDisabled} onClick={() => runMenuAction(() => onDeleteProject(activeProject.id))}>Excluir</button>
      </>}
      {conflict && <section className="project-conflict" aria-label={status === "Conflito" ? "Conflito de revisão" : "Falha no autosave"}>
        <p role="alert">{status === "Conflito"
          ? "A revisão salva mudou em outro lugar. O Working Set local continua aberto e não foi sobrescrito."
          : "O autosave não concluiu. O Working Set local continua aberto."}</p>
        <div className="project-row-actions">
          <button className="button primary" type="button" disabled={actionsDisabled} onClick={() => runMenuAction(onSaveLocalCopy)}>Salvar cópia local como novo Project</button>
          {status === "Conflito" && <button className="button secondary" type="button" disabled={actionsDisabled} onClick={() => runMenuAction(onOpenCanonicalAfterConflict)}>Descartar alterações locais e abrir a versão atual</button>}
        </div>
      </section>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>}

    {projectListOpen && <div className="workspace-project-dialog-backdrop">
      <div ref={projectListDialogRef} className="workspace-project-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-project-dialog-heading">
        <header>
          <h2 id="workspace-project-dialog-heading">Abrir projeto</h2>
          <button className="button secondary" type="button" aria-label="Fechar lista de projetos" onClick={() => setProjectListOpen(false)}>Fechar</button>
        </header>
        {projects.length > 0
          ? <ul className="project-list">{projects.map((project) => <li className="project-list-row" key={project.id}>
            <strong>{project.name}</strong>
            <button className="button secondary" type="button" aria-label={`Abrir ${project.name}`} disabled={actionsDisabled} onClick={() => chooseProject(project.id)}>Abrir</button>
          </li>)}</ul>
          : <p className="muted">Nenhum projeto salvo.</p>}
      </div>
    </div>}

    {recoveryDecision && <div className="workspace-project-dialog-backdrop workspace-project-recovery-backdrop">
      <section ref={recoveryDialogRef} className="project-recovery-choice workspace-project-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="project-recovery-heading">
        {recoveryDecision.recovery && recoveryDecision.recovery.baseRevision === recoveryDecision.revision ? <>
          <h3 id="project-recovery-heading">Autosave recuperado</h3>
          <p>Existe uma recuperação baseada na revisão atual de {recoveryDecision.name}. Escolha antes de carregar este Project.</p>
          <div className="project-row-actions">
            <button className="button primary" type="button" disabled={recoveryActionsDisabled} onClick={() => onChooseRecovery("restore")}>Restaurar recuperação</button>
            <button className="button secondary" type="button" disabled={recoveryActionsDisabled} onClick={() => onChooseRecovery("discard")}>Descartar recuperação e abrir a versão salva</button>
            <button className="button secondary" type="button" disabled={recoveryActionsDisabled} onClick={onKeepCurrentWorkingSet}>Manter Working Set atual</button>
          </div>
        </> : <>
          <h3 id="project-recovery-heading">Recovery de revisão antiga</h3>
          <p>A recuperação de {recoveryDecision.name} parte da revisão {recoveryDecision.recovery?.baseRevision}; a versão canônica está na revisão {recoveryDecision.revision}. Escolha antes de carregar o Project.</p>
          <div className="project-row-actions">
            <button className="button primary" type="button" disabled={recoveryActionsDisabled} onClick={() => onChooseRecovery("copy")}>Salvar recuperação como novo Project</button>
            <button className="button secondary" type="button" disabled={recoveryActionsDisabled} onClick={() => onChooseRecovery("discard")}>Descartar recovery e abrir a versão atual</button>
            <button className="button secondary" type="button" disabled={recoveryActionsDisabled} onClick={onKeepCurrentWorkingSet}>Manter Working Set atual</button>
          </div>
        </>}
      </section>
    </div>}
  </div>;
}
