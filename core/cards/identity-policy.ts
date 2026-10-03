export interface IdentityResolutionPolicy {
  readonly fuzzySuggestThreshold: number;
  readonly ambiguousMargin: number;
  readonly minimumQueryLength: number;
  readonly maximumCandidates: number;
}

/** Shared deterministic resolver thresholds; change them here, not at call sites. */
export const IDENTITY_RESOLUTION_POLICY: IdentityResolutionPolicy = Object.freeze({
  fuzzySuggestThreshold: 0.72,
  ambiguousMargin: 0.04,
  minimumQueryLength: 2,
  maximumCandidates: 5,
});

export const DEFAULT_ARTWORK_POLICY_ID = "newest-en-highres-nondigital-v1";
