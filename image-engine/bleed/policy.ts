import type { ArtworkSource } from "../../core/cards/types";
import type { BleedMode } from "./types";

export type BleedModePreference = "auto" | BleedMode;

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

function isSvg(format: string): boolean {
  return format.trim().toLowerCase() === "svg" || format.trim().toLowerCase() === "image/svg+xml";
}

function isRaster(format: string): boolean {
  const normalized = format.trim().toLowerCase();
  const subtype = normalized.startsWith("image/") ? normalized.slice("image/".length) : normalized;
  return ["jpeg", "jpg", "png", "webp", "tiff"].includes(subtype);
}

/** Source defaults are policy only; all raster generation stays in BleedEngine. */
export function resolveBleedSourcePolicy(request: BleedSourcePolicyRequest): ResolvedBleedSourcePolicy {
  const requestedMode = request.override ?? "auto";
  if (isSvg(request.format)) {
    return { requestedMode, mode: request.override === "auto" || request.override === undefined ? "subtle-edge-stretch" : request.override, policyId: "svg-vector-preserved-v1" };
  }

  if (request.override && request.override !== "auto") {
    const notice = request.source === "mpc" ? { notice: "MPC_BLEED_METADATA_UNKNOWN" as const } : {};
    return {
      requestedMode,
      mode: request.override,
      policyId: `manual-override-${request.source}-${request.override}-v1`,
      ...notice,
    };
  }

  if (request.source === "scryfall") {
    if (!isRaster(request.format)) {
      return { requestedMode, mode: "subtle-edge-stretch", policyId: "scryfall-unknown-format-subtle-v1" };
    }
    const borderColor = typeof request.metadata?.borderColor === "string"
      ? request.metadata.borderColor.trim().toLowerCase()
      : undefined;
    if (request.metadata?.fullArt === true || (borderColor !== undefined && borderColor !== "black")) {
      return { requestedMode, mode: "subtle-edge-stretch", policyId: "scryfall-full-art-auto-subtle-v1" };
    }
    return { requestedMode, mode: "smart-border-fill", policyId: "scryfall-raster-auto-v1" };
  }
  if (request.source === "mpc") {
    return {
      requestedMode,
      mode: "subtle-edge-stretch",
      policyId: "mpc-metadata-unknown-conservative-v1",
      notice: "MPC_BLEED_METADATA_UNKNOWN",
    };
  }
  if (request.source === "upload") {
    return { requestedMode, mode: "subtle-edge-stretch", policyId: "local-raster-subtle-v1" };
  }
  return { requestedMode, mode: "subtle-edge-stretch", policyId: `${request.source}-raster-subtle-v1` };
}
