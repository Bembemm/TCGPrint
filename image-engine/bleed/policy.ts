import type { ArtworkSource } from "../../core/cards/types";
import type { BleedMode, BleedModePreference } from "./types";
export type { BleedModePreference } from "./types";

export interface BleedSourcePolicyRequest {
  readonly source: ArtworkSource;
  readonly format: string;
  readonly override?: BleedModePreference;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ResolvedBleedSourcePolicy {
  readonly requestedMode: BleedModePreference;
  readonly mode: BleedMode;
  readonly policyId: string;
  readonly notice?: "MPC_BLEED_METADATA_UNKNOWN";
}

/** Artwork metadata never changes immediate-edge sampling. */
export function resolveBleedSourcePolicy(request: BleedSourcePolicyRequest): ResolvedBleedSourcePolicy {
  const requestedMode = request.override ?? "auto";
  const mode: BleedMode = "edge-extension";
  return { requestedMode, mode, policyId: "edge-extension-v1" };
}
