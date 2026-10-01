import {
  ProjectRepository,
  ProjectRepositoryError,
  type ProjectMetadata,
  type ProjectRecoveryRecord,
  type ProjectRecord,
} from "../persistence/projects/repository";
import {
  MAX_PROJECT_SNAPSHOT_BYTES,
  ProjectSnapshotError,
  deserializeProjectSnapshot,
  type ProjectSnapshotV1,
} from "../persistence/projects/serializer";
import type { TemplateSelection } from "../templates/types";
import type { BackLibraryService } from "./back-library";

type BackLibraryReferenceCatalog = Pick<BackLibraryService, "listAll">;

export interface ProjectSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly projectSchemaVersion: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectSaveState {
  readonly snapshot: ProjectSnapshotV1;
  readonly templateSelection: TemplateSelection | null;
}

export interface ProjectDto extends ProjectSummaryDto {
  readonly snapshot: ProjectSnapshotV1;
  readonly templateSelection: TemplateSelection | null;
}

export interface ProjectRecoveryDto {
  readonly baseRevision: number;
  readonly projectSchemaVersion: number;
  readonly snapshot: ProjectSnapshotV1;
  readonly templateSelection: TemplateSelection | null;
  readonly createdAt: string;
}

export interface ProjectOpenDto extends ProjectDto {
  readonly recovery: ProjectRecoveryDto | null;
}

// Bound the transport allowance to the compact wrapper with the largest valid revision.
const MAX_PROJECT_SAVE_ENVELOPE_BYTES = new TextEncoder().encode(
  JSON.stringify({ expectedRevision: Number.MAX_SAFE_INTEGER, snapshot: null, templateSelection: {
    templateId: "i".repeat(180), version: "v".repeat(80), packageHash: "a".repeat(64),
  } }),
).byteLength - new TextEncoder().encode("null").byteLength;
const MAX_PROJECT_SAVE_REQUEST_BYTES = MAX_PROJECT_SNAPSHOT_BYTES + MAX_PROJECT_SAVE_ENVELOPE_BYTES;

class ProjectApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ProjectApiRequestError";
  }
}

