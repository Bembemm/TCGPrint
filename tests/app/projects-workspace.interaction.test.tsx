// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import ProjectsPanel from "../../src/app/projects-panel";
import WorkspaceShell, { WORKSPACE_SECTIONS, type WorkspaceSection } from "../../src/app/workspace-shell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function projectWorkspace() {
  const sections = Object.fromEntries(WORKSPACE_SECTIONS.map(({ id }) => [id, <p key={id}>{id}</p>])) as Record<WorkspaceSection, ReactNode>;
  const emptyCards: never[] = [];
  const onCutGeometryPreviewChange = vi.fn();
  const onCutPageNumberChange = vi.fn();
  const panel = (activeSection: WorkspaceSection) => <ProjectsPanel
    view={activeSection === "project" ? "project" : activeSection === "templates" ? "templates" : activeSection === "cut" ? "cut" : "hidden"}
    cards={emptyCards}
    settings={DEFAULT_PROJECT_SETTINGS}
    onProjectOpen={vi.fn()}
    selectedCutPageNumber={1}
    onCutPageNumberChange={onCutPageNumberChange}
    onCutGeometryPreviewChange={onCutGeometryPreviewChange}
  />;

  return {
    onCutGeometryPreviewChange,
    view: <WorkspaceShell
      sections={sections}
      preview={<div aria-label="Preview central" />}
      hasCards
      sharedPanel={{
    id: "workspace-project-settings-panel",
    sections: ["project", "layout", "pdf", "cut", "templates"],
        content: panel,
      }}
    />,
  };
}

const templateVersion = {
  templateId: "template-m4",
  name: "Template M4",
  source: "Fixture",
  version: "1",
  paper: "a4",
  cardFormat: "standard",
  orientation: "portrait",
  registrationType: "none",
  packageHash: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  files: [],
};
const templateRecord = {
  id: "template-m4",
  name: "Template M4",
  source: "Fixture",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  versions: [templateVersion],
};

describe("shared Project, template, and cut session in the workspace", () => {
  it("keeps the Project save state, Template draft, and cut revision work attached across section changes", async () => {
    const user = userEvent.setup();
    const requests: { url: string; method: string }[] = [];
    let savedProject: Record<string, unknown> | null = null;
    let pendingRecovery: { snapshot: unknown; templateSelection?: unknown } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url === "/api/projects" && method === "GET") {
        const projects = savedProject ? [{
          id: savedProject.id,
          name: savedProject.name,
          projectSchemaVersion: savedProject.projectSchemaVersion,
          revision: savedProject.revision,
          createdAt: savedProject.createdAt,
          updatedAt: savedProject.updatedAt,
        }] : [];
        return Response.json({ projects });
      }
      if (url === "/api/projects" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { snapshot: unknown; templateSelection?: unknown };
        savedProject = {
          id: "project-m4",
          name: "Project M4",
          projectSchemaVersion: 2,
          revision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          snapshot: body.snapshot,
          templateSelection: body.templateSelection ?? null,
        };
        return Response.json(savedProject);
      }
      if (url.endsWith("/recovery") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { snapshot: unknown; templateSelection?: unknown };
        pendingRecovery = body;
        return Response.json({ recovery: { baseRevision: savedProject?.revision } });
      }
      if (url.endsWith("/recovery/promote") && method === "POST" && savedProject && pendingRecovery) {
        savedProject = { ...savedProject, revision: Number(savedProject.revision) + 1, snapshot: pendingRecovery.snapshot, templateSelection: pendingRecovery.templateSelection ?? null };
        pendingRecovery = null;
        return Response.json(savedProject);
      }
      if (url === "/api/templates") return Response.json({ templates: [templateRecord] });
      if (url.startsWith("/api/templates/template-m4/versions/1/verify")) {
        const selection = { templateId: "template-m4", version: "1", packageHash: templateVersion.packageHash };
        return Response.json({ selection, status: "available", version: templateVersion, files: [] });
      }
      if (url === "/api/cut/preview") {
        const request = JSON.parse(String(init?.body)) as { projectId: string; expectedRevision: number };
        const geometry = {
          modelVersion: 1,
          units: "mm",
          coordinateFrame: "page-top-left-y-down",
          pageSizeMm: { widthMm: 210, heightMm: 297 },
          source: { kind: "project-layout", projectId: request.projectId, projectRevision: request.expectedRevision },
          paths: [],
          boundsMm: { xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 },
        };
        const layout = { pageSizeMm: { widthMm: 210, heightMm: 297 }, cardSizeMm: { widthMm: 63.5, heightMm: 88.9 }, rows: 1, columns: 1, capacity: 1 };
        return Response.json({
          projectId: request.projectId,
          projectRevision: request.expectedRevision,
          templateIdentity: null,
          parserVersion: "fixture",
          geometry,
          activeGeometry: geometry,
          slotPaths: [],
          pageCount: 1,
          pages: [{ pageNumber: 1, firstCardNumber: 1, lastCardNumber: 0, geometry, activeGeometry: geometry, slotPaths: [], layout }],
          alternateSources: [],
          layout,
        });
      }
      return Response.json({ message: "Rota não simulada." }, { status: 404 });
    }));

    const { view, onCutGeometryPreviewChange } = projectWorkspace();
    render(view);

    await user.click(screen.getByRole("tab", { name: "Projeto" }));
    await user.click(screen.getByRole("button", { name: "Criar Project vazio" }));
    await waitFor(() => expect(screen.getByText("Aberto: Project M4 · revisão 1")).toBeInTheDocument());

    await user.click(screen.getByRole("tab", { name: "Templates" }));
    const templateName = screen.getByRole("textbox", { name: "Nome" });
    await user.clear(templateName);
    await user.type(templateName, "Rascunho de template");
    await user.click(screen.getByRole("button", { name: "Associar ao Project" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Associado" })).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(screen.getByText("Aberto: Project M4 · revisão 2")).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Projeto" }));
    expect(screen.getByText("Aberto: Project M4 · revisão 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo");

    await user.click(screen.getByRole("tab", { name: "Layout" }));
    expect(screen.queryByRole("region", { name: "Projects" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Projeto" }));
    expect(screen.getByText("Aberto: Project M4 · revisão 2")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Corte" }));
    expect(screen.getByRole("heading", { name: "SVG/DXF Cut Export" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Project project-m4 · revisão 2/)).toBeInTheDocument());
    const cutPreviewCalls = requests.filter(({ url }) => url === "/api/cut/preview").length;
    expect(requests.filter(({ url }) => url === "/api/cut/preview").map(({ method }) => method)).toEqual(["POST", "POST"]);
    await user.click(screen.getByRole("tab", { name: "Templates" }));
    expect(screen.getByRole("textbox", { name: "Nome" })).toHaveValue("Rascunho de template");
    expect(screen.getByRole("button", { name: "Associado" })).toHaveAttribute("aria-pressed", "true");
    expect(requests.filter(({ url }) => url === "/api/cut/preview")).toHaveLength(cutPreviewCalls);
    expect(requests.filter(({ url }) => url === "/api/templates")).toHaveLength(1);
    expect(requests.filter(({ url, method }) => url === "/api/projects" && method === "POST")).toHaveLength(1);
    expect(onCutGeometryPreviewChange).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-m4", projectRevision: 2 }));
    expect(requests.filter(({ url }) => url === "/api/cut/preview").map(({ url }) => url)).toEqual(["/api/cut/preview", "/api/cut/preview"]);
  });
});
