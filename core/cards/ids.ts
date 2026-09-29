import { createHash } from "node:crypto";
import type { CardFaceSide } from "./types";
export { isSafeArtworkCandidateId } from "./artwork-candidate-id";

export function mpcArtworkCandidateId(importedAssetId: string, faceId: CardFaceSide): string {
  const safeId = createHash("sha256").update(`${importedAssetId}\0${faceId}`).digest("hex");
  return `mpc:${safeId}`;
}
