import { ARTWORK_DISPLAY_WIDTH_BUCKETS, type ArtworkDisplayWidthBucket } from "../../artwork/display-buckets";

/** Pick a stable display asset size from the artwork's rendered CSS width and screen density. */
export function selectCompositorDisplayBucket(
  displayedCssWidth: number,
  devicePixelRatio: number,
): ArtworkDisplayWidthBucket {
  if (!Number.isFinite(displayedCssWidth) || displayedCssWidth <= 0) return ARTWORK_DISPLAY_WIDTH_BUCKETS[0];

  const density = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const targetPixels = Math.min(ARTWORK_DISPLAY_WIDTH_BUCKETS.at(-1)!, Math.ceil(displayedCssWidth * Math.max(2, density * 1.5)));
  return ARTWORK_DISPLAY_WIDTH_BUCKETS.find((bucket) => bucket >= targetPixels) ?? ARTWORK_DISPLAY_WIDTH_BUCKETS.at(-1)!;
}
