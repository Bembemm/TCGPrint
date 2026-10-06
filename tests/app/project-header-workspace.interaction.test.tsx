// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentitySideCalibration, type PrinterProfileSnapshot } from "../../core/calibration";
import { createPhysicalOrder, type PhysicalOrder } from "../../core/cards/physical-instance-order";
import type { WorkingCard } from "../../core/cards/types";
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettingsV1, type ProjectSnapshotV1 } from "../../persistence/projects/serializer";
import type { ProjectDto } from "../../services/project-api";
import type { TemplateSelection } from "../../templates/types";
import ProjectsPanel from "../../src/app/projects-panel";
import { projectSaveStatusLabel } from "../../src/app/project-header";
import WorkspaceShell, { WORKSPACE_SECTIONS, type WorkspaceSection } from "../../src/app/workspace-shell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

const calibrationProfile: PrinterProfileSnapshot = {
  id: "printer-test",
  name: "Impressora de teste",
  front: createIdentitySideCalibration(),
  back: createIdentitySideCalibration(),
  paperSize: "A4",
  paperWidthMm: 210,
  paperHeightMm: 297,
  pageOrientation: "portrait",
  duplexMode: "single-sided",
  physicalValidationStatus: "software-only",
  version: 2,
  profileHash: "b".repeat(64),
};

function workingCard(id: string, order: number, quantity: number, artworkHex: string, backHex: string): WorkingCard {
  const identityId = `scryfall:oracle:${id}`;
  return {
    id,
    quantity,
    order,
    importSource: { sourceId: `source-${id}`, importKind: "fixture", entryKind: "card" },
    identityHints: { name: `Carta ${id}` },
    identity: { id: identityId, provider: "scryfall", name: `Carta ${id}`, resolutionMethod: "manual", confidence: 1 },
    identityResolution: { status: "resolved", method: "manual", confidence: 1, candidates: [], confirmed: true },
    faces: [{ id: "front", side: "front", name: `Carta ${id}` }, { id: "back", side: "back", name: `Verso ${id}` }],
    selectedArtworkByFace: {
      front: { candidateId: `upload:${artworkHex.repeat(64)}`, source: "upload", identityId: null, faceId: "front", selectionPolicy: "user-selected" },
      back: { candidateId: `upload:${backHex.repeat(64)}`, source: "upload", identityId: null, faceId: "back", selectionPolicy: "user-selected" },
    },
    manualBackArtwork: { candidateId: `upload:${backHex.repeat(64)}`, source: "upload", identityId: null, faceId: "back", selectionPolicy: "user-selected" },
    backMode: "manual",
    backModeSelectionPolicy: "explicit",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  };
}

function populatedDocument(): ProjectSnapshotV1 {
  const cards = [workingCard("working-a", 0, 2, "c", "d"), workingCard("working-b", 1, 1, "e", "f")];
  const physicalOrder: PhysicalOrder = {
    nextInstanceId: 4,
    instances: [
      { id: "instance-2", workingCardId: "working-a" },
      { id: "instance-3", workingCardId: "working-b" },
      { id: "instance-1", workingCardId: "working-a" },
    ],
  };
  const templateGeometry = {
    orientation: "portrait" as const,
    cardOrientation: "portrait" as const,
    pageSizeMm: { widthMm: 210, heightMm: 297 },
    cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
    rows: 1,
    columns: 1,
    slots: [{ index: 0, row: 0, column: 0, xMm: 73.25, yMm: 104.05 }],
  };
  const settings: ProjectSettingsV1 = {
    ...DEFAULT_PROJECT_SETTINGS,
    bleedMm: 1.125,
    roundedCorners: true,
    marginsMm: { top: 3, right: 4, bottom: 5, left: 6 },
    projectDefaultBack: { assetId: `back:${"9".repeat(64)}`, sha256: "9".repeat(64), format: "png" },
    printerProfileSelection: calibrationProfile,
    layout: { rows: 1, columns: 1, skippedSlotIndices: [], templateGeometry },
    cutSourceSelection: { fileId: "cut-source-file", fileHash: "8".repeat(64), dxfUnitsOverride: "mm" },
  };
  return { projectSchemaVersion: 6, cards, settings, physicalOrder };
}

