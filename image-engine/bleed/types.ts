export const BLEED_ALGORITHM_VERSION = "edge-extension-v1" as const;
export const ROUNDED_CORNERS_VERSION = "rounded-corners-v1" as const;

export type BleedMode = "edge-extension";
export type BleedModePreference = "auto" | BleedMode;
export type BleedEffectiveMode = BleedMode;
export type BleedSide = "top" | "right" | "bottom" | "left";

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
  readonly mode: BleedMode;
  readonly requestedMode: BleedMode;
  readonly effectiveMode: BleedEffectiveMode;
  readonly policyId: string;
  readonly trimSizeMm: TrimSizeMm;
  readonly preview: BleedPreview;
  readonly roundedCorners: boolean;
  readonly cornerRadiusMm?: number;
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
  readonly sideDiagnostics: Readonly<Record<BleedSide, BleedSideDiagnostic>>;
  readonly preview: BleedPreview & {
    readonly mimeType: "image/png";
    readonly widthPx: number;
    readonly heightPx: number;
    readonly trimRectPx: PixelRect;
  };
}

export interface BleedSideDiagnostic {
  readonly strategy: "nearest-edge-pixel";
}

export type BleedResult = BleedPassthroughResult | BleedDerivativeResult;

export interface BleedRequest {
  readonly imageBytes: Uint8Array;
  readonly bleedMm: number;
  readonly trimSizeMm?: TrimSizeMm;
  readonly mode?: BleedMode;
  readonly policyId?: string;
  readonly roundedCorners?: boolean;
  readonly cornerRadiusMm?: number;
}

export interface BleedCache {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, bytes: Uint8Array): Promise<void>;
}
