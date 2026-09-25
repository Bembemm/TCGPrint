export const MAGIC_STANDARD_TRIM_MM = { width: 63.5, height: 88.9 } as const;

export type ArtworkResolutionQuality = "excellent" | "good" | "warning" | "low" | "unknown";

export function calculateEffectiveDpi(widthPx: number | undefined, heightPx: number | undefined): number | undefined {
  if (!widthPx || !heightPx || !Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) return undefined;
  const widthInches = MAGIC_STANDARD_TRIM_MM.width / 25.4;
  const heightInches = MAGIC_STANDARD_TRIM_MM.height / 25.4;
  return Math.floor(Math.min(widthPx / widthInches, heightPx / heightInches) + 1e-9);
}

export function artworkResolutionQuality(effectiveDpi: number | undefined): ArtworkResolutionQuality {
  if (effectiveDpi === undefined) return "unknown";
  if (effectiveDpi >= 600) return "excellent";
  if (effectiveDpi >= 300) return "good";
  if (effectiveDpi >= 200) return "warning";
  return "low";
}
