import { createHash } from "node:crypto";
import type { CardFaceSide } from "./types";

const SAFE_ARTWORK_CANDIDATE_ID = /^(upload:[a-f0-9]{64}|scryfall:[a-f0-9-]{36}:(front|back)|mpc:[a-f0-9]{64})$/;

export function isSafeArtworkCandidateId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ARTWORK_CANDIDATE_ID.test(value);
}

export function mpcArtworkCandidateId(importedAssetId: string, faceId: CardFaceSide): string {
  const safeId = createHash("sha256").update(`${importedAssetId}\0${faceId}`).digest("hex");
  return `mpc:${safeId}`;
}
