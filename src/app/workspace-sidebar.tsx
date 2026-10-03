"use client";

import type { KeyboardEvent, ReactNode, RefObject } from "react";

export const WORKSPACE_SECTIONS = [
  { id: "cards", label: "Cartas" },
  { id: "artwork", label: "Artwork" },
  { id: "project", label: "Projeto" },
  { id: "layout", label: "Layout" },
  { id: "pdf", label: "PDF" },
  { id: "cut", label: "Corte" },
  { id: "templates", label: "Templates" },
  { id: "calibration", label: "Calibração" },
  { id: "export", label: "Export" },
  { id: "diagnostics", label: "Diagnóstico" },
] as const;

export type WorkspaceSection = typeof WORKSPACE_SECTIONS[number]["id"];

export interface WorkspaceSidebarProps {
  readonly activeSection: WorkspaceSection;
  readonly collapsed: boolean;
  readonly drawerOpen: boolean;
  readonly panelIdFor: (section: WorkspaceSection) => string;
  readonly sidebarRef: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
  readonly onCollapse: () => void;
  readonly onClose: () => void;
  readonly onSelectSection: (section: WorkspaceSection) => void;
  readonly onTabKeyDown: (event: KeyboardEvent<HTMLButtonElement>, section: WorkspaceSection) => void;
}

export default function WorkspaceSidebar({
  activeSection,
  collapsed,
  drawerOpen,
  panelIdFor,
  sidebarRef,
  children,
  onCollapse,
  onClose,
  onSelectSection,
  onTabKeyDown,
}: WorkspaceSidebarProps) {
  const isUnavailable = collapsed && !drawerOpen;
  return <aside
    ref={sidebarRef}
    id="workspace-sidebar"
    className="workspace-sidebar"
    aria-label="Painel lateral"
    role={drawerOpen ? "dialog" : undefined}
    aria-modal={drawerOpen ? true : undefined}
    data-collapsed={collapsed}
    data-drawer-open={drawerOpen}
    inert={isUnavailable ? true : undefined}
  >
    <div className="workspace-sidebar-heading">
      <div><span className="eyebrow">Painel de trabalho</span><h2>{WORKSPACE_SECTIONS.find(({ id }) => id === activeSection)?.label}</h2></div>
      <div className="workspace-sidebar-actions">
        <button type="button" className="button secondary workspace-sidebar-close" aria-label="Fechar painel" onClick={onClose}>Fechar</button>
        <button type="button" className="button secondary workspace-sidebar-collapse" aria-label="Recolher painel" aria-expanded={!collapsed} aria-controls="workspace-sidebar" onClick={onCollapse}>Recolher</button>
      </div>
    </div>

    <nav className="workspace-sidebar-nav" aria-label="Seções do painel">
      <div className="workspace-sidebar-tabs" role="tablist" aria-label="Seções de trabalho">
        {WORKSPACE_SECTIONS.map(({ id, label }) => <button
          key={id}
          id={`workspace-tab-${id}`}
          type="button"
          role="tab"
          aria-selected={activeSection === id}
          aria-controls={panelIdFor(id)}
          tabIndex={activeSection === id ? 0 : -1}
          className={`workspace-sidebar-tab${activeSection === id ? " is-active" : ""}`}
          onClick={() => onSelectSection(id)}
          onKeyDown={(event) => onTabKeyDown(event, id)}
        >{label}</button>)}
      </div>
    </nav>
    {children}
  </aside>;
}
