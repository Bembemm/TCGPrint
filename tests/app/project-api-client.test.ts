import { describe, expect, it, vi } from "vitest";
import { createProjectApiClient, ProjectApiClientError } from "../../src/app/project-api-client";

describe("project API client", () => {
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

    await expect(client.save("project-1", 4, { projectSchemaVersion: 1, cards: [], settings: {} } as never))
      .rejects.toMatchObject<Partial<ProjectApiClientError>>({
        name: "ProjectApiClientError",
        code: "PROJECT_REVISION_CONFLICT",
        status: 409,
      });
  });
});
