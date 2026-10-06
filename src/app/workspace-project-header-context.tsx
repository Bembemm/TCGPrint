"use client";

import { createContext, useContext } from "react";

export const WorkspaceProjectHeaderContext = createContext<HTMLElement | null>(null);

export function useWorkspaceProjectHeaderHost(): HTMLElement | null {
  return useContext(WorkspaceProjectHeaderContext);
}
