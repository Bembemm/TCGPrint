import type {
  RegistrationGeometryMm,
  RegistrationPageSizeMm,
  RegistrationPrimitive,
  RegistrationRectMm,
} from "./types";

export type RegistrationReflectionAxis = "x" | "y";

function reflectRect(rect: RegistrationRectMm, page: RegistrationPageSizeMm, axis: RegistrationReflectionAxis): RegistrationRectMm {
  return axis === "x"
    ? { ...rect, xMm: page.widthMm - rect.xMm - rect.widthMm }
    : { ...rect, yMm: page.heightMm - rect.yMm - rect.heightMm };
}

function reflectPrimitive(primitive: RegistrationPrimitive, page: RegistrationPageSizeMm, axis: RegistrationReflectionAxis): RegistrationPrimitive {
  if (primitive.type === "line") {
    return axis === "x"
      ? { ...primitive, x1Mm: page.widthMm - primitive.x1Mm, x2Mm: page.widthMm - primitive.x2Mm }
      : { ...primitive, y1Mm: page.heightMm - primitive.y1Mm, y2Mm: page.heightMm - primitive.y2Mm };
  }
  if (primitive.type === "circle") {
    return axis === "x"
      ? { ...primitive, cxMm: page.widthMm - primitive.cxMm }
      : { ...primitive, cyMm: page.heightMm - primitive.cyMm };
  }
  return axis === "x"
    ? { ...primitive, xMm: page.widthMm - primitive.xMm - primitive.widthMm }
    : { ...primitive, yMm: page.heightMm - primitive.yMm - primitive.heightMm };
}

/** Reflects registration vectors and reserved zones into the back page's physical coordinate frame. */
export function transformRegistrationGeometry(
  geometry: RegistrationGeometryMm,
  page: RegistrationPageSizeMm,
  axis: RegistrationReflectionAxis,
): RegistrationGeometryMm {
  if (axis !== "x" && axis !== "y") throw new RangeError("Registration reflection axis must be x or y.");
  if (![page.widthMm, page.heightMm].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("Registration transform page dimensions must be finite positive millimeters.");
  }
  return Object.freeze({
    marks: Object.freeze(geometry.marks.map((mark) => Object.freeze({
      ...mark,
      primitives: Object.freeze(mark.primitives.map((primitive) => Object.freeze(reflectPrimitive(primitive, page, axis)))),
      bounds: Object.freeze(reflectRect(mark.bounds, page, axis)),
    }))),
    reservedZones: Object.freeze(geometry.reservedZones.map((zone) => Object.freeze(reflectRect(zone, page, axis)))),
  });
}
