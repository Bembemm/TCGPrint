import { describe, expect, it, vi } from "vitest";
import {
  createProjectRestoreLookupGate,
  runProjectRestoreProviderLookup,
} from "../../src/app/project-restore-provider-gate";

describe("project restore provider gate", () => {
  it("skips automatic artwork and identity lookups caused by opening, including Strict Mode effect replay", async () => {
    const gate = createProjectRestoreLookupGate(3);
    const artworkLookup = vi.fn(async () => "artwork catalog");
    const identityLookup = vi.fn(async () => "identity details");

    const firstSetup = [
      runProjectRestoreProviderLookup(gate, 3, "artwork", artworkLookup),
      runProjectRestoreProviderLookup(gate, 3, "identity", identityLookup),
    ];
    const strictModeReplay = [
      runProjectRestoreProviderLookup(gate, 3, "artwork", artworkLookup),
      runProjectRestoreProviderLookup(gate, 3, "identity", identityLookup),
    ];
    const skipped = await Promise.all([...firstSetup, ...strictModeReplay]);

    expect(skipped).toEqual([
      { skipped: true },
      { skipped: true },
      { skipped: true },
      { skipped: true },
    ]);
    expect(artworkLookup).not.toHaveBeenCalled();
    expect(identityLookup).not.toHaveBeenCalled();
  });

  it("allows a later user-triggered lookup after the restore suppression expires", async () => {
    const gate = createProjectRestoreLookupGate(4);
    const lookup = vi.fn(async () => "catalog");
    await runProjectRestoreProviderLookup(gate, 4, "artwork", lookup);

    await Promise.resolve();
    const result = await runProjectRestoreProviderLookup(gate, 4, "artwork", lookup);

    expect(result).toEqual({ skipped: false, value: "catalog" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
