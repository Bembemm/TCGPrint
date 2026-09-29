const SAFE_ARTWORK_CANDIDATE_ID = /^(upload:[a-f0-9]{64}|scryfall:[a-f0-9-]{36}:(front|back)|mpc:[a-f0-9]{64})$/;

/** Validates durable artwork references without depending on Node-only APIs. */
export function isSafeArtworkCandidateId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ARTWORK_CANDIDATE_ID.test(value);
}
