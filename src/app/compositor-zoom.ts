export interface CompositorViewportSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface CompositorPageSizeMm {
  readonly widthMm: number;
  readonly heightMm: number;
}

/** Browser CSS pixels at 96 CSS px per inch, converted to physical millimeters. */
export const COMPOSITOR_CSS_PX_PER_MM = 96 / 25.4;
export const COMPOSITOR_FIT_PADDING_PX = 16;

export function calculateCompositorScale(
  viewport: CompositorViewportSize,
  page: CompositorPageSizeMm,
  paddingPx = COMPOSITOR_FIT_PADDING_PX,
): number {
  const usefulWidth = Math.max(0, viewport.widthPx - 2 * paddingPx);
  const usefulHeight = Math.max(0, viewport.heightPx - 2 * paddingPx);
  const baseWidth = page.widthMm * COMPOSITOR_CSS_PX_PER_MM;
  const baseHeight = page.heightMm * COMPOSITOR_CSS_PX_PER_MM;
  if (!(usefulWidth > 0) || !(baseWidth > 0)) return 1;
  const widthScale = usefulWidth / baseWidth;
  if (!(usefulHeight > 0) || !(baseHeight > 0)) return 1;
  return Math.min(widthScale, usefulHeight / baseHeight);
}
