export type CompositorInsertionAxis = "horizontal" | "vertical";

export interface CompositorRectBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Infers the sequence axis from adjacent visual slot bounds. */
export function deriveCompositorInsertionAxis(
  slots: readonly CompositorRectBounds[],
  fallback: CompositorInsertionAxis = "horizontal",
): CompositorInsertionAxis {
  const first = slots[0];
  if (!first) return fallback;
  const firstCenterX = first.left + first.width / 2;
  const firstCenterY = first.top + first.height / 2;
  for (const slot of slots.slice(1)) {
    const deltaX = Math.abs(slot.left + slot.width / 2 - firstCenterX);
    const deltaY = Math.abs(slot.top + slot.height / 2 - firstCenterY);
    if (deltaX === 0 && deltaY === 0) continue;
    return deltaX >= deltaY ? "horizontal" : "vertical";
  }
  return fallback;
}

/** Resolves insertion against the actual target rectangle in the visual sequence axis. */
export function resolveCompositorInsertionPlacement(
  target: CompositorRectBounds,
  clientX: number,
  clientY: number,
  axis: CompositorInsertionAxis,
): "before" | "after" {
  const start = axis === "horizontal" ? target.left : target.top;
  const size = axis === "horizontal" ? target.width : target.height;
  const point = axis === "horizontal" ? clientX : clientY;
  if (!Number.isFinite(start) || !Number.isFinite(size) || size <= 0 || !Number.isFinite(point)) return "before";
  return point < start + size / 2 ? "before" : "after";
}
