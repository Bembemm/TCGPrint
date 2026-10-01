export interface CutPointMm {
  readonly xMm: number;
  readonly yMm: number;
}

export interface CutBoundsMm {
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface CutSourceIdentity {
  readonly kind: "template-file";
  readonly templateId: string;
  readonly version: string;
  readonly packageHash: string;
  readonly fileId: string;
  readonly fileHash: string;
}

export interface ManualCutGeometrySource {
  readonly kind: "project-layout";
  readonly projectId: string;
  readonly projectRevision: number;
}

export type CutGeometrySource = CutSourceIdentity | ManualCutGeometrySource;

export type DxfUnitsOverride = "mm" | "cm" | "m" | "in" | "ft" | "yd";

/** Durable Project choice; joined to TemplateSelection before every source read. */
export interface CutSourceSelection {
  readonly fileId: string;
  readonly fileHash: string;
  readonly dxfUnitsOverride?: DxfUnitsOverride;
}

export interface CutLineSegmentMm {
  readonly type: "line";
  readonly from: CutPointMm;
  readonly to: CutPointMm;
}

export interface CutCubicSegmentMm {
  readonly type: "cubic";
  readonly from: CutPointMm;
  readonly control1: CutPointMm;
  readonly control2: CutPointMm;
  readonly to: CutPointMm;
}

export interface CutQuadraticSegmentMm {
  readonly type: "quadratic";
  readonly from: CutPointMm;
  readonly control: CutPointMm;
  readonly to: CutPointMm;
}

/** Ellipse parameterization: center + axisU*cos(t) + axisV*sin(t). */
export interface CutArcSegmentMm {
  readonly type: "arc";
  readonly from: CutPointMm;
  readonly to: CutPointMm;
  readonly center: CutPointMm;
  readonly axisU: CutPointMm;
  readonly axisV: CutPointMm;
  readonly startAngleRad: number;
  readonly sweepAngleRad: number;
}

export type CutSegmentMm = CutLineSegmentMm | CutCubicSegmentMm | CutQuadraticSegmentMm | CutArcSegmentMm;

export interface CutPathMm {
  /** Stable within the exact immutable source file; source hash is part of CutGeometryMm. */
  readonly id: string;
  readonly start: CutPointMm;
  /** closed adds an implicit final line back to start when the last segment differs. */
  readonly closed: boolean;
  readonly segments: readonly CutSegmentMm[];
  readonly boundsMm: CutBoundsMm;
}

export interface CutGeometryMm {
  readonly modelVersion: 1;
  readonly units: "mm";
  readonly coordinateFrame: "page-top-left-y-down";
  readonly pageSizeMm: { readonly widthMm: number; readonly heightMm: number };
  readonly source: CutGeometrySource;
  readonly paths: readonly CutPathMm[];
  readonly boundsMm: CutBoundsMm;
}

export interface CutGeometryInput {
  readonly source: CutGeometrySource;
  readonly pageSizeMm: { readonly widthMm: number; readonly heightMm: number };
  readonly paths: readonly Omit<CutPathMm, "boundsMm">[];
}

export interface CutGeometryComparison {
  readonly equal: boolean;
  readonly maximumDeltaMm: number;
  readonly differences: readonly string[];
}
