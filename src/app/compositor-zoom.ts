export type CompositorZoomMode = "fit-page" | "fit-width" | "100%" | "manual";

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
export const COMPOSITOR_ZOOM_STEP = 0.1;
export const COMPOSITOR_MIN_ZOOM = 0.25;
export const COMPOSITOR_MAX_ZOOM = 4;

export function calculateCompositorScale(
  mode: CompositorZoomMode,
  viewport: CompositorViewportSize,
  page: CompositorPageSizeMm,
  paddingPx = COMPOSITOR_FIT_PADDING_PX,
): number {
  if (mode === "100%") return 1;
  const usefulWidth = Math.max(0, viewport.widthPx - 2 * paddingPx);
  const usefulHeight = Math.max(0, viewport.heightPx - 2 * paddingPx);
  const baseWidth = page.widthMm * COMPOSITOR_CSS_PX_PER_MM;
  const baseHeight = page.heightMm * COMPOSITOR_CSS_PX_PER_MM;
  if (!(usefulWidth > 0) || !(baseWidth > 0)) return 1;
  const widthScale = usefulWidth / baseWidth;
  if (mode === "fit-width") return widthScale;
  if (!(usefulHeight > 0) || !(baseHeight > 0)) return 1;
  if (mode === "fit-page") return Math.min(widthScale, usefulHeight / baseHeight);
  return 1;
}

export function stepCompositorScale(current: number, direction: -1 | 1): number {
  const next = current + direction * COMPOSITOR_ZOOM_STEP;
  return Math.max(COMPOSITOR_MIN_ZOOM, Math.min(COMPOSITOR_MAX_ZOOM, Number(next.toFixed(2))));
}
