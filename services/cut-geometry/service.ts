import { PAPER_FORMATS, type PageOrientation, type PaperFormat } from "../../core/geometry";
import { compareCutGeometryMm, type CutGeometryMm, type CutSourceIdentity, type DxfUnitsOverride } from "../../core/cut";
import type { ProjectRecord } from "../../persistence/projects/repository";
import { ProjectRepositoryError, ProjectRepository } from "../../persistence/projects/repository";
import type { TemplateFileRecord, TemplateVersionRecord } from "../../persistence/templates/repository";
import type { TemplateSelectionInspection, TemplateLibraryService } from "../template-library";
import { CutSourceError } from "./errors";
import { parseDxfCutGeometry } from "./dxf-parser";
import { resolveCutLayout, type CutLayoutResolution } from "./layout-sync";
import { parseSvgCutGeometry } from "./svg-parser";

export const CUT_GEOMETRY_PARSER_VERSION = "11.1";
const MAX_ALTERNATE_SOURCES_TO_COMPARE = 8;

export interface CutAlternativeSourceStatus {
  readonly fileId: string;
  readonly fileName: string;
  readonly status: "equivalent" | "divergent" | "unreadable" | "not-compared";
  readonly message?: string;
}

export interface CutProjectResolution {
  readonly project: ProjectRecord;
  readonly layout: CutLayoutResolution;
  readonly alternateSources: readonly CutAlternativeSourceStatus[];
  readonly templateIdentity: ProjectRecord["templateSelection"];
}

const STANDARD_PAPER: Readonly<Record<string, PaperFormat>> = Object.freeze({
  a4: PAPER_FORMATS.A4,
  a3: PAPER_FORMATS.A3,
  letter: PAPER_FORMATS.LETTER,
  legal: PAPER_FORMATS.LEGAL,
  tabloid: PAPER_FORMATS.TABLOID,
});

function orientPaper(size: PaperFormat, orientation: PageOrientation): PaperFormat {
  const landscape = size.widthMm > size.heightMm;
  if (landscape === (orientation === "landscape")) return size;
  return { ...size, widthMm: size.heightMm, heightMm: size.widthMm };
}

function nativeTemplatePage(version: TemplateVersionRecord, project: ProjectRecord): { pageSizeMm: PaperFormat; orientation: PageOrientation } {
  if (version.templateGeometry) {
    return { pageSizeMm: { name: version.paper, ...version.templateGeometry.pageSizeMm }, orientation: version.templateGeometry.orientation };
  }
  if (version.paper === "custom") {
    const projectGeometry = project.snapshot.settings.layout.templateGeometry;
    if (!projectGeometry) throw new CutSourceError("CUT_SOURCE_DIMENSIONS_MISMATCH", "Custom template page size is ambiguous without versioned or explicit Project templateGeometry.");
    return { pageSizeMm: { name: "Explicit Project template page", ...projectGeometry.pageSizeMm }, orientation: projectGeometry.orientation };
  }
  const size = STANDARD_PAPER[version.paper];
  if (!size) throw new CutSourceError("CUT_SOURCE_DIMENSIONS_MISMATCH", `Template paper ${version.paper} has no physical dimensions; add explicit templateGeometry or configure a standard Project paper size.`);
  return { pageSizeMm: orientPaper(size, version.orientation), orientation: version.orientation };
}

function sourceIdentity(project: ProjectRecord, version: TemplateVersionRecord, file: TemplateFileRecord): CutSourceIdentity {
  if (!project.templateSelection) throw new CutSourceError("CUT_SOURCE_INTEGRITY_FAILURE", "Project has no exact template version associated with its cut file.");
  return {
    kind: "template-file",
    templateId: project.templateSelection.templateId,
    version: project.templateSelection.version,
    packageHash: project.templateSelection.packageHash,
    fileId: file.fileId,
    fileHash: file.contentHash,
  };
}

async function fileBytes(library: TemplateLibraryService, file: TemplateFileRecord): Promise<Uint8Array> {
  const metadata = library.getFileMetadata(file.fileId);
  if (!metadata || metadata.contentHash !== file.contentHash || metadata.byteLength !== file.byteLength || metadata.extension !== file.extension) {
    throw new CutSourceError("CUT_SOURCE_INTEGRITY_FAILURE", "The selected original file identity no longer matches its immutable template record.");
  }
  try {
    return await library.readFile(file.fileId);
  } catch (error) {
    throw new CutSourceError("CUT_SOURCE_INTEGRITY_FAILURE", `The selected original is missing or corrupt; cut geometry was not substituted. ${error instanceof Error ? error.message : ""}`, { cause: error });
  }
}

async function inspectExactSelection(
  project: ProjectRecord,
  library: TemplateLibraryService,
): Promise<{ version: TemplateVersionRecord; inspection: TemplateSelectionInspection }> {
  const selection = project.templateSelection;
  if (!selection) throw new CutSourceError("CUT_SOURCE_INTEGRITY_FAILURE", "Cut source must belong to an exact Project template ID, version, and package hash.");
  const version = library.getVersion(selection.templateId, selection.version);
  if (!version || version.packageHash !== selection.packageHash) {
    throw new CutSourceError("CUT_SOURCE_INTEGRITY_FAILURE", "The exact template version or package hash is no longer available; no other version will be substituted.");
  }
  const inspection = await library.inspectSelection(selection);
  if (inspection.status !== "available") {
    throw new CutSourceError("CUT_SOURCE_INTEGRITY_FAILURE", `The exact template package is ${inspection.status}; cut geometry is blocked until every associated original and package hash verifies.`);
  }
  return { version, inspection };
}

