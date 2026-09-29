import { describe, expect, it } from "vitest";
import { isSafeArtworkCandidateId } from "../../../core/cards/artwork-candidate-id";

describe("browser-safe artwork candidate ID validation", () => {
  it("accepts the durable artwork reference formats", () => {
    expect(isSafeArtworkCandidateId(`upload:${"a".repeat(64)}`)).toBe(true);
    expect(isSafeArtworkCandidateId("scryfall:12345678-1234-1234-1234-123456789abc:back")).toBe(true);
    expect(isSafeArtworkCandidateId(`mpc:${"f".repeat(64)}`)).toBe(true);
  });

  it("rejects arbitrary, malformed, and non-canonical artwork IDs", () => {
    expect(isSafeArtworkCandidateId("upload:../secret")).toBe(false);
    expect(isSafeArtworkCandidateId(`upload:${"A".repeat(64)}`)).toBe(false);
    expect(isSafeArtworkCandidateId(`mpc:${"0".repeat(63)}`)).toBe(false);
    expect(isSafeArtworkCandidateId(null)).toBe(false);
  });
});
