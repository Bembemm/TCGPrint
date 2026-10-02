import { DuplexPairingError, type DuplexArtworkOrientation, type DuplexFlipMode, type DuplexReflectionAxis } from "./types";
import type { PageOrientation } from "../geometry";

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

export interface DuplexPhysicalBackPageMapping {
  readonly pageOrientation: PageOrientation;
  readonly flipMode: DuplexFlipMode;
  readonly reflectionAxis: DuplexReflectionAxis;
  readonly matrix: DuplexPageReflectionMatrix;
  readonly artworkOrientation: DuplexArtworkOrientation;
}

/** The canonical Phase 12 physical page axis for an orientation and sheet binding. */
export function getDuplexReflectionAxis(pageOrientation: PageOrientation, flipMode: DuplexFlipMode): DuplexReflectionAxis {
  if (pageOrientation !== "portrait" && pageOrientation !== "landscape") {
    throw new DuplexPairingError("DUPLEX_PAIRING_FAILED", "Duplex page orientation must be portrait or landscape.");
  }
  if (flipMode !== "long-edge" && flipMode !== "short-edge") {
    throw new DuplexPairingError("INVALID_DUPLEX_FLIP", "Duplex flip mode must be long-edge or short-edge.");
  }
  const reflectsX = (pageOrientation === "portrait" && flipMode === "long-edge")
    || (pageOrientation === "landscape" && flipMode === "short-edge");
  return reflectsX ? "x" : "y";
}

/** Returns the same physical reflection and upright-back artwork orientation used by page pairing. */
export function getDuplexPhysicalBackPageMapping(
  pageOrientation: PageOrientation,
  flipMode: DuplexFlipMode,
  pageSizeMm: { readonly widthMm: number; readonly heightMm: number },
): DuplexPhysicalBackPageMapping {
  const reflectionAxis = getDuplexReflectionAxis(pageOrientation, flipMode);
  return Object.freeze({
    pageOrientation,
    flipMode,
    reflectionAxis,
    matrix: getDuplexPageReflectionMatrix(reflectionAxis, pageSizeMm),
    artworkOrientation: Object.freeze({
      rotationDegrees: reflectionAxis === "y" ? 180 : 0,
      mirrorX: false,
      mirrorY: false,
    }),
  });
}

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

/**
 * Applies the canonical page reflection to physical PDF-frame coordinates.
 * Duplex matrices use page-model Y-down coordinates, so Y-up millimeters are
 * converted at both boundaries instead of being reflected in the wrong frame.
 */
export function transformPhysicalPointByDuplexMatrix(
  point: DuplexPagePointMm,
  matrix: DuplexPageReflectionMatrix,
  pageHeightMm: number,
): DuplexPagePointMm {
  if (![point?.xMm, point?.yMm, pageHeightMm].every(Number.isFinite) || pageHeightMm <= 0) {
    throw new RangeError("Physical duplex point and page height must be finite millimeters with a positive page height.");
  }
  const pageYDownPoint = { xMm: point.xMm, yMm: pageHeightMm - point.yMm };
  const reflectedPagePoint = transformPointByDuplexMatrix(pageYDownPoint, matrix);
  return Object.freeze({ xMm: reflectedPagePoint.xMm, yMm: pageHeightMm - reflectedPagePoint.yMm });
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
