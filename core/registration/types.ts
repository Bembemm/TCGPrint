export type RegistrationType = "none" | "three-point" | "four-point" | "custom";
export type RegistrationOrientation = "portrait" | "landscape";

export interface RegistrationPageSizeMm {
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface RegistrationRectMm {
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface RegistrationLinePrimitive {
  readonly type: "line";
  readonly x1Mm: number;
  readonly y1Mm: number;
  readonly x2Mm: number;
  readonly y2Mm: number;
  readonly strokeWidthMm: number;
}

export interface RegistrationRectanglePrimitive {
  readonly type: "rect";
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly fill: boolean;
  readonly strokeWidthMm: number;
}

export interface RegistrationCirclePrimitive {
  readonly type: "circle";
  readonly cxMm: number;
  readonly cyMm: number;
  readonly radiusMm: number;
  readonly fill: boolean;
  readonly strokeWidthMm: number;
}

export type RegistrationPrimitive =
  | RegistrationLinePrimitive
  | RegistrationRectanglePrimitive
  | RegistrationCirclePrimitive;

export interface RegistrationNoneConfig {
  readonly type: "none";
  readonly orientation: RegistrationOrientation;
}

export interface BuiltinRegistrationConfig {
  readonly type: "three-point" | "four-point";
  /** Orientation of the registration pattern, independent of page/card orientation. */
  readonly orientation: RegistrationOrientation;
  readonly insetXMm: number;
  readonly insetYMm: number;
  readonly armLengthMm: number;
  readonly lineThicknessMm: number;
  readonly squareSizeMm: number;
  readonly reservedZoneClearanceMm: number;
}

export interface CustomRegistrationConfig {
  readonly type: "custom";
  /** The coordinate frame in which custom positions were authored. */
  readonly orientation: RegistrationOrientation;
  readonly marks: readonly (readonly RegistrationPrimitive[])[];
  readonly reservedZones: readonly RegistrationRectMm[];
}

export type RegistrationConfig = RegistrationNoneConfig | BuiltinRegistrationConfig | CustomRegistrationConfig;

export interface RegistrationMarkMm {
  readonly id: string;
  readonly kind: "corner" | "square" | "custom";
  readonly primitives: readonly RegistrationPrimitive[];
  readonly bounds: RegistrationRectMm;
}

export interface RegistrationGeometryMm {
  readonly marks: readonly RegistrationMarkMm[];
  readonly reservedZones: readonly RegistrationRectMm[];
}