function projectSummaryDto(project: ProjectMetadata): ProjectSummaryDto {
  return {
    id: project.id,
    name: project.name,
    projectSchemaVersion: project.projectSchemaVersion,
    revision: project.revision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function projectDto(project: ProjectRecord): ProjectDto {
  return { ...projectSummaryDto(project), snapshot: project.snapshot, templateSelection: project.templateSelection };
}

function projectRecoveryDto(recovery: ProjectRecoveryRecord): ProjectRecoveryDto {
  return {
    baseRevision: recovery.baseRevision,
    projectSchemaVersion: recovery.projectSchemaVersion,
    snapshot: recovery.snapshot,
    templateSelection: recovery.templateSelection,
    createdAt: recovery.createdAt,
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProjectApiRequestError) {
    return Response.json({ code: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ProjectSnapshotError) {
    return Response.json({ code: error.code, message: error.message }, { status: 400 });
  }
  if (error instanceof ProjectRepositoryError) {
    if (error.code === "PROJECT_REVISION_CONFLICT") {
      return Response.json({
        code: error.code,
        message: "Project revision conflict.",
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      }, { status: 409 });
    }
    if (error.code === "PROJECT_RECOVERY_EXISTS") {
      return Response.json({ code: error.code, message: error.message }, { status: 409 });
    }
    if (error.code === "PROJECT_NOT_FOUND") {
      return Response.json({ code: error.code, message: "Project was not found." }, { status: 404 });
    }
    if (error.code !== "INVALID_PROJECT_TIMESTAMP") {
      return Response.json({ code: error.code, message: error.message }, { status: 400 });
    }
  }
  return Response.json({ code: "PROJECT_API_FAILED", message: "The project request failed." }, { status: 500 });
}

async function parseProjectSaveBody(request: Request, allowEmpty = false): Promise<unknown> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new ProjectApiRequestError(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.");
    }
    if (contentLength > MAX_PROJECT_SAVE_REQUEST_BYTES) {
      throw new ProjectApiRequestError(413, "REQUEST_TOO_LARGE", "Request body exceeds the project save size limit.");
    }
  }

  if (!request.body) {
    throw new ProjectApiRequestError(400, "INVALID_JSON", "Project save body must be valid JSON.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_PROJECT_SAVE_REQUEST_BYTES) {
        try { await reader.cancel(); } catch { /* The size limit remains the relevant failure. */ }
        throw new ProjectApiRequestError(413, "REQUEST_TOO_LARGE", "Request body exceeds the project save size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProjectApiRequestError) throw error;
    throw new ProjectApiRequestError(400, "INVALID_JSON", "Project save body must be valid JSON.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (allowEmpty && byteLength === 0) return undefined;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectApiRequestError(400, "INVALID_JSON", "Project save body must be valid JSON.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProjectApiRequestError(400, "INVALID_JSON", "Project save body must be valid JSON.");
  }
}

function validProjectId(projectId: string): boolean {
  return typeof projectId === "string" && projectId.trim().length > 0 && projectId.length <= 180 && !/[\u0000-\u001f]/.test(projectId);
}

function invalidRequest(message = "The project request is invalid."): Response {
  return Response.json({ code: "INVALID_PROJECT_REQUEST", message }, { status: 400 });
}

function backLibraryReferences(snapshot: ProjectSnapshotV1): ReadonlyMap<string, string> {
  const references = new Map<string, string>();
  const identify = (reference: NonNullable<ProjectSnapshotV1["settings"]["projectDefaultBack"]>) =>
    `${reference.assetId}\0${reference.sha256}\0${reference.format}`;
  if (snapshot.settings.projectDefaultBack) references.set("settings.projectDefaultBack", identify(snapshot.settings.projectDefaultBack));
  for (const card of snapshot.cards) {
    if (card.manualBackAsset) references.set(`cards.${card.id}.manualBackAsset`, identify(card.manualBackAsset));
  }
  return references;
}

function validateBackLibraryReferences(
  snapshot: ProjectSnapshotV1,
  existingSnapshot: ProjectSnapshotV1 | undefined,
  backLibrary: BackLibraryReferenceCatalog | undefined,
): void {
  const references = backLibraryReferences(snapshot);
  if (references.size === 0) return;
  if (!backLibrary) throw new ProjectApiRequestError(503, "BACK_LIBRARY_UNAVAILABLE", "Back Library must be available to validate Project back references.");
  const records = new Map(backLibrary.listAll().map((record) => [record.assetId, record]));
  const existingReferences = existingSnapshot ? backLibraryReferences(existingSnapshot) : new Map<string, string>();
  for (const [location, reference] of references) {
    const [assetId, sha256, format] = reference.split("\0");
    const record = records.get(assetId!);
    if (!record || record.sha256 !== sha256 || record.format !== format) {
      throw new ProjectApiRequestError(400, "BACK_ASSET_NOT_FOUND", "Project references an unavailable or mismatched Back Library asset.");
    }
    if (record.retired && existingReferences.get(location) !== reference) {
      throw new ProjectApiRequestError(409, "BACK_ASSET_RETIRED", "A retired Back Library asset cannot be added as a new Project reference.");
    }
  }
}

function parseTemplateSelectionField(fields: Record<string, unknown>): TemplateSelection | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(fields, "templateSelection")) return undefined;
  const selection = fields.templateSelection;
  if (selection === null) return null;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new ProjectApiRequestError(400, "INVALID_PROJECT_REQUEST", "templateSelection must be null or an object.");
  }
  const candidate = selection as Record<string, unknown>;
  if (Object.keys(candidate).length !== 3
    || Object.keys(candidate).some((key) => !["templateId", "version", "packageHash"].includes(key))
    || typeof candidate.templateId !== "string" || candidate.templateId.length < 1 || candidate.templateId.length > 180
    || typeof candidate.version !== "string" || candidate.version.length < 1 || candidate.version.length > 80
    || typeof candidate.packageHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.packageHash)) {
    throw new ProjectApiRequestError(400, "INVALID_PROJECT_REQUEST", "templateSelection must contain a valid template ID, version, and SHA-256 package hash.");
  }
  return { templateId: candidate.templateId, version: candidate.version, packageHash: candidate.packageHash };
}

function expectedRevisionSnapshotFields(body: unknown): {
  readonly expectedRevision: number;
  readonly snapshot: unknown;
  readonly templateSelection?: TemplateSelection | null;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProjectApiRequestError(400, "INVALID_PROJECT_REQUEST", "Project snapshot request body must be an object.");
  }
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "expectedRevision" && key !== "snapshot" && key !== "templateSelection")) {
    throw new ProjectApiRequestError(400, "INVALID_PROJECT_REQUEST", "Project save accepts only expectedRevision, snapshot, and templateSelection.");
  }
  if (!Number.isSafeInteger(fields.expectedRevision) || (fields.expectedRevision as number) < 1) {
    throw new ProjectApiRequestError(400, "INVALID_PROJECT_REQUEST", "expectedRevision must be a positive integer.");
  }
  return {
    expectedRevision: fields.expectedRevision as number,
    snapshot: fields.snapshot,
    templateSelection: parseTemplateSelectionField(fields),
  };
}