function installProjectApi() {
  const projects: ProjectDto[] = [];
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  let sequence = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ url, method, body });
    if (url === "/api/projects" && method === "GET") {
      return Response.json({ projects: projects.map(({ snapshot: _snapshot, templateSelection: _selection, ...metadata }) => metadata) });
    }
    if (url === "/api/projects" && method === "POST") {
      sequence += 1;
      const project: ProjectDto = {
        id: `project-${sequence}`,
        name: `Project ${sequence}`,
        projectSchemaVersion: 2,
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        snapshot: body?.snapshot as ProjectSnapshotV1,
        templateSelection: (body?.templateSelection ?? null) as TemplateSelection | null,
      };
      projects.unshift(project);
      return Response.json(project);
    }
    if (url === "/api/templates") return Response.json({ templates: [templateRecord] });
    if (url.startsWith("/api/templates/template-m4/versions/1/verify")) {
      const selection = { templateId: "template-m4", version: "1", packageHash: templateVersion.packageHash };
      return Response.json({ selection, status: "available", version: templateVersion, files: [] });
    }
    if (url === "/api/cut/preview") return Response.json({ message: "No cut preview fixture." }, { status: 404 });
    const duplicateMatch = /^\/api\/projects\/([^/]+)\/duplicate$/.exec(url);
    if (duplicateMatch && method === "POST") {
      const original = projects.find(({ id }) => id === duplicateMatch[1]);
      if (!original) return Response.json({ message: "Not found" }, { status: 404 });
      const copy = { ...original, id: `project-${++sequence}`, name: `${original.name} (cópia)`, revision: 1 };
      projects.unshift(copy);
      return Response.json(copy);
    }
    const detailMatch = /^\/api\/projects\/([^/]+)$/.exec(url);
    if (detailMatch && method === "GET") {
      const project = projects.find(({ id }) => id === detailMatch[1]);
      return project ? Response.json({ ...project, recovery: null }) : Response.json({ message: "Not found" }, { status: 404 });
    }
    if (detailMatch && method === "PUT") {
      const index = projects.findIndex(({ id }) => id === detailMatch[1]);
      if (index < 0 || !body) return Response.json({ message: "Not found" }, { status: 404 });
      const project = { ...projects[index], revision: projects[index].revision + 1, snapshot: body.snapshot as ProjectSnapshotV1, templateSelection: (body.templateSelection ?? null) as TemplateSelection | null };
      projects[index] = project;
      return Response.json(project);
    }
    if (detailMatch && method === "DELETE") {
      const index = projects.findIndex(({ id }) => id === detailMatch[1]);
      if (index >= 0) projects.splice(index, 1);
      return Response.json({ deleted: true, id: detailMatch[1] });
    }
    return Response.json({ message: "Rota não simulada." }, { status: 404 });
  }));
  return { requests, projects };
}

function projectWorkspace(initialSnapshot: ProjectSnapshotV1) {
  function Harness() {
    const [snapshot, setSnapshot] = useState(initialSnapshot);
    const sections = Object.fromEntries(WORKSPACE_SECTIONS.map(({ id }) => [id, <p key={id}>{id}</p>])) as Record<WorkspaceSection, React.ReactNode>;
    return <>
      <WorkspaceShell
        sections={sections}
        preview={<div aria-label="Preview central" />}
        hasCards={snapshot.cards.length > 0}
        sharedPanel={{
          id: "workspace-settings-export-panel",
          sections: ["settings", "export"],
          content: (activeSection) => <ProjectsPanel
            view={activeSection === "export" ? "export" : "settings"}
            cards={snapshot.cards}
            physicalOrder={snapshot.physicalOrder}
            settings={snapshot.settings}
            onProjectOpen={(project) => setSnapshot(project.snapshot)}
            selectedCutPageNumber={1}
            onCutPageNumberChange={vi.fn()}
          />,
        }}
      />
      <output aria-label="Working Set atual">{JSON.stringify(snapshot)}</output>
    </>;
  }
  return <Harness />;
}

