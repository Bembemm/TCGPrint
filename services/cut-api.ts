import { ProjectRepository, ProjectRepositoryError } from "../persistence/projects/repository";
import type { TemplateLibraryService } from "./template-library";
import { CutSourceError } from "./cut-geometry/errors";
import { CUT_GEOMETRY_PARSER_VERSION, resolveProjectCutLayout } from "./cut-geometry/service";
import { exportCutGeometryToDxf } from "./cut-geometry/dxf-export";
import { exportCutGeometryToSvg } from "./cut-geometry/svg-export";
import type { CutGeometryMm } from "../core/cut";
import type { CutAlternativeSourceStatus } from "./cut-geometry/service";
import type { CutPathSlotState } from "./cut-geometry/layout-sync";
import type { TemplateLayoutGeometryMm } from "../core/geometry";

export interface CutPreviewDto {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly templateIdentity: { readonly templateId: string; readonly version: string; readonly packageHash: string } | null;
  readonly parserVersion: string;
  readonly geometry: CutGeometryMm;
  readonly activeGeometry: CutGeometryMm | null;
  readonly slotPaths: readonly CutPathSlotState[];
  readonly pageCount: number;
  readonly pages: readonly CutPreviewPageDto[];
  readonly derivedTemplateGeometry?: TemplateLayoutGeometryMm;
  readonly alternateSources: readonly CutAlternativeSourceStatus[];
  readonly layout: {
    readonly pageSizeMm: { readonly widthMm: number; readonly heightMm: number };
    readonly cardSizeMm: { readonly widthMm: number; readonly heightMm: number };
    readonly rows: number;
    readonly columns: number;
    readonly capacity: number;
  };
}

export interface CutPreviewPageDto {
  readonly pageNumber: number;
  /** One-based inclusive card ordinal range matching PDF document order. */
  readonly firstCardNumber: number;
  /** One-based inclusive card ordinal range matching PDF document order. */
  readonly lastCardNumber: number;
  readonly geometry: CutGeometryMm;
  readonly activeGeometry: CutGeometryMm | null;
  readonly slotPaths: readonly CutPathSlotState[];
  readonly layout: CutPreviewDto["layout"];
}

const MAX_CUT_API_BODY_BYTES = 2_048;

class CutApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CutApiRequestError";
  }
}

