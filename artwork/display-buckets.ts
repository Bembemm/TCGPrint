export const ARTWORK_DISPLAY_WIDTH_BUCKETS = [512, 768, 1024, 1280] as const;

export type ArtworkDisplayWidthBucket = (typeof ARTWORK_DISPLAY_WIDTH_BUCKETS)[number];

export function isArtworkDisplayWidthBucket(value: number): value is ArtworkDisplayWidthBucket {
  return ARTWORK_DISPLAY_WIDTH_BUCKETS.some((bucket) => bucket === value);
}
