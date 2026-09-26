export const BLEED_ALGORITHM_VERSION = "reflected-corners-v2-smart-border-fill-v2" as const;

export type BleedMode = "subtle-edge-stretch" | "smart-border-fill";
export type BleedEffectiveMode = BleedMode | "mixed";

export interface AutoSourceStrip {
  readonly mode: "auto";
}

export interface CustomSourceStrip {
  readonly mode: "custom";
  readonly widthMm: number;
}

export type BleedSourceStrip = AutoSourceStrip | CustomSourceStrip;

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TrimSizeMm {
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface BleedPreview {
  /** Lossless PNG for derived raster output; original MIME type for passthrough. */
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly widthPx?: number;
  readonly heightPx?: number;
  /** Pixel bounds of the unchanged card trim within a derived preview. */
  readonly trimRectPx?: PixelRect;
}

interface BleedResultBase {
  readonly bleedMm: number;
  /** Requested mode retained as the legacy `mode` field for callers. */
  readonly mode: BleedMode;
  readonly requestedMode: BleedMode;
  readonly effectiveMode: BleedEffectiveMode;
  readonly policyId: string;
  readonly sourceStrip: BleedSourceStrip;
  readonly trimSizeMm: TrimSizeMm;
  readonly preview: BleedPreview;
}

export interface BleedPassthroughResult extends BleedResultBase {
  readonly status: "passthrough";
  readonly bleedMm: 0;
  readonly cacheStatus: "bypass";
}

export interface BleedDerivativeResult extends BleedResultBase {
  readonly status: "derived";
  readonly bleedMm: number;
  readonly originalSha256: string;
  readonly algorithmVersion: typeof BLEED_ALGORITHM_VERSION;
  readonly cacheKey: string;
  readonly cacheStatus: "hit" | "miss";
  readonly resolvedSourceStripMm: number;
  readonly sideDiagnostics: Readonly<Record<"top" | "right" | "bottom" | "left", BleedSideDiagnostic>>;
  readonly preview: BleedPreview & {
    readonly mimeType: "image/png";
    readonly widthPx: number;
    readonly heightPx: number;
    readonly trimRectPx: PixelRect;
  };
}

export interface BleedSideDiagnostic {
  readonly requestedMode: BleedMode;
  readonly effectiveMode: BleedMode;
  readonly classification: "not-analyzed" | "interior-strip-found" | "outer-band-not-dark-uniform" | "search-bound-exhausted";
  readonly sourceOffsetPx: number;
  readonly sourceStripPx: number;
  readonly fallbackReason?: string;
}

export type BleedResult = BleedPassthroughResult | BleedDerivativeResult;

export interface BleedRequest {
  readonly imageBytes: Uint8Array;
  readonly bleedMm: number;
  readonly trimSizeMm?: TrimSizeMm;
  readonly mode?: BleedMode;
  /** Identifies the source/default/override policy used for deterministic cache separation. */
  readonly policyId?: string;
  readonly sourceStrip?: BleedSourceStrip;
}

export interface BleedCache {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, bytes: Uint8Array): Promise<void>;
}

export const BLEED_SOURCE_STRIP_SUGGESTIONS_MM = Object.freeze([0.25, 0.5, 0.75, 1] as const);