async function parseSourceFile(
  project: ProjectRecord,
  version: TemplateVersionRecord,
  file: TemplateFileRecord,
  library: TemplateLibraryService,
  pageSizeMm: PaperFormat,
  unitsOverride?: DxfUnitsOverride,
): Promise<CutGeometryMm> {
  if (file.extension !== "svg" && file.extension !== "dxf") throw new CutSourceError("CUT_SOURCE_UNSUPPORTED", "Only explicit SVG and DXF cut files are supported.");
  if (unitsOverride && file.extension !== "dxf") throw new CutSourceError("CUT_SOURCE_UNITS_AMBIGUOUS", "A DXF unit override cannot be applied to an SVG source.");
  const bytes = await fileBytes(library, file);
  const source = sourceIdentity(project, version, file);
  if (file.extension === "svg") return parseSvgCutGeometry(bytes, { source, expectedPageSizeMm: pageSizeMm });
  return parseDxfCutGeometry(bytes, { source, expectedPageSizeMm: pageSizeMm, ...(unitsOverride ? { unitsOverride } : {}) });
}

function geometryComparable(geometry: CutGeometryMm): CutGeometryMm {
  return {
    ...geometry,
    paths: [...geometry.paths].sort((left, right) => left.boundsMm.yMm - right.boundsMm.yMm
      || left.boundsMm.xMm - right.boundsMm.xMm
      || left.boundsMm.widthMm - right.boundsMm.widthMm
      || left.boundsMm.heightMm - right.boundsMm.heightMm),
  };
}

async function compareAlternates(
  project: ProjectRecord,
  version: TemplateVersionRecord,
  files: readonly TemplateFileRecord[],
  selectedFile: TemplateFileRecord,
  selectedGeometry: CutGeometryMm,
  library: TemplateLibraryService,
  pageSizeMm: PaperFormat,
): Promise<CutAlternativeSourceStatus[]> {
  const alternates = files.filter((file) => file.fileId !== selectedFile.fileId && (file.extension === "svg" || file.extension === "dxf"));
  if (alternates.length > MAX_ALTERNATE_SOURCES_TO_COMPARE) {
    return alternates.map((file) => ({ fileId: file.fileId, fileName: file.fileName, status: "not-compared", message: `More than ${MAX_ALTERNATE_SOURCES_TO_COMPARE} vector sources; exact source selection remains explicit.` }));
  }
  const result: CutAlternativeSourceStatus[] = [];
  for (const file of alternates) {
    try {
      const geometry = await parseSourceFile(
        project,
        version,
        file,
        library,
        pageSizeMm,
      );
      const comparison = compareCutGeometryMm(geometryComparable(selectedGeometry), geometryComparable(geometry), 0.001, { compareIds: false });
      result.push({ fileId: file.fileId, fileName: file.fileName, status: comparison.equal ? "equivalent" : "divergent", ...(!comparison.equal ? { message: comparison.differences[0] ?? "Vector paths differ." } : {}) });
    } catch (error) {
      result.push({ fileId: file.fileId, fileName: file.fileName, status: "unreadable", message: error instanceof Error ? error.message : "Alternate geometry could not be interpreted." });
    }
  }
  return result;
}

export async function resolveProjectCutLayout(
  projectId: string,
  expectedRevision: number,
  projects: ProjectRepository,
  library: TemplateLibraryService,
): Promise<CutProjectResolution> {
  const project = projects.open(projectId);
  if (project.revision !== expectedRevision) {
    throw new ProjectRepositoryError("PROJECT_REVISION_CONFLICT", `Project revision ${project.revision} does not match requested revision ${expectedRevision}.`, expectedRevision, project.revision);
  }
  const settings = project.snapshot.settings;
  let sourceGeometry: CutGeometryMm | undefined;
  let sourceOrientation: PageOrientation | undefined;
  let alternateSources: CutAlternativeSourceStatus[] = [];
  const cutSource = settings.cutSourceSelection;
  if (cutSource) {
    if (!project.templateSelection) throw new CutSourceError("CUT_SOURCE_INTEGRITY_FAILURE", "The selected cut source has no exact associated template version.");
    const { version, inspection } = await inspectExactSelection(project, library);
    const file = version.files.find(({ fileId }) => fileId === cutSource.fileId);
    if (!file || file.contentHash !== cutSource.fileHash) throw new CutSourceError("CUT_SOURCE_INTEGRITY_FAILURE", "Selected file ID/hash is not part of the Project's exact immutable template package.");
    const { pageSizeMm: nativePage, orientation } = nativeTemplatePage(version, project);
    sourceGeometry = await parseSourceFile(project, version, file, library, nativePage, cutSource.dxfUnitsOverride);
    sourceOrientation = orientation;
    alternateSources = await compareAlternates(project, version, inspection.files.filter((entry) => entry.status === "available").map((entry) => {
      const record = version.files.find(({ fileId }) => fileId === entry.fileId);
      return record;
    }).filter((entry): entry is TemplateFileRecord => entry !== undefined), file, sourceGeometry, library, nativePage);
  }
  let layout: CutLayoutResolution;
  try {
    layout = resolveCutLayout({ projectId, projectRevision: project.revision, settings, cardCount: project.snapshot.cards.reduce((total, card) => total + card.quantity, 0), ...(sourceGeometry ? { sourceGeometry, sourceOrientation } : {}) });
  } catch (error) {
    if (error instanceof CutSourceError) throw error;
    throw new CutSourceError("CUT_LAYOUT_MISMATCH", error instanceof Error ? error.message : "Cut geometry does not match the PDF placement.", { cause: error });
  }
  return { project, layout, alternateSources: Object.freeze(alternateSources), templateIdentity: project.templateSelection };
}
