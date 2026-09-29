import { describe, expect, it } from "vitest";
import { createProjectListRequestGuard } from "../../src/app/project-list-request-guard";

describe("project list request guard", () => {
  it("ignores a list response started before a create, save, duplicate or delete refresh", () => {
    const guard = createProjectListRequestGuard();
    const initialLoad = guard.begin();
    const refreshAfterMutation = guard.begin();

    expect(guard.isCurrent(initialLoad)).toBe(false);
    expect(guard.isCurrent(refreshAfterMutation)).toBe(true);
  });
});