export async function handleProjectList(_request: Request, projects: ProjectRepository): Promise<Response> {
  try {
    return Response.json({ projects: projects.list().map(projectSummaryDto) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectCreate(request: Request, projects: ProjectRepository, backLibrary?: BackLibraryReferenceCatalog): Promise<Response> {
  try {
    if (!request.body) return Response.json(projectDto(projects.create()), { status: 201 });
    const body = await parseProjectSaveBody(request, true);
    if (body === undefined) return Response.json(projectDto(projects.create()), { status: 201 });
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "snapshot" && key !== "templateSelection")) {
      throw new ProjectApiRequestError(400, "INVALID_PROJECT_REQUEST", "Project creation accepts a snapshot and optional template selection.");
    }
    const fields = body as Record<string, unknown>;
    const snapshot = Object.prototype.hasOwnProperty.call(fields, "snapshot")
      ? deserializeProjectSnapshot(fields.snapshot)
      : undefined;
    if (snapshot) validateBackLibraryReferences(snapshot, undefined, backLibrary);
    return Response.json(projectDto(projects.create(snapshot, parseTemplateSelectionField(fields) ?? null)), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectOpen(_request: Request, projectId: string, projects: ProjectRepository): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  try {
    const project = projects.open(projectId);
    const recovery = projects.readRecovery(projectId);
    const response: ProjectOpenDto = {
      ...projectDto(project),
      recovery: recovery ? projectRecoveryDto(recovery) : null,
    };
    return Response.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectSave(request: Request, projectId: string, projects: ProjectRepository, backLibrary?: BackLibraryReferenceCatalog): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  let body: unknown;
  try {
    body = await parseProjectSaveBody(request);
  } catch (error) {
    return errorResponse(error);
  }
  try {
    const fields = expectedRevisionSnapshotFields(body);
    const snapshot = deserializeProjectSnapshot(fields.snapshot);
    const existing = projects.open(projectId);
    validateBackLibraryReferences(snapshot, existing.snapshot, backLibrary);
    return Response.json(projectDto(projects.save(projectId, fields.expectedRevision, snapshot, fields.templateSelection)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectStageRecovery(request: Request, projectId: string, projects: ProjectRepository, backLibrary?: BackLibraryReferenceCatalog): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  let body: unknown;
  try {
    body = await parseProjectSaveBody(request);
  } catch (error) {
    return errorResponse(error);
  }
  try {
    const fields = expectedRevisionSnapshotFields(body);
    const snapshot = deserializeProjectSnapshot(fields.snapshot);
    const existing = projects.open(projectId);
    validateBackLibraryReferences(snapshot, existing.snapshot, backLibrary);
    const recovery = projects.stageRecovery(projectId, fields.expectedRevision, snapshot, fields.templateSelection);
    return Response.json({ recovery: projectRecoveryDto(recovery) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectPromoteRecovery(_request: Request, projectId: string, projects: ProjectRepository): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  try {
    return Response.json(projectDto(projects.promoteRecovery(projectId)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectDiscardRecovery(_request: Request, projectId: string, projects: ProjectRepository): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  try {
    projects.discardRecovery(projectId);
    return Response.json({ discarded: true, id: projectId });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectCopyRecovery(_request: Request, projectId: string, projects: ProjectRepository): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  try {
    return Response.json(projectDto(projects.copyRecovery(projectId)), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectDuplicate(_request: Request, projectId: string, projects: ProjectRepository): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  try {
    return Response.json(projectDto(projects.duplicate(projectId)), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectDelete(_request: Request, projectId: string, projects: ProjectRepository): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  try {
    projects.delete(projectId);
    return Response.json({ deleted: true, id: projectId });
  } catch (error) {
    return errorResponse(error);
  }
}
