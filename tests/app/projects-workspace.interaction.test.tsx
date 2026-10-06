// @vitest-environment jsdom
import type { ReactNode } from "react";
import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import { createPhysicalOrder } from "../../core/cards/physical-instance-order";
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
    view={activeSection === "export" ? "export" : "settings"}
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
        id: "workspace-settings-export-panel",
        sections: ["settings", "export"],
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
  it("shows an unsaved Project in the persistent header and restores menu focus on Escape", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/projects"
      ? Response.json({ projects: [] })
      : Response.json({ templates: [] })));
    const { view } = projectWorkspace();
    render(view);

    expect(await screen.findByText("Projeto não salvo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar como projeto" })).toBeInTheDocument();
    const menu = screen.getByRole("button", { name: "Abrir menu do Project" });
    await user.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Novo projeto" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir projeto" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveFocus();

    await user.click(menu);
    await user.click(screen.getByRole("button", { name: "Abrir projeto" }));
    const projectDialog = await screen.findByRole("dialog", { name: "Abrir projeto" });
    expect(projectDialog).toHaveAttribute("aria-modal", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Abrir projeto" })).not.toBeInTheDocument();
    expect(menu).toHaveFocus();
  });

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

    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Novo projeto" }));
    await waitFor(() => expect(screen.getByText("Project M4")).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Configurações" }));

    const templateName = screen.getByRole("textbox", { name: "Nome" });
    await user.clear(templateName);
    await user.type(templateName, "Rascunho de template");
    await user.click(screen.getByRole("button", { name: "Associar ao Project" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Associado" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByText("Project M4")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo"));

    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    expect(screen.getByRole("heading", { name: "SVG/DXF Cut Export" })).toBeInTheDocument();
    const cutExport = screen.getByRole("region", { name: "SVG e DXF Cut" });
    await within(cutExport).findByText(/Project project-m4 · revisão 2/);
    const cutPreviewCalls = requests.filter(({ url }) => url === "/api/cut/preview").length;
    expect(requests.filter(({ url }) => url === "/api/cut/preview").map(({ method }) => method)).toEqual(["POST", "POST"]);

    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    expect(screen.getByRole("textbox", { name: "Nome" })).toHaveValue("Rascunho de template");
    expect(screen.getByRole("button", { name: "Associado" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Project M4")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    expect(screen.getByRole("button", { name: /Exportar SVG Cut/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exportar DXF Cut/ })).toBeInTheDocument();
    expect(requests.filter(({ url }) => url === "/api/cut/preview")).toHaveLength(cutPreviewCalls);
    expect(requests.filter(({ url }) => url === "/api/templates")).toHaveLength(1);
    expect(requests.filter(({ url, method }) => url === "/api/projects" && method === "POST")).toHaveLength(1);
    expect(onCutGeometryPreviewChange).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-m4", projectRevision: 2 }));
    expect(requests.filter(({ url }) => url === "/api/cut/preview").map(({ url }) => url)).toEqual(["/api/cut/preview", "/api/cut/preview"]);
  });

  it("keeps Project open, manual save, autosave, duplicate, and delete available from the header", async () => {
    const user = userEvent.setup();
    const snapshot = () => ({
      projectSchemaVersion: 6,
      cards: [],
      settings: DEFAULT_PROJECT_SETTINGS,
      physicalOrder: createPhysicalOrder([]),
    });
    let savedProject = {
      id: "project-lifecycle",
      name: "Project lifecycle",
      projectSchemaVersion: 2,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      snapshot: snapshot(),
      templateSelection: null as unknown,
    };
    let projects = [savedProject];
    let duplicatedProject: typeof savedProject | null = null;
    let pendingRecovery: { snapshot: typeof savedProject.snapshot; templateSelection?: unknown } | null = null;
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const opened = vi.fn();
    const cutPageChange = vi.fn();
    const cutPreviewChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      requests.push({ url, method, body });
      if (url === "/api/projects" && method === "GET") {
        return Response.json({ projects: projects.map(({ id, name, projectSchemaVersion, revision, createdAt, updatedAt }) => ({
          id, name, projectSchemaVersion, revision, createdAt, updatedAt,
        })) });
      }
      if (url === "/api/projects" && method === "POST") return Response.json(savedProject);
      if (url === "/api/projects/project-lifecycle" && method === "GET") return Response.json({ ...savedProject, recovery: null });
      if (url === "/api/projects/project-copy" && method === "GET") {
        const duplicate = projects.find(({ id }) => id === "project-copy");
        return duplicate ? Response.json({ ...duplicate, recovery: null }) : Response.json({ message: "Not found" }, { status: 404 });
      }
      if (url === "/api/projects/project-lifecycle/recovery" && method === "POST") {
        const save = body as { snapshot: typeof savedProject.snapshot; templateSelection?: unknown };
        pendingRecovery = save;
        return Response.json({ recovery: { baseRevision: savedProject.revision } });
      }
      if (url === "/api/projects/project-lifecycle/recovery/promote" && method === "POST" && pendingRecovery) {
        savedProject = {
          ...savedProject,
          revision: savedProject.revision + 1,
          snapshot: pendingRecovery.snapshot,
          templateSelection: pendingRecovery.templateSelection ?? null,
        };
        pendingRecovery = null;
        return Response.json(savedProject);
      }
      if (url === "/api/projects/project-lifecycle/duplicate" && method === "POST") {
        duplicatedProject = { ...savedProject, id: "project-copy", name: "Project lifecycle (cópia)", revision: 1 };
        projects = [...projects, duplicatedProject];
        return Response.json(duplicatedProject);
      }
      if (url === "/api/projects/project-copy" && method === "DELETE") {
        projects = projects.filter(({ id }) => id !== "project-copy");
        return Response.json({ deleted: true, id: "project-copy" });
      }
      if (url === "/api/templates") return Response.json({ templates: [] });
      if (url === "/api/cut/preview") {
        const request = body as { projectId: string; expectedRevision: number };
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
      return Response.json({ message: `Rota não simulada: ${url}` }, { status: 404 });
    }));

    function LifecycleWorkspace() {
      const [settings, setSettings] = useState(DEFAULT_PROJECT_SETTINGS);
      const sections = { cards: <p>cards</p>, settings: <p>settings</p>, export: <p>export</p> };
      return <WorkspaceShell
        sections={sections}
        preview={<div />}
        hasCards
        sharedPanel={{
          id: "workspace-settings-export-panel",
          sections: ["settings", "export"],
          content: (activeSection: WorkspaceSection) => <>
            <div hidden={activeSection !== "settings"}>
              <button type="button" onClick={() => setSettings((current) => ({
                ...current,
                pageOrientation: current.pageOrientation === "portrait" ? "landscape" : "portrait",
              }))}>Alterar configuração do Project</button>
            </div>
            <ProjectsPanel
              view={activeSection === "export" ? "export" : "settings"}
              cards={[]}
              physicalOrder={createPhysicalOrder([])}
              settings={settings}
              onProjectOpen={opened}
              selectedCutPageNumber={1}
              onCutPageNumberChange={cutPageChange}
              onCutGeometryPreviewChange={cutPreviewChange}
            />
          </>,
        }}
      />;
    }

    render(<LifecycleWorkspace />);
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Abrir projeto" }));
    const openDialog = await screen.findByRole("dialog", { name: "Abrir projeto" });
    await user.click(within(openDialog).getByRole("button", { name: "Abrir Project lifecycle" }));
    await waitFor(() => expect(screen.getByText("Project lifecycle")).toBeInTheDocument());
    expect(opened).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Alterar configuração do Project" }));
    const saveState = screen.getByLabelText("Estado do salvamento");
    await waitFor(() => expect(saveState).toHaveTextContent("Alterações pendentes"));
    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    const saveNow = screen.getByRole("button", { name: "Salvar agora" });
    expect(saveNow).toBeEnabled();
    await user.click(saveNow);
    await waitFor(() => expect(savedProject.revision).toBe(2));
    await waitFor(() => expect(saveState).toHaveTextContent("Salvo"));

    await user.click(screen.getByRole("button", { name: "Alterar configuração do Project" }));
    await waitFor(() => expect(saveState).toHaveTextContent("Alterações pendentes"));
    await waitFor(() => expect(savedProject.revision).toBe(3), { timeout: 3_000 });
    await waitFor(() => expect(saveState).toHaveTextContent("Salvo"));

    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    await within(screen.getByRole("tabpanel", { name: "Exportar" })).findByRole("region", { name: "SVG e DXF Cut" });
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    expect(screen.getByText("Project lifecycle")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Duplicar" }));
    expect(duplicatedProject).toMatchObject({
      id: "project-copy",
      revision: 1,
      snapshot: { settings: { pageOrientation: "portrait" } },
    });
    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Abrir projeto" }));
    const duplicateDialog = await screen.findByRole("dialog", { name: "Abrir projeto" });
    await user.click(within(duplicateDialog).getByRole("button", { name: "Abrir Project lifecycle (cópia)" }));
    await waitFor(() => expect(screen.getByText("Project lifecycle (cópia)")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(screen.getByText("Projeto não salvo")).toBeInTheDocument());
    expect(opened).toHaveBeenCalledTimes(2);

    expect(requests.filter(({ url, method }) => url === "/api/projects/project-lifecycle/recovery" && method === "POST")).toHaveLength(2);
    expect(requests.filter(({ url, method }) => url === "/api/projects/project-lifecycle/recovery/promote" && method === "POST")).toHaveLength(2);
    expect(requests.filter(({ url }) => url === "/api/projects/project-lifecycle/duplicate")).toHaveLength(1);
    expect(requests.filter(({ url, method }) => url === "/api/projects/project-copy" && method === "DELETE")).toHaveLength(1);
    expect(requests.filter(({ url }) => url === "/api/cut/preview").map(({ body }) => (body as { expectedRevision: number }).expectedRevision)).toEqual([1, 2, 3, 1]);
    expect(requests.filter(({ url }) => url === "/api/templates")).toHaveLength(1);
  });

  it("keeps a recovery choice visible and actionable after switching to Exportar", async () => {
    const user = userEvent.setup();
    const savedProject = {
      id: "project-recovery",
      name: "Project com recovery",
      projectSchemaVersion: 2,
      revision: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      snapshot: {
        projectSchemaVersion: 6,
        cards: [],
        settings: DEFAULT_PROJECT_SETTINGS,
        physicalOrder: createPhysicalOrder([]),
      },
      templateSelection: null,
    };
    const openedProject = {
      ...savedProject,
      recovery: {
        baseRevision: savedProject.revision,
        projectSchemaVersion: 2,
        snapshot: savedProject.snapshot,
        templateSelection: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json({ projects: [{
        id: savedProject.id,
        name: savedProject.name,
        projectSchemaVersion: savedProject.projectSchemaVersion,
        revision: savedProject.revision,
        createdAt: savedProject.createdAt,
        updatedAt: savedProject.updatedAt,
      }] });
      if (url === "/api/projects/project-recovery") return Response.json(openedProject);
      if (url === "/api/templates") return Response.json({ templates: [] });
      return Response.json({ message: `Rota não simulada: ${url}` }, { status: 404 });
    }));

    const sections = { cards: <p>cards</p>, settings: <p>settings</p>, export: <p>export</p> };
    render(<WorkspaceShell
      sections={sections}
      preview={<div />}
      hasCards
      sharedPanel={{
        id: "workspace-settings-export-panel",
        sections: ["settings", "export"],
        content: (activeSection: WorkspaceSection) => <ProjectsPanel
          view={activeSection === "export" ? "export" : "settings"}
          cards={[]}
          settings={DEFAULT_PROJECT_SETTINGS}
          onProjectOpen={vi.fn()}
          selectedCutPageNumber={1}
          onCutPageNumberChange={vi.fn()}
        />,
      }}
    />);

    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Abrir projeto" }));
    const projectsDialog = await screen.findByRole("dialog", { name: "Abrir projeto" });
    await user.click(within(projectsDialog).getByRole("button", { name: "Abrir Project com recovery" }));
    const recoveryDialog = await screen.findByRole("dialog", { name: "Autosave recuperado" });
    const restoreRecovery = within(recoveryDialog).getByRole("button", { name: "Restaurar recuperação" });
    expect(restoreRecovery).toBeEnabled();

    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    expect(screen.getByRole("dialog", { name: "Autosave recuperado" })).toBe(recoveryDialog);
    const keepCurrent = within(recoveryDialog).getByRole("button", { name: "Manter Working Set atual" });
    expect(keepCurrent).toBeEnabled();
    keepCurrent.focus();
    await user.tab();
    expect(restoreRecovery).toHaveFocus();
    await user.click(keepCurrent);
    expect(screen.queryByRole("dialog", { name: "Autosave recuperado" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Cartas", "Configurações", "Exportar"]);
  });

  it("keeps Project revision conflict recovery visible and actionable on Exportar", async () => {
    const user = userEvent.setup();
    const initialSnapshot = {
      projectSchemaVersion: 6,
      cards: [],
      settings: DEFAULT_PROJECT_SETTINGS,
      physicalOrder: createPhysicalOrder([]),
    };
    const savedProject = {
      id: "project-conflict",
      name: "Project com conflito",
      projectSchemaVersion: 2,
      revision: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      snapshot: initialSnapshot,
      templateSelection: null,
    };
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/projects") return Response.json({ projects: [{
        id: savedProject.id,
        name: savedProject.name,
        projectSchemaVersion: savedProject.projectSchemaVersion,
        revision: savedProject.revision,
        createdAt: savedProject.createdAt,
        updatedAt: savedProject.updatedAt,
      }] });
      if (url === "/api/projects/project-conflict") return Response.json({ ...savedProject, recovery: null });
      if (url === "/api/projects/project-conflict/recovery") return Response.json({ recovery: {
        baseRevision: savedProject.revision,
        projectSchemaVersion: savedProject.projectSchemaVersion,
        snapshot: initialSnapshot,
        templateSelection: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      } });
      if (url === "/api/projects/project-conflict/recovery/promote") {
        return Response.json({ message: "A revisão foi atualizada em outra sessão." }, { status: 409 });
      }
      if (url === "/api/templates") return Response.json({ templates: [] });
      return Response.json({ message: `Rota não simulada: ${url}` }, { status: 404 });
    }));

    function ConflictWorkspace() {
      const [settings, setSettings] = useState(DEFAULT_PROJECT_SETTINGS);
      const sections = { cards: <p>cards</p>, settings: <p>settings</p>, export: <p>export</p> };
      return <WorkspaceShell
        sections={sections}
        preview={<div />}
        hasCards
        sharedPanel={{
          id: "workspace-settings-export-panel",
          sections: ["settings", "export"],
          content: (activeSection: WorkspaceSection) => <>
            <div hidden={activeSection !== "settings"}>
              <button type="button" onClick={() => setSettings((current) => ({
                ...current,
                pageOrientation: current.pageOrientation === "portrait" ? "landscape" : "portrait",
              }))}>Alterar configuração do Project</button>
            </div>
            <ProjectsPanel
              view={activeSection === "export" ? "export" : "settings"}
              cards={[]}
              physicalOrder={createPhysicalOrder([])}
              settings={settings}
              onProjectOpen={vi.fn()}
              selectedCutPageNumber={1}
              onCutPageNumberChange={vi.fn()}
            />
          </>,
        }}
      />;
    }

    render(<ConflictWorkspace />);
    await user.click(screen.getByRole("tab", { name: "Configurações" }));
    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Abrir projeto" }));
    const projectsDialog = await screen.findByRole("dialog", { name: "Abrir projeto" });
    await user.click(within(projectsDialog).getByRole("button", { name: "Abrir Project com conflito" }));
    await waitFor(() => expect(screen.getByText("Project com conflito")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Alterar configuração do Project" }));
    await waitFor(() => expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Conflito"));

    await user.click(screen.getByRole("tab", { name: "Exportar" }));
    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    const conflict = screen.getByRole("region", { name: "Conflito de revisão" });
    expect(within(conflict).getByRole("button", { name: "Salvar cópia local como novo Project" })).toBeEnabled();
    expect(within(conflict).getByRole("button", { name: "Descartar alterações locais e abrir a versão atual" })).toBeEnabled();
    expect(requests).toContain("/api/projects/project-conflict/recovery/promote");
  });
});
