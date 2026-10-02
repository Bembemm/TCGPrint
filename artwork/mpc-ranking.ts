import type { ArtworkCandidate, CardIdentity } from "../core/cards/types";
import type { MpcArtworkFilters } from "./mpc-contract";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberField(candidate: ArtworkCandidate, name: "sourceId" | "priority" | "dpi"): number | undefined {
  const value = candidate.metadata?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" ? value.normalize("NFC").trim().toLocaleLowerCase("en-US") : undefined;
}

function preferenceIndex<T>(preferences: readonly T[], value: T | undefined): number {
  if (preferences.length === 0) return 0;
  if (value === undefined) return preferences.length;
  const index = preferences.indexOf(value);
  return index < 0 ? preferences.length : index;
}

function exactPrinting(candidate: ArtworkCandidate, identity: CardIdentity): boolean {
  const canonical = candidate.metadata?.canonicalCard;
  if (!record(canonical) || !identity.setCode || !identity.collectorNumber) return false;
  return textField(canonical.expansionCode) === textField(identity.setCode)
    && textField(canonical.collectorNumber) === textField(identity.collectorNumber);
}

function preferredTagCount(candidate: ArtworkCandidate, preferredTags: readonly string[]): number {
  if (preferredTags.length === 0 || !Array.isArray(candidate.metadata?.tags)) return 0;
  const tags = new Set(candidate.metadata.tags.flatMap((tag) => {
    const normalized = textField(tag);
    return normalized ? [normalized] : [];
  }));
  return preferredTags.reduce((count, tag) => {
    const normalized = textField(tag);
    return count + (normalized && tags.has(normalized) ? 1 : 0);
  }, 0);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Ranks MPC search results only. Callers keep imported/explicit MPC
 * references in front and never use this ordering to change a selection.
 */
export function rankMpcCandidates(
  candidates: readonly ArtworkCandidate[],
  identity: CardIdentity,
  filters: MpcArtworkFilters,
): readonly ArtworkCandidate[] {
  return candidates.slice().sort((left, right) => {
    const sourceRank = preferenceIndex(filters.preferredSources, numberField(left, "sourceId"))
      - preferenceIndex(filters.preferredSources, numberField(right, "sourceId"));
    if (sourceRank !== 0) return sourceRank;

    const leftLanguage = textField(left.language ?? left.metadata?.language);
    const rightLanguage = textField(right.language ?? right.metadata?.language);
    const languageRank = preferenceIndex(filters.preferredLanguages, leftLanguage)
      - preferenceIndex(filters.preferredLanguages, rightLanguage);
    if (languageRank !== 0) return languageRank;

    const tagRank = preferredTagCount(right, filters.preferredTags) - preferredTagCount(left, filters.preferredTags);
    if (tagRank !== 0) return tagRank;

    const exactRank = Number(exactPrinting(right, identity)) - Number(exactPrinting(left, identity));
    if (exactRank !== 0) return exactRank;

    const priorityRank = (numberField(right, "priority") ?? 0) - (numberField(left, "priority") ?? 0);
    if (priorityRank !== 0) return priorityRank;

    // This uses provider-declared DPI as provenance. effectiveDpi is based on
    // decoded local original pixels and is intentionally not used here.
    const dpiRank = (numberField(right, "dpi") ?? 0) - (numberField(left, "dpi") ?? 0);
    if (dpiRank !== 0) return dpiRank;

    return compareString(left.id, right.id);
  });
}
