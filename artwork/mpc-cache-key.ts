import { createHash } from "node:crypto";
import type { CardFaceSide } from "../core/cards/types";
import type { MpcArtworkFilters } from "./mpc-contract";

export const MPC_PROTOCOL_BEHAVIOR_VERSION = "editor-v3-first-v2-only-on-404-v1";
export const MPC_RANKING_VERSION = "mpc-ranking-v2-provider-rank";
export const MPC_SEARCH_MAXIMUM_SIZE_MB = 30;

export function buildMpcSearchCacheKey(
  query: string,
  faceId: CardFaceSide | "any",
  filters: MpcArtworkFilters,
  verifiedSourceIds: readonly number[],
): string {
  const canonical = {
    query: query.normalize("NFC").trim().toLocaleLowerCase("en-US"),
    faceId,
    filters: {
      minimumDpi: filters.minimumDpi,
      maximumDpi: filters.maximumDpi,
      sources: [...filters.sources].sort((a, b) => a - b),
      includeTags: [...filters.includeTags].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      excludeTags: [...filters.excludeTags].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      languages: [...filters.languages].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      preferredSources: [...filters.preferredSources],
      preferredLanguages: [...filters.preferredLanguages],
      preferredTags: [...filters.preferredTags].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      rankingMode: filters.rankingMode,
    },
    verifiedSourceIds: [...new Set(verifiedSourceIds)].sort((a, b) => a - b),
    maximumSizeMb: MPC_SEARCH_MAXIMUM_SIZE_MB,
    protocolBehaviorVersion: MPC_PROTOCOL_BEHAVIOR_VERSION,
    rankingVersion: MPC_RANKING_VERSION,
  };
  const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return `mpc:search:${hash}`;
}
