import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDatabase } from "../../persistence/projects/database";
import { ProjectRepository } from "../../persistence/projects/repository";
import { DEFAULT_PROJECT_SETTINGS, serializeProjectSnapshot, deserializeProjectSnapshot } from "../../persistence/projects/serializer";
import { TemplateRepository } from "../../persistence/templates/repository";
import { TemplateFileStore } from "../../templates/file-store";
import { TemplateLibraryService } from "../../services/template-library";
import { handleCutDxfExport, handleCutPreview, handleCutSvgExport } from "../../services/cut-api";
import type { CutPreviewDto } from "../../services/cut-api";
import { handleCardExport } from "../../services/card-api";
import type { CardWorkbench } from "../../services/card-workbench";
import { parseDxfCutGeometry } from "../../services/cut-geometry/dxf-parser";
import { parseSvgCutGeometry } from "../../services/cut-geometry/svg-parser";
import { compareCutGeometryMm } from "../../core/cut";
import type { WorkingCard } from "../../core/cards/types";

describe("cut preview and export API", () => {
  let directory: string | undefined;
  let database: ReturnType<typeof openProjectDatabase> | undefined;

  afterEach(async () => {
    database?.close();
    database = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("resolves the exact immutable source, previews skipped slots, and round-trips both exports", async () => {
    directory = await mkdtemp(join(tmpdir(), "tcgprint-cut-api-"));
    database = openProjectDatabase(join(directory, "projects.sqlite"));
    const templates = new TemplateRepository(database);
    const originalStorePath = join(directory, "originals");
    const fileStore = new TemplateFileStore(originalStorePath);
    const library = new TemplateLibraryService(templates, fileStore);
    let projectCounter = 0;
    const projects = new ProjectRepository(database, { idFactory: () => `cut-project-${++projectCounter}` });
    const templateGeometry = {
      orientation: "portrait" as const,
      cardOrientation: "portrait" as const,
      pageSizeMm: { widthMm: 210, heightMm: 297 },
      cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      rows: 1,
      columns: 2,
      slots: [
        { index: 0, row: 0, column: 0, xMm: 50, yMm: 100 },
        { index: 1, row: 0, column: 1, xMm: 130, yMm: 100 },
      ],
    };
    const svg = new Uint8Array(await readFile(join(process.cwd(), "tests/fixtures/cut/layout-sync.svg")));
    const divergentDxf = new Uint8Array(await readFile(join(process.cwd(), "tests/fixtures/cut/dxf-layout-sync-divergent.dxf")));
    const metadata = {
      name: "Cut fixture template",
      source: "TCGPrint test fixture",
      version: "v5",
      paper: "a4" as const,
      cardFormat: "standard" as const,
      orientation: "portrait" as const,
      registrationType: "none" as const,
      templateGeometry,
    };
    const version5 = await library.importTemplate(metadata, [
      { fileName: "template.svg", bytes: svg },
      { fileName: "alternate.dxf", bytes: divergentDxf },
    ]);
    const svgFile = version5.version.files.find(({ fileName }) => fileName === "template.svg")!;
    const packageHash = version5.version.packageHash;
    await library.importTemplate({ ...metadata, version: "v6" }, [{ fileName: "template-v6.svg", bytes: svg }], version5.templateId);

    const card: WorkingCard = {
      id: "card-1",
      quantity: 1,
      order: 0,
      importSource: { sourceId: "fixture-source", importKind: "text", entryKind: "card" },
      identityHints: { name: "Fixture card" },
      identity: null,
      identityResolution: { status: "unresolved", candidates: [], confirmed: false },
      faces: [{ id: "front", side: "front", name: "Fixture card" }],
      selectedArtworkByFace: {},
      localArtworkIds: [],
      mpcReferences: [],
      faceAssociations: [],
    };
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      cutSourceSelection: { fileId: svgFile.fileId, fileHash: svgFile.contentHash },
      layout: { rows: 1, columns: 2, skippedSlotIndices: [1], templateGeometry },
    };
    const snapshot = deserializeProjectSnapshot(serializeProjectSnapshot([card], settings));
    const project = projects.create(snapshot, { templateId: version5.templateId, version: "v5", packageHash });
    const body = { projectId: project.id, expectedRevision: project.revision };
    const request = () => new Request("http://localhost/api/cut/preview", { method: "POST", body: JSON.stringify(body) });

    const stalePdf = await handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: [card], options: {
        bleedMm: settings.bleedMm,
        cutGuides: settings.cutGuides,
        roundedCorners: settings.roundedCorners,
        pageOrientation: "landscape",
        cardOrientation: settings.cardOrientation,
        paperFormat: settings.paperFormat,
        cardFormat: settings.cardFormat,
        marginsMm: settings.marginsMm,
        horizontalGapMm: settings.horizontalGapMm,
        verticalGapMm: settings.verticalGapMm,
        registration: settings.registration,
        templateGeometry,
        layoutRows: 1,
        layoutColumns: 2,
        skippedSlotIndices: [1],
        projectId: project.id,
        expectedProjectRevision: project.revision,
      } }),
    }), {} as unknown as CardWorkbench, projects, library);
    expect(stalePdf.status).toBe(409);
    expect(await stalePdf.json()).toMatchObject({ code: "PROJECT_CUT_SYNC_STALE" });

    const manualSettings = {
      ...DEFAULT_PROJECT_SETTINGS,
      layout: { rows: 1, columns: 2, skippedSlotIndices: [1], templateGeometry },
    };
    const manualProject = projects.create(deserializeProjectSnapshot(serializeProjectSnapshot([card], manualSettings)));
    const staleManualPdf = await handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: [card], options: {
        bleedMm: manualSettings.bleedMm,
        cutGuides: manualSettings.cutGuides,
        roundedCorners: manualSettings.roundedCorners,
        pageOrientation: "landscape",
        cardOrientation: manualSettings.cardOrientation,
        paperFormat: manualSettings.paperFormat,
        cardFormat: manualSettings.cardFormat,
        marginsMm: manualSettings.marginsMm,
        horizontalGapMm: manualSettings.horizontalGapMm,
        verticalGapMm: manualSettings.verticalGapMm,
        registration: manualSettings.registration,
        templateGeometry,
        layoutRows: 1,
        layoutColumns: 2,
        skippedSlotIndices: [1],
        projectId: manualProject.id,
        expectedProjectRevision: manualProject.revision,
      } }),
    }), {} as unknown as CardWorkbench, projects, library);
    expect(staleManualPdf.status).toBe(409);
    expect(await staleManualPdf.json()).toMatchObject({ code: "PROJECT_CUT_SYNC_STALE" });

    const previewResponse = await handleCutPreview(request(), projects, library);
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as CutPreviewDto;
    if (!preview.activeGeometry || preview.activeGeometry.source.kind !== "template-file") throw new Error("Expected an active template cut geometry.");
    const activeGeometry = preview.activeGeometry;
    const activeSource = activeGeometry.source;
    if (activeSource.kind !== "template-file") throw new Error("Expected a template file source identity.");
    expect(preview.templateIdentity).toEqual({ templateId: version5.templateId, version: "v5", packageHash });
    expect(preview.geometry.source).toEqual({ kind: "template-file", templateId: version5.templateId, version: "v5", packageHash, fileId: svgFile.fileId, fileHash: svgFile.contentHash });
    expect(preview.slotPaths).toEqual([
      { slotIndex: 0, pathId: "card-a", state: "active" },
      { slotIndex: 1, pathId: "card-b", state: "skipped" },
    ]);
    expect(activeGeometry.paths.map(({ id }) => id)).toEqual(["card-a"]);
    expect(preview.alternateSources).toContainEqual(expect.objectContaining({ status: "divergent" }));

    const svgResponse = await handleCutSvgExport(request(), projects, library);
    const svgOutput = new Uint8Array(await svgResponse.arrayBuffer());
    const svgRoundTrip = parseSvgCutGeometry(svgOutput, { source: activeSource, expectedPageSizeMm: { widthMm: 210, heightMm: 297 } });
    expect(svgResponse.status).toBe(200);
    expect(compareCutGeometryMm(activeGeometry, svgRoundTrip, 0.000001).equal).toBe(true);
    expect(await (await handleCutSvgExport(request(), projects, library)).text()).toBe(new TextDecoder().decode(svgOutput));

    const dxfResponse = await handleCutDxfExport(request(), projects, library);
    const dxfOutput = new Uint8Array(await dxfResponse.arrayBuffer());
    const dxfRoundTrip = parseDxfCutGeometry(dxfOutput, { source: activeSource, expectedPageSizeMm: { widthMm: 210, heightMm: 297 } });
    expect(dxfResponse.status).toBe(200);
    expect(compareCutGeometryMm(activeGeometry, dxfRoundTrip, 0.000001).equal).toBe(true);

    const originalPath = join(originalStorePath, svgFile.contentHash.slice(0, 2), svgFile.contentHash);
    await unlink(originalPath);
    const missing = await handleCutPreview(request(), projects, library);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "CUT_SOURCE_INTEGRITY_FAILURE" });
    await fileStore.put(svg);
    await writeFile(originalPath, new Uint8Array([1, 2, 3]));
    const corrupt = await handleCutPreview(request(), projects, library);
    expect(corrupt.status).toBe(409);
    expect(await corrupt.json()).toMatchObject({ code: "CUT_SOURCE_INTEGRITY_FAILURE" });
  });
});
