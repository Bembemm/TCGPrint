import { IDENTITY_RESOLUTION_POLICY, type IdentityResolutionPolicy } from "./identity-policy";

export interface FuzzyCandidate {
  readonly name: string;
  readonly id?: string;
}

export interface FuzzyMatch<T> {
  readonly status: "resolved" | "suggested" | "ambiguous" | "unresolved";
  readonly score: number;
  readonly reason: "exact-name" | "closest-name" | "competing-close-matches" | "below-threshold";
  readonly candidate?: T;
  readonly candidates: readonly { candidate: T; score: number }[];
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function editDistance(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  let previous = Array.from({ length: b.length + 1 }, (_item, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function compareStable<T extends FuzzyCandidate>(a: { candidate: T; score: number }, b: { candidate: T; score: number }): number {
  return b.score - a.score
    || a.candidate.name.localeCompare(b.candidate.name, "en")
    || (a.candidate.id ?? JSON.stringify(a.candidate) ?? "").localeCompare(b.candidate.id ?? JSON.stringify(b.candidate) ?? "");
}

export function fuzzyMatchName<T extends FuzzyCandidate>(
  query: string,
  candidates: readonly T[],
  policy: IdentityResolutionPolicy = IDENTITY_RESOLUTION_POLICY,
): FuzzyMatch<T> {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length < policy.minimumQueryLength || !candidates.length) {
    return { status: "unresolved", score: 0, reason: "below-threshold", candidates: [] };
  }
  const ranked = candidates.map((candidate) => {
    const normalizedName = normalize(candidate.name);
    const denominator = Math.max(normalizedQuery.length, normalizedName.length, 1);
    const score = normalizedQuery === normalizedName ? 1 : Math.max(0, 1 - editDistance(normalizedQuery, normalizedName) / denominator);
    return { candidate, score };
  }).sort(compareStable);
  const top = ranked[0];
  if (top.score === 1) return { status: "resolved", score: 1, reason: "exact-name", candidate: top.candidate, candidates: [top] };
  if (top.score < policy.fuzzySuggestThreshold) return { status: "unresolved", score: top.score, reason: "below-threshold", candidates: [] };
  const close = ranked.filter((candidate) => candidate.score >= policy.fuzzySuggestThreshold && top.score - candidate.score <= policy.ambiguousMargin).slice(0, policy.maximumCandidates);
  if (close.length > 1) return { status: "ambiguous", score: top.score, reason: "competing-close-matches", candidate: top.candidate, candidates: close };
  return { status: "suggested", score: top.score, reason: "closest-name", candidate: top.candidate, candidates: [top] };
}
