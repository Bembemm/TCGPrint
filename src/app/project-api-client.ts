import type { ProjectDto, ProjectOpenDto, ProjectRecoveryDto, ProjectSummaryDto } from "../../services/project-api";
import type { ProjectSnapshotV1 } from "../../persistence/projects/serializer";
import type { TemplateSelection } from "../../templates/types";

interface ProjectApiErrorBody {
  readonly code?: string;
  readonly message?: string;
}

export class ProjectApiClientError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ProjectApiClientError";
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch {
    throw new ProjectApiClientError("INVALID_PROJECT_RESPONSE", "The project service returned invalid JSON.", response.status);
  }
  if (!response.ok) {
    const error = body && typeof body === "object" ? body as ProjectApiErrorBody : {};
    throw new ProjectApiClientError(
      error.code ?? "PROJECT_API_FAILED",
      error.message ?? "The project request failed.",
      response.status,
    );
  }
  return body as T;
}

export function createProjectApiClient(fetcher: typeof fetch = fetch) {
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  const projectUrl = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

  return {
    async list(): Promise<readonly ProjectSummaryDto[]> {
      const result = await responseJson<{ projects: ProjectSummaryDto[] }>(await fetcher("/api/projects", { cache: "no-store" }));
      return result.projects;
    },
    async create(snapshot?: ProjectSnapshotV1, templateSelection?: TemplateSelection | null): Promise<ProjectDto> {
      const body = snapshot === undefined && templateSelection === undefined ? undefined : {
        ...(snapshot === undefined ? {} : { snapshot }),
        ...(templateSelection === undefined ? {} : { templateSelection }),
      };
      return responseJson<ProjectDto>(await fetcher("/api/projects", json("POST", body)));
    },
    async open(projectId: string): Promise<ProjectOpenDto> {
      return responseJson<ProjectOpenDto>(await fetcher(projectUrl(projectId), { cache: "no-store" }));
    },
    async save(projectId: string, expectedRevision: number, snapshot: ProjectSnapshotV1, templateSelection?: TemplateSelection | null): Promise<ProjectDto> {
      return responseJson<ProjectDto>(await fetcher(projectUrl(projectId), json("PUT", {
        expectedRevision, snapshot, ...(templateSelection === undefined ? {} : { templateSelection }),
      })));
    },
    async stageRecovery(projectId: string, expectedRevision: number, snapshot: ProjectSnapshotV1, templateSelection?: TemplateSelection | null): Promise<{ readonly recovery: ProjectRecoveryDto }> {
      return responseJson<{ recovery: ProjectRecoveryDto }>(await fetcher(`${projectUrl(projectId)}/recovery`, json("POST", {
        expectedRevision, snapshot, ...(templateSelection === undefined ? {} : { templateSelection }),
      })));
    },
    async promoteRecovery(projectId: string): Promise<ProjectDto> {
      return responseJson<ProjectDto>(await fetcher(`${projectUrl(projectId)}/recovery/promote`, json("POST")));
    },
    async discardRecovery(projectId: string): Promise<{ readonly discarded: true; readonly id: string }> {
      return responseJson<{ readonly discarded: true; readonly id: string }>(await fetcher(`${projectUrl(projectId)}/recovery`, json("DELETE")));
    },
    async copyRecovery(projectId: string): Promise<ProjectDto> {
      return responseJson<ProjectDto>(await fetcher(`${projectUrl(projectId)}/recovery/copy`, json("POST")));
    },
    async duplicate(projectId: string): Promise<ProjectDto> {
      return responseJson<ProjectDto>(await fetcher(`${projectUrl(projectId)}/duplicate`, json("POST")));
    },
    async delete(projectId: string): Promise<{ readonly deleted: true; readonly id: string }> {
      return responseJson<{ deleted: true; id: string }>(await fetcher(projectUrl(projectId), json("DELETE")));
    },
  };
}
