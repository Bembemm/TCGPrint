import type { DuplexReflectionAxis } from "./types";

export interface DuplexPagePointMm {
  readonly xMm: number;
  readonly yMm: number;
}

export interface DuplexPageReflectionMatrix {
  /** SVG/PDF affine matrix coefficients: x'=a*x+c*y+e, y'=b*x+d*y+f. */
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export type DuplexPreviewSide = "front" | "back";

/** Reflection in page coordinates (mm), for vector overlays that share back placement coordinates. */
export function getDuplexPageReflectionMatrix(
  axis: DuplexReflectionAxis,
  pageSizeMm: { readonly widthMm: number; readonly heightMm: number },
): DuplexPageReflectionMatrix {
  if (!Number.isFinite(pageSizeMm.widthMm) || pageSizeMm.widthMm <= 0
    || !Number.isFinite(pageSizeMm.heightMm) || pageSizeMm.heightMm <= 0) {
    throw new RangeError("Duplex page dimensions must be finite positive millimeters.");
  }
  if (axis === "x") return Object.freeze({ a: -1, b: 0, c: 0, d: 1, e: pageSizeMm.widthMm, f: 0 });
  if (axis === "y") return Object.freeze({ a: 1, b: 0, c: 0, d: -1, e: 0, f: pageSizeMm.heightMm });
  throw new RangeError("Duplex reflection axis must be x or y.");
}

export function transformPointByDuplexMatrix(point: DuplexPagePointMm, matrix: DuplexPageReflectionMatrix): DuplexPagePointMm {
  return Object.freeze({
    xMm: matrix.a * point.xMm + matrix.c * point.yMm + matrix.e,
    yMm: matrix.b * point.xMm + matrix.d * point.yMm + matrix.f,
  });
}

/** Page-space overlay matrix selected by the same side control used by the sheet preview. */
export function getDuplexPreviewOverlayMatrix(
  side: DuplexPreviewSide,
  axis: DuplexReflectionAxis,
  pageSizeMm: { readonly widthMm: number; readonly heightMm: number },
): DuplexPageReflectionMatrix {
  if (side === "front") return Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  if (side === "back") return getDuplexPageReflectionMatrix(axis, pageSizeMm);
  throw new RangeError("Duplex preview side must be front or back.");
}
