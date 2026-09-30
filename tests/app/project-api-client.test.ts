import { describe, expect, it, vi } from "vitest";
import { createProjectApiClient, ProjectApiClientError } from "../../src/app/project-api-client";

describe("project API client", () => {
  it("creates a Project from a local snapshot without changing the empty-create call", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: "project-1", revision: 1 }));
    const client = createProjectApiClient(fetcher as typeof fetch);
    const snapshot = { projectSchemaVersion: 2, cards: [], settings: {} } as never;

    await client.create(snapshot);

    expect(fetcher).toHaveBeenCalledWith("/api/projects", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ snapshot }),
    }));
  });

  it("opens a Project through its GET endpoint only", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: "project/one", revision: 1 }));
    const client = createProjectApiClient(fetcher as typeof fetch);

    const project = await client.open("project/one");

    expect(project).toMatchObject({ id: "project/one", revision: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects/project%2Fone");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(fetcher.mock.calls[0]?.[1]?.cache).toBe("no-store");
    expect(String(fetcher.mock.calls[0]?.[0])).not.toMatch(/resolve|search|artworks|prepare|download|autocomplete|ocr|mpc/i);
  });

  it("surfaces a stale save response as a typed 409 client error", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(
      { code: "PROJECT_REVISION_CONFLICT", message: "Project revision conflict." },
      { status: 409 },
    ));
    const client = createProjectApiClient(fetcher as typeof fetch);

    await expect(client.save("project-1", 4, { projectSchemaVersion: 2, cards: [], settings: {} } as never))
      .rejects.toMatchObject<Partial<ProjectApiClientError>>({
        name: "ProjectApiClientError",
        code: "PROJECT_REVISION_CONFLICT",
        status: 409,
      });
  });

  it("uses the Project recovery endpoints for stage, promote, discard, and copy", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: "project-1" }));
    const client = createProjectApiClient(fetcher as typeof fetch);
    const snapshot = { projectSchemaVersion: 2, cards: [], settings: {} } as never;

    await client.stageRecovery("project/one", 4, snapshot);
    await client.promoteRecovery("project/one");
    await client.discardRecovery("project/one");
    await client.copyRecovery("project/one");

    expect(fetcher.mock.calls.map(([input, init]) => [String(input), init?.method])).toEqual([
      ["/api/projects/project%2Fone/recovery", "POST"],
      ["/api/projects/project%2Fone/recovery/promote", "POST"],
      ["/api/projects/project%2Fone/recovery", "DELETE"],
      ["/api/projects/project%2Fone/recovery/copy", "POST"],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ expectedRevision: 4, snapshot });
  });
});
