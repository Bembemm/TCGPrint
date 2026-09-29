import {
  ProjectRepository,
  ProjectRepositoryError,
  type ProjectMetadata,
  type ProjectRecord,
} from "../persistence/projects/repository";
import {
  MAX_PROJECT_SNAPSHOT_BYTES,
  ProjectSnapshotError,
  deserializeProjectSnapshot,
  type ProjectSnapshotV1,
} from "../persistence/projects/serializer";

export interface ProjectSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly projectSchemaVersion: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectDto extends ProjectSummaryDto {
  readonly snapshot: ProjectSnapshotV1;
}

const MAX_PROJECT_SAVE_REQUEST_BYTES = MAX_PROJECT_SNAPSHOT_BYTES + 1_024;

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
  return { ...projectSummaryDto(project), snapshot: project.snapshot };
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
    if (error.code === "PROJECT_NOT_FOUND") {
      return Response.json({ code: error.code, message: "Project was not found." }, { status: 404 });
    }
    if (error.code !== "INVALID_PROJECT_TIMESTAMP") {
      return Response.json({ code: error.code, message: error.message }, { status: 400 });
    }
  }
  return Response.json({ code: "PROJECT_API_FAILED", message: "The project request failed." }, { status: 500 });
}

async function parseProjectSaveBody(request: Request): Promise<unknown> {
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

export async function handleProjectList(_request: Request, projects: ProjectRepository): Promise<Response> {
  try {
    return Response.json({ projects: projects.list().map(projectSummaryDto) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectCreate(_request: Request, projects: ProjectRepository): Promise<Response> {
  try {
    return Response.json(projectDto(projects.create()), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectOpen(_request: Request, projectId: string, projects: ProjectRepository): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  try {
    return Response.json(projectDto(projects.open(projectId)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleProjectSave(request: Request, projectId: string, projects: ProjectRepository): Promise<Response> {
  if (!validProjectId(projectId)) return invalidRequest("Project ID is invalid.");
  let body: unknown;
  try {
    body = await parseProjectSaveBody(request);
  } catch (error) {
    return errorResponse(error);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalidRequest("Project save body must be an object.");
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "expectedRevision" && key !== "snapshot")) {
    return invalidRequest("Project save accepts only expectedRevision and snapshot.");
  }
  if (!Number.isSafeInteger(fields.expectedRevision) || (fields.expectedRevision as number) < 1) {
    return invalidRequest("expectedRevision must be a positive integer.");
  }

  try {
    const snapshot = deserializeProjectSnapshot(fields.snapshot);
    return Response.json(projectDto(projects.save(projectId, fields.expectedRevision as number, snapshot)));
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
