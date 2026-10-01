export type CalibrationSide = "front" | "back";

export interface CalibrationPageSizeMm {
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface CalibrationPointMm {
  readonly xMm: number;
  readonly yMm: number;
}

export interface CalibrationPageOverflowMm {
  readonly leftMm: number;
  readonly rightMm: number;
  readonly bottomMm: number;
  readonly topMm: number;
  readonly maximumMm: number;
  /** Signed distance to the nearest page edge; negative values mean overflow. */
  readonly minimumClearanceMm: number;
}

export interface CalibrationPageRectMm {
  /** Page-layout rectangle in its existing top-left / Y-down millimeter frame. */
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

/** SVG/PDF affine coefficients: x'=a*x+c*y+e, y'=b*x+d*y+f. */
export interface CalibrationAffineMatrixMm {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface SideCalibration {
  /** Fine print offsets in integer micrometers; positive Y is visually upward. */
  readonly offsetXUm: number;
  readonly offsetYUm: number;
  readonly rotationDeg: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly skewXDeg?: number;
  readonly skewYDeg?: number;
}

export interface PrintCalibrationTransform {
  readonly side: CalibrationSide;
  /** Center of the oriented physical page in PDF coordinates (origin bottom-left). */
  readonly anchor: CalibrationPointMm;
  /** Matrix in the physical PDF frame: positive X right, positive Y up. */
  readonly matrix: CalibrationAffineMatrixMm;
  /** The same transform converted to SVG/page coordinates: origin top-left, positive Y down. */
  readonly svgMatrix: CalibrationAffineMatrixMm;
  readonly isIdentity: boolean;
}

export interface CalibrationParameterBounds {
  readonly minimum: number;
  readonly maximum: number;
}

export type PrinterDuplexMode =
  | "manual-long-edge"
  | "manual-short-edge"
  | "automatic-long-edge"
  | "automatic-short-edge"
  | "single-sided";

export type PhysicalValidationStatus = "software-only" | "physically-verified";

export interface PhysicalVerificationMeasurement {
  readonly pointId: "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** Residual after applying this profile's correction, signed in physical millimeters converted to µm. */
  readonly residualXUm: number;
  readonly residualYUm: number;
}

export interface PhysicalVerificationRecord {
  readonly sessionId: string;
  readonly verifiedAt: string;
  readonly measurements: readonly PhysicalVerificationMeasurement[];
  readonly residualSummaryMm: {
    readonly mean: number;
    readonly minimum: number;
    readonly maximum: number;
  };
}

export interface PrinterProfile {
  readonly id: string;
  readonly name: string;
  readonly front: SideCalibration;
  readonly back: SideCalibration;
  readonly paperSize: string;
  /** Base portrait dimensions for the paper size; orientation is stored separately. */
  readonly paperWidthMm: number;
  readonly paperHeightMm: number;
  readonly pageOrientation: "portrait" | "landscape";
  readonly duplexMode: PrinterDuplexMode;
  readonly mediaType?: string;
  readonly printQualityProfile?: string;
  readonly feedSource?: string;
  readonly notes?: string;
  readonly physicalValidationStatus: PhysicalValidationStatus;
  readonly physicalVerification?: PhysicalVerificationRecord | null;
}

/** Self-contained immutable profile revision embedded in a Project. */
export interface PrinterProfileSnapshot extends PrinterProfile {
  readonly version: number;
  readonly profileHash: string;
}
