"use client";

import type { ReactNode } from "react";

export interface WorkspacePreviewProps {
  readonly children: ReactNode;
  readonly hasCards: boolean;
  readonly onOpenCards: (opener: HTMLButtonElement) => void;
}

export default function WorkspacePreview({ children, hasCards, onOpenCards }: WorkspacePreviewProps) {
  return <main className={`workspace-preview${hasCards ? "" : " is-empty"}`} aria-label="Preview e compositor atual">
    <div className="workspace-preview-content" aria-hidden={!hasCards}>
      {children}
    </div>
    {!hasCards && <div className="workspace-empty-state">
      <p className="eyebrow">TCGPrint · Preview físico</p>
      <h1>Nenhuma carta no Working Set</h1>
      <p>Adicione uma decklist ou arquivos em Cartas para visualizar o layout físico nesta área.</p>
      <button type="button" className="button primary" onClick={(event) => onOpenCards(event.currentTarget)}>Abrir Cartas</button>
    </div>}
  </main>;
}
