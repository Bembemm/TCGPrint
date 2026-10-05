"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import WorkspacePreview from "./workspace-preview";
import WorkspaceSidebar, { WORKSPACE_SECTIONS, type WorkspaceSection } from "./workspace-sidebar";

export { WORKSPACE_SECTIONS } from "./workspace-sidebar";
export type { WorkspaceSection } from "./workspace-sidebar";

export interface WorkspaceSharedPanel {
  readonly id: string;
  readonly sections: readonly WorkspaceSection[];
  readonly content: ReactNode | ((activeSection: WorkspaceSection) => ReactNode);
}

export interface WorkspaceShellProps {
  readonly preview: ReactNode;
  readonly sections: Readonly<Partial<Record<WorkspaceSection, ReactNode>>>;
  readonly sharedPanel?: WorkspaceSharedPanel;
  readonly hasCards: boolean;
  readonly inert?: boolean;
  readonly ariaHidden?: boolean;
}

function isFocusable(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)
    || element.hasAttribute("disabled")
    || element.closest("[hidden]")
    || element.closest("[inert]")) return false;
  const closedDetails = element.closest("details:not([open])");
  const summary = element.closest("summary");
  if (closedDetails && summary?.parentElement !== closedDetails) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

export default function WorkspaceShell({ preview, sections, sharedPanel, hasCards, inert = false, ariaHidden = false }: WorkspaceShellProps) {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>("cards");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  const sharedSectionSet = useMemo(() => new Set(sharedPanel?.sections ?? []), [sharedPanel?.sections]);
  const panelIdFor = useCallback((section: WorkspaceSection) => sharedSectionSet.has(section)
    ? sharedPanel?.id ?? "workspace-shared-panel"
    : `workspace-${section}-panel`, [sharedPanel?.id, sharedSectionSet]);

  const openDrawer = (opener: HTMLElement) => {
    setSidebarCollapsed(false);
    drawerOpenerRef.current = opener;
    setDrawerOpen(true);
  };
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    drawerOpenerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    sidebarRef.current?.querySelector<HTMLElement>(`#workspace-tab-${activeSection}`)?.focus();
  }, [activeSection, drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab" || !sidebarRef.current) return;
      const focusable = Array.from(sidebarRef.current.querySelectorAll<HTMLElement>(
        'button:not([tabindex="-1"]), a[href], input, select, textarea, summary, [tabindex="0"]',
      )).filter(isFocusable);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDrawer, drawerOpen]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, section: WorkspaceSection) => {
    const currentIndex = WORKSPACE_SECTIONS.findIndex(({ id }) => id === section);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % WORKSPACE_SECTIONS.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + WORKSPACE_SECTIONS.length) % WORKSPACE_SECTIONS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = WORKSPACE_SECTIONS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = WORKSPACE_SECTIONS[nextIndex].id;
    setActiveSection(next);
    sidebarRef.current?.querySelector<HTMLElement>(`#workspace-tab-${next}`)?.focus();
  };
  const sharedContent = sharedPanel
    ? typeof sharedPanel.content === "function" ? sharedPanel.content(activeSection) : sharedPanel.content
    : null;
  const panels = <>
    {sharedPanel && <section
      id={sharedPanel.id}
      className="workspace-tab-panel workspace-shared-panel"
      role="tabpanel"
      aria-labelledby={`workspace-tab-${activeSection}`}
      tabIndex={0}
      hidden={!sharedSectionSet.has(activeSection)}
    >{sharedContent}</section>}
    {WORKSPACE_SECTIONS.filter(({ id }) => !sharedSectionSet.has(id)).map(({ id }) => <section
      key={id}
      id={`workspace-${id}-panel`}
      className="workspace-tab-panel"
      role="tabpanel"
      aria-labelledby={`workspace-tab-${id}`}
      tabIndex={0}
      hidden={activeSection !== id}
    >{sections[id]}</section>)}
  </>;

  return <div className="workspace-shell" data-active-section={activeSection} data-drawer-open={drawerOpen} data-sidebar-collapsed={sidebarCollapsed} inert={inert || undefined} aria-hidden={ariaHidden || undefined}>
    <header className="workspace-topbar">
      <a className="workspace-brand" href="/" aria-label="TCGPrint início">TCGPrint</a>
      <span className="workspace-topbar-status">Preview físico · Project local</span>
      <button
        type="button"
        className="button secondary workspace-mobile-open"
        aria-label="Abrir painel"
        aria-expanded={drawerOpen}
        aria-controls="workspace-sidebar"
        data-testid="workspace-mobile-open"
        onClick={(event) => openDrawer(event.currentTarget)}
      >Painel</button>
    </header>

    <div className="workspace-layout">
      <WorkspacePreview hasCards={hasCards} onOpenCards={(opener) => {
        setActiveSection("cards");
        if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 700px)").matches) openDrawer(opener);
        else setSidebarCollapsed(false);
      }}>
        {preview}
      </WorkspacePreview>

      <button type="button" className="workspace-backdrop" aria-label="Fechar painel pelo fundo" tabIndex={-1} onClick={closeDrawer} />
      <WorkspaceSidebar
        activeSection={activeSection}
        collapsed={sidebarCollapsed}
        drawerOpen={drawerOpen}
        panelIdFor={panelIdFor}
        sidebarRef={sidebarRef}
        children={panels}
        onCollapse={() => setSidebarCollapsed(true)}
        onClose={closeDrawer}
        onSelectSection={setActiveSection}
        onTabKeyDown={handleTabKeyDown}
      />
      {sidebarCollapsed && <button type="button" className="workspace-reopen" aria-label="Abrir painel" aria-controls="workspace-sidebar" data-testid="workspace-reopen" onClick={() => setSidebarCollapsed(false)}>›</button>}
    </div>
  </div>;
}
