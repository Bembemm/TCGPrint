import { describe, expect, it } from "vitest";
import { IDENTITY_RESOLUTION_POLICY } from "../../../core/cards/identity-policy";
import { fuzzyMatchName } from "../../../core/cards/fuzzy-matcher";

const choices = [{ name: "Sol Ring", id: "sol" }, { name: "Sol Rung", id: "rung" }, { name: "Lightning Bolt", id: "bolt" }];

describe("deterministic fuzzy identity matching", () => {
  it("resolves exact names with a score and reason", () => {
    expect(fuzzyMatchName("Sol Ring", choices)).toMatchObject({ status: "resolved", score: 1, reason: "exact-name", candidate: { id: "sol" } });
  });

  it("suggests a small typo but leaves close alternatives ambiguous", () => {
    const typo = fuzzyMatchName("Sol Rng", [{ name: "Sol Ring", id: "sol" }, { name: "Lightning Bolt", id: "bolt" }]);
    expect(typo).toMatchObject({ status: "suggested", candidate: { id: "sol" }, reason: "closest-name" });
    expect(typo.score).toBeGreaterThan(IDENTITY_RESOLUTION_POLICY.fuzzySuggestThreshold);
    expect(fuzzyMatchName("Sol Rng", choices)).toMatchObject({ status: "ambiguous", reason: "competing-close-matches" });
  });

  it("keeps low-score names unresolved and uses one central policy", () => {
    const unresolved = fuzzyMatchName("zzzzzz something", choices);
    expect(unresolved.status).toBe("unresolved");
    expect(unresolved.score).toBeLessThan(IDENTITY_RESOLUTION_POLICY.fuzzySuggestThreshold);
    expect(unresolved.candidates).toEqual([]);
    expect(IDENTITY_RESOLUTION_POLICY.ambiguousMargin).toBeGreaterThan(0);
    expect(fuzzyMatchName("Sol Rng", [{ name: "Sol Ring" }], { ...IDENTITY_RESOLUTION_POLICY, fuzzySuggestThreshold: 0.9 })).toMatchObject({ status: "unresolved" });
  });
});