async function associateTemplate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Configurações" }));
  await user.click(await screen.findByRole("button", { name: "Associar ao Project" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Associado" })).toHaveAttribute("aria-pressed", "true"));
}

describe("Project header lifecycle", () => {
  it.each([
    ["Salvo", "Salvo"],
    ["Dirty", "Alterações pendentes"],
    ["Salvando", "Salvando…"],
    ["Erro", "Erro"],
    ["Conflito", "Conflito"],
  ] as const)("maps %s to the product status %s", (status, label) => {
    expect(projectSaveStatusLabel(status)).toBe(label);
  });

  it("saves the complete current Working Set as a new Project and reopens the saved snapshot", async () => {
    const user = userEvent.setup();
    const api = installProjectApi();
    render(projectWorkspace(populatedDocument()));
    await associateTemplate(user);
    await user.click(screen.getByRole("button", { name: "Salvar como projeto" }));

    await waitFor(() => expect(api.projects).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo"));
    const createRequest = api.requests.find(({ url, method }) => url === "/api/projects" && method === "POST");
    expect(createRequest?.body).toMatchObject({
      snapshot: {
        cards: [
          { id: "working-a", quantity: 2, identity: { name: "Carta working-a" }, selectedArtworkByFace: { front: { candidateId: `upload:${"c".repeat(64)}` } }, manualBackArtwork: { candidateId: `upload:${"d".repeat(64)}` } },
          { id: "working-b", quantity: 1, identity: { name: "Carta working-b" } },
        ],
        physicalOrder: {
          nextInstanceId: 4,
          instances: [
            { id: "instance-2", workingCardId: "working-a" },
            { id: "instance-3", workingCardId: "working-b" },
            { id: "instance-1", workingCardId: "working-a" },
          ],
        },
        settings: {
          bleedMm: 1.125,
          roundedCorners: true,
          marginsMm: { top: 3, right: 4, bottom: 5, left: 6 },
          printerProfileSelection: { id: "printer-test", version: 2 },
          cutSourceSelection: { fileId: "cut-source-file", fileHash: "8".repeat(64) },
          layout: { templateGeometry: expect.any(Object) },
        },
      },
      templateSelection: { templateId: "template-m4", version: "1", packageHash: "a".repeat(64) },
    });
    expect(api.requests.filter(({ url, method }) => url === "/api/projects/project-1" && method === "PUT")).toHaveLength(0);
    expect(api.requests.filter(({ url, method }) => url.startsWith("/api/projects/project-1/recovery") && method !== "GET")).toHaveLength(0);
    expect(screen.getByText("Project 1")).toBeInTheDocument();

    const menu = screen.getByRole("button", { name: "Abrir menu do Project" });
    await user.click(menu);
    await user.click(screen.getByRole("button", { name: "Abrir projeto" }));
    const dialog = await screen.findByRole("dialog", { name: "Abrir projeto" });
    await user.click(within(dialog).getByRole("button", { name: "Abrir Project 1" }));
    await waitFor(() => expect(screen.getByText("Project selecionado:")).toBeInTheDocument());
    expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo");
    expect(JSON.parse(screen.getByLabelText("Working Set atual").textContent ?? "{}")).toMatchObject({
      cards: [{
        id: "working-a",
        quantity: 2,
        identity: { name: "Carta working-a" },
        selectedArtworkByFace: { front: { candidateId: `upload:${"c".repeat(64)}` } },
        manualBackArtwork: { candidateId: `upload:${"d".repeat(64)}` },
        backMode: "manual",
      }, { id: "working-b", quantity: 1 }],
      physicalOrder: { instances: [{ id: "instance-2" }, { id: "instance-3" }, { id: "instance-1" }] },
      settings: {
        bleedMm: 1.125,
        projectDefaultBack: { assetId: `back:${"9".repeat(64)}` },
        printerProfileSelection: { id: "printer-test", version: 2 },
        cutSourceSelection: { fileId: "cut-source-file", fileHash: "8".repeat(64) },
        layout: { templateGeometry: expect.any(Object) },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(api.requests.filter(({ url, method }) => url === "/api/projects/project-1" && method === "PUT")).toHaveLength(0);
  });

  it("starts a clean Project from a populated session and never autosaves the old snapshot into it", async () => {
    const user = userEvent.setup();
    const api = installProjectApi();
    render(projectWorkspace(populatedDocument()));
    await associateTemplate(user);
    await user.click(screen.getByRole("button", { name: "Salvar como projeto" }));
    await waitFor(() => expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo"));

    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    await user.click(screen.getByRole("button", { name: "Novo projeto" }));
    await waitFor(() => expect(api.requests.filter(({ url, method }) => url === "/api/projects" && method === "POST")).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 520));

    const newProject = api.projects.find(({ id }) => id === "project-2");
    expect(newProject?.snapshot).toMatchObject({
      cards: [],
      physicalOrder: { nextInstanceId: 1, instances: [] },
      settings: {
        bleedMm: DEFAULT_PROJECT_SETTINGS.bleedMm,
        projectDefaultBack: null,
        printerProfileSelection: null,
        cutSourceSelection: null,
        layout: { skippedSlotIndices: [] },
      },
    });
    expect(newProject?.templateSelection).toBeNull();
    expect(api.requests.filter(({ url, method }) => url === "/api/projects/project-2" && method === "PUT")).toHaveLength(0);
    expect(api.requests.filter(({ url, method }) => url.startsWith("/api/projects/project-2/recovery") && method !== "GET")).toHaveLength(0);
    expect(newProject?.snapshot.cards).toEqual([]);
    expect(JSON.parse(screen.getByLabelText("Working Set atual").textContent ?? "{}")).toMatchObject({
      cards: [],
      physicalOrder: { nextInstanceId: 1, instances: [] },
      settings: { bleedMm: DEFAULT_PROJECT_SETTINGS.bleedMm, printerProfileSelection: null, cutSourceSelection: null },
    });
    expect(screen.getByText("Project 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Estado do salvamento")).toHaveTextContent("Salvo");
    expect(screen.queryByText("Project selecionado:")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abrir menu do Project" }));
    expect(screen.getByRole("button", { name: "Duplicar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Excluir" })).toBeInTheDocument();
  });
});