async function requestFields(request: Request): Promise<{ projectId: string; expectedRevision: number }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new CutApiRequestError(400, "INVALID_CUT_REQUEST", "Content-Length is invalid.");
    if (length > MAX_CUT_API_BODY_BYTES) throw new CutApiRequestError(413, "CUT_REQUEST_TOO_LARGE", "Cut request exceeds the 2048-byte limit.");
  }
  if (!request.body) throw new CutApiRequestError(400, "INVALID_CUT_REQUEST", "Cut request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_CUT_API_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* The size limit remains authoritative. */ }
        throw new CutApiRequestError(413, "CUT_REQUEST_TOO_LARGE", "Cut request exceeds the 2048-byte limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CutApiRequestError) throw error;
    throw new CutApiRequestError(400, "INVALID_CUT_REQUEST", "Cut request body could not be read.");
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new CutApiRequestError(400, "INVALID_CUT_REQUEST", "Cut request must be valid UTF-8 JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CutApiRequestError(400, "INVALID_CUT_REQUEST", "Cut request must be an object.");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 2 || Object.keys(source).some((key) => key !== "projectId" && key !== "expectedRevision")
    || typeof source.projectId !== "string" || !source.projectId.trim() || source.projectId.length > 180 || /[\u0000-\u001f]/.test(source.projectId)
    || !Number.isSafeInteger(source.expectedRevision) || (source.expectedRevision as number) < 1) {
    throw new CutApiRequestError(400, "INVALID_CUT_REQUEST", "Cut request requires only an opaque Project ID and positive expected revision.");
  }
  return { projectId: source.projectId, expectedRevision: source.expectedRevision as number };
}

function errorResponse(error: unknown): Response {
  if (error instanceof CutApiRequestError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
  if (error instanceof CutSourceError) {
    const status = error.code === "CUT_SOURCE_TOO_LARGE" ? 413
      : error.code === "CUT_SOURCE_INTEGRITY_FAILURE" ? 409
        : error.code === "CUT_SOURCE_UNSUPPORTED" ? 422
          : error.code === "CUT_SOURCE_UNITS_AMBIGUOUS" || error.code === "CUT_SOURCE_DIMENSIONS_MISMATCH" || error.code === "CUT_LAYOUT_MISMATCH" ? 409 : 400;
    return Response.json({ code: error.code, message: error.message }, { status });
  }
  if (error instanceof ProjectRepositoryError) {
    const status = error.code === "PROJECT_NOT_FOUND" ? 404 : error.code === "PROJECT_REVISION_CONFLICT" ? 409 : 400;
    return Response.json({ code: error.code, message: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision }, { status });
  }
  return Response.json({ code: "CUT_API_FAILED", message: "Cut geometry request failed." }, { status: 500 });
}

async function resolveRequest(request: Request, projects: ProjectRepository, library: TemplateLibraryService) {
  const fields = await requestFields(request);
  return resolveProjectCutLayout(fields.projectId, fields.expectedRevision, projects, library);
}

export async function handleCutPreview(request: Request, projects: ProjectRepository, library: TemplateLibraryService): Promise<Response> {
  try {
    const result = await resolveRequest(request, projects, library);
    const preview: CutPreviewDto = {
      projectId: result.project.id,
      projectRevision: result.project.revision,
      templateIdentity: result.templateIdentity,
      parserVersion: CUT_GEOMETRY_PARSER_VERSION,
      geometry: result.layout.sourceGeometry,
      activeGeometry: result.layout.activeGeometry,
      slotPaths: result.layout.slotPaths,
      pageCount: result.pages.length,
      pages: result.pages.map((page) => ({
        pageNumber: page.pageNumber,
        firstCardNumber: page.startCardIndex + 1,
        lastCardNumber: page.endCardIndex,
        geometry: page.sourceGeometry,
        activeGeometry: page.activeGeometry,
        slotPaths: page.slotPaths,
        layout: {
          pageSizeMm: page.placement.pageSizeMm,
          cardSizeMm: page.placement.cardSizeMm,
          rows: page.placement.rows,
          columns: page.placement.columns,
          capacity: page.placement.capacity,
        },
      })),
      ...(result.layout.derivedTemplateGeometry ? { derivedTemplateGeometry: result.layout.derivedTemplateGeometry } : {}),
      alternateSources: result.alternateSources,
      layout: {
        pageSizeMm: result.layout.placement.pageSizeMm,
        cardSizeMm: result.layout.placement.cardSizeMm,
        rows: result.layout.placement.rows,
        columns: result.layout.placement.columns,
        capacity: result.layout.placement.capacity,
      },
    };
    return Response.json(preview, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}

async function exportCut(request: Request, projects: ProjectRepository, library: TemplateLibraryService, format: "svg" | "dxf"): Promise<Response> {
  try {
    const result = await resolveRequest(request, projects, library);
    const url = new URL(request.url);
    const pageValues = url.searchParams.getAll("page");
    if ([...url.searchParams.keys()].some((key) => key !== "page") || pageValues.length > 1) {
      throw new CutApiRequestError(400, "INVALID_CUT_PAGE", "Cut export accepts only one optional 1-based page query parameter.");
    }
    if (pageValues.length === 0 && result.pages.length > 1) {
      throw new CutApiRequestError(400, "CUT_PAGE_REQUIRED", `Project PDF has ${result.pages.length} pages; select the matching cut sheet with ?page=1 through ?page=${result.pages.length}.`);
    }
    const pageNumber = pageValues.length === 0 ? 1 : Number(pageValues[0]);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > result.pages.length) {
      throw new CutApiRequestError(400, "INVALID_CUT_PAGE", `Cut page must be a 1-based integer from 1 through ${result.pages.length}.`);
    }
    const page = result.pages[pageNumber - 1]!;
    const geometry = page.activeGeometry;
    if (!geometry) throw new CutSourceError("CUT_LAYOUT_MISMATCH", "Project has no active card slots to export.");
    const text = format === "svg" ? exportCutGeometryToSvg(geometry) : exportCutGeometryToDxf(geometry);
    const contentType = format === "svg" ? "image/svg+xml; charset=utf-8" : "application/dxf; charset=utf-8";
    const identity = result.templateIdentity
      ? `${result.templateIdentity.templateId}|${result.templateIdentity.version}|${result.templateIdentity.packageHash}`
      : `project-layout|${result.project.id}|${result.project.revision}`;
    return new Response(text, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="tcgprint-cut${result.pages.length > 1 ? `-page-${String(pageNumber).padStart(2, "0")}` : ""}.${format}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-TCGPrint-Template-Identity": identity,
        "X-TCGPrint-Cut-Bounds-Mm": JSON.stringify(geometry.boundsMm),
        "X-TCGPrint-Pdf-Page": `${pageNumber}/${result.pages.length}`,
      },
    });
  } catch (error) { return errorResponse(error); }
}

export function handleCutSvgExport(request: Request, projects: ProjectRepository, library: TemplateLibraryService): Promise<Response> {
  return exportCut(request, projects, library, "svg");
}

export function handleCutDxfExport(request: Request, projects: ProjectRepository, library: TemplateLibraryService): Promise<Response> {
  return exportCut(request, projects, library, "dxf");
}
