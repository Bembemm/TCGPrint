import { MAX_REGISTRATION_PAGE_DIMENSION_MM, parseRegistrationConfig } from "./config";
import type {
  BuiltinRegistrationConfig,
  RegistrationConfig,
  RegistrationGeometryMm,
  RegistrationMarkMm,
  RegistrationPageSizeMm,
  RegistrationPrimitive,
  RegistrationRectMm,
} from "./types";

const GEOMETRY_EPSILON_MM = 1e-9;

function pointBounds(xMm: number, yMm: number): RegistrationRectMm {
  return { xMm, yMm, widthMm: 0, heightMm: 0 };
}

function unionBounds(bounds: readonly RegistrationRectMm[]): RegistrationRectMm {
  const left = Math.min(...bounds.map(({ xMm }) => xMm));
  const top = Math.min(...bounds.map(({ yMm }) => yMm));
  const right = Math.max(...bounds.map(({ xMm, widthMm }) => xMm + widthMm));
  const bottom = Math.max(...bounds.map(({ yMm, heightMm }) => yMm + heightMm));
  return { xMm: left, yMm: top, widthMm: right - left, heightMm: bottom - top };
}

function primitiveBounds(primitive: RegistrationPrimitive): RegistrationRectMm {
  if (primitive.type === "line") {
    const radius = primitive.strokeWidthMm / 2;
    const left = Math.min(primitive.x1Mm, primitive.x2Mm) - radius;
    const top = Math.min(primitive.y1Mm, primitive.y2Mm) - radius;
    return {
      xMm: left,
      yMm: top,
      widthMm: Math.abs(primitive.x2Mm - primitive.x1Mm) + primitive.strokeWidthMm,
      heightMm: Math.abs(primitive.y2Mm - primitive.y1Mm) + primitive.strokeWidthMm,
    };
  }
  if (primitive.type === "rect") {
    const radius = primitive.strokeWidthMm / 2;
    return {
      xMm: primitive.xMm - radius,
      yMm: primitive.yMm - radius,
      widthMm: primitive.widthMm + primitive.strokeWidthMm,
      heightMm: primitive.heightMm + primitive.strokeWidthMm,
    };
  }
  const radius = primitive.radiusMm + primitive.strokeWidthMm / 2;
  return { xMm: primitive.cxMm - radius, yMm: primitive.cyMm - radius, widthMm: radius * 2, heightMm: radius * 2 };
}

function assertInsidePage(bounds: RegistrationRectMm, page: RegistrationPageSizeMm, label: string): void {
  if (bounds.xMm < -GEOMETRY_EPSILON_MM
    || bounds.yMm < -GEOMETRY_EPSILON_MM
    || bounds.xMm + bounds.widthMm > page.widthMm + GEOMETRY_EPSILON_MM
    || bounds.yMm + bounds.heightMm > page.heightMm + GEOMETRY_EPSILON_MM) {
    throw new RangeError(`Registration ${label} is outside page bounds.`);
  }
}

function actualOrientation(page: RegistrationPageSizeMm): "portrait" | "landscape" {
  return page.widthMm > page.heightMm ? "landscape" : "portrait";
}

function rotatePoint(
  xMm: number,
  yMm: number,
  configOrientation: "portrait" | "landscape",
  page: RegistrationPageSizeMm,
): { readonly xMm: number; readonly yMm: number } {
  if (configOrientation === actualOrientation(page)) return { xMm, yMm };
  if (configOrientation === "landscape") {
    // A landscape-authored frame is rotated onto a portrait physical sheet.
    return { xMm: yMm, yMm: page.heightMm - xMm };
  }
  // A portrait-authored frame is rotated onto a landscape physical sheet.
  return { xMm: page.widthMm - yMm, yMm: xMm };
}

function orientPrimitive(
  primitive: RegistrationPrimitive,
  orientation: "portrait" | "landscape",
  page: RegistrationPageSizeMm,
): RegistrationPrimitive {
  const point = (x: number, y: number) => rotatePoint(x, y, orientation, page);
  if (primitive.type === "line") {
    const first = point(primitive.x1Mm, primitive.y1Mm);
    const second = point(primitive.x2Mm, primitive.y2Mm);
    return { ...primitive, x1Mm: first.xMm, y1Mm: first.yMm, x2Mm: second.xMm, y2Mm: second.yMm };
  }
  if (primitive.type === "circle") {
    const center = point(primitive.cxMm, primitive.cyMm);
    return { ...primitive, cxMm: center.xMm, cyMm: center.yMm };
  }
  const corners = [
    point(primitive.xMm, primitive.yMm),
    point(primitive.xMm + primitive.widthMm, primitive.yMm),
    point(primitive.xMm, primitive.yMm + primitive.heightMm),
    point(primitive.xMm + primitive.widthMm, primitive.yMm + primitive.heightMm),
  ];
  const bounds = unionBounds(corners.map(({ xMm, yMm }) => pointBounds(xMm, yMm)));
  return { ...primitive, xMm: bounds.xMm, yMm: bounds.yMm, widthMm: bounds.widthMm, heightMm: bounds.heightMm };
}

function orientRect(
  rect: RegistrationRectMm,
  orientation: "portrait" | "landscape",
  page: RegistrationPageSizeMm,
): RegistrationRectMm {
  const corners = [
    rotatePoint(rect.xMm, rect.yMm, orientation, page),
    rotatePoint(rect.xMm + rect.widthMm, rect.yMm, orientation, page),
    rotatePoint(rect.xMm, rect.yMm + rect.heightMm, orientation, page),
    rotatePoint(rect.xMm + rect.widthMm, rect.yMm + rect.heightMm, orientation, page),
  ];
  return unionBounds(corners.map(({ xMm, yMm }) => pointBounds(xMm, yMm)));
}

function line(x1Mm: number, y1Mm: number, x2Mm: number, y2Mm: number, strokeWidthMm: number): RegistrationPrimitive {
  return { type: "line", x1Mm, y1Mm, x2Mm, y2Mm, strokeWidthMm };
}

type Corner = "top-left" | "top-right" | "bottom-right" | "bottom-left";

function cornerMark(corner: Corner, config: BuiltinRegistrationConfig, page: RegistrationPageSizeMm): RegistrationPrimitive[] {
  const xMm = corner.includes("left") ? config.insetXMm : page.widthMm - config.insetXMm;
  const yMm = corner.startsWith("top") ? config.insetYMm : page.heightMm - config.insetYMm;
  const horizontalDirection = corner.includes("left") ? 1 : -1;
  const verticalDirection = corner.startsWith("top") ? 1 : -1;
  const length = config.armLengthMm;
  return [
    line(xMm, yMm, xMm + horizontalDirection * length, yMm, config.lineThicknessMm),
    line(xMm, yMm, xMm, yMm + verticalDirection * length, config.lineThicknessMm),
  ];
}

function squareMark(config: BuiltinRegistrationConfig, page: RegistrationPageSizeMm): RegistrationPrimitive[] {
  const xMm = config.orientation === "landscape" ? page.widthMm - config.insetXMm : config.insetXMm;
  const yMm = config.orientation === "landscape" ? config.insetYMm : page.heightMm - config.insetYMm;
  const half = config.squareSizeMm / 2;
  return [{
    type: "rect",
    xMm: xMm - half,
    yMm: yMm - half,
    widthMm: config.squareSizeMm,
    heightMm: config.squareSizeMm,
    fill: true,
    strokeWidthMm: config.lineThicknessMm,
  }];
}

function builtinMarks(config: BuiltinRegistrationConfig, page: RegistrationPageSizeMm): RegistrationMarkMm[] {
  const corners: readonly Corner[] = config.type === "four-point"
    ? ["top-left", "top-right", "bottom-right", "bottom-left"]
    : ["top-left", "bottom-right"];
  const marks: RegistrationMarkMm[] = corners.map((corner) => {
    const primitives = cornerMark(corner, config, page);
    return { id: corner, kind: "corner", primitives, bounds: unionBounds(primitives.map(primitiveBounds)) };
  });
  if (config.type === "three-point") {
    const primitives = squareMark(config, page);
    marks.splice(1, 0, { id: "orientation-square", kind: "square", primitives, bounds: unionBounds(primitives.map(primitiveBounds)) });
  }
  return marks;
}

function makeZones(marks: readonly RegistrationMarkMm[], clearanceMm: number): RegistrationRectMm[] {
  return marks.map(({ bounds }) => ({
    xMm: bounds.xMm - clearanceMm,
    yMm: bounds.yMm - clearanceMm,
    widthMm: bounds.widthMm + clearanceMm * 2,
    heightMm: bounds.heightMm + clearanceMm * 2,
  }));
}

function customMarks(
  config: Extract<RegistrationConfig, { readonly type: "custom" }>,
  page: RegistrationPageSizeMm,
): RegistrationMarkMm[] {
  return config.marks.map((primitives, index) => {
    const oriented = primitives.map((primitive) => orientPrimitive(primitive, config.orientation, page));
    const bounds = unionBounds(oriented.map(primitiveBounds));
    assertInsidePage(bounds, page, `custom mark ${index + 1}`);
    return { id: `custom-${index + 1}`, kind: "custom", primitives: oriented, bounds };
  });
}

export function generateRegistrationGeometry(
  input: unknown,
  pageSizeMm: RegistrationPageSizeMm,
): RegistrationGeometryMm {
  const config = parseRegistrationConfig(input);
  for (const [name, value] of Object.entries(pageSizeMm)) {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_REGISTRATION_PAGE_DIMENSION_MM) {
      throw new RangeError(`Registration page ${name} must be a finite physical dimension no greater than 2000 mm.`);
    }
  }
  if (config.type === "none") return Object.freeze({ marks: Object.freeze([]), reservedZones: Object.freeze([]) });

  const marks = config.type === "custom" ? customMarks(config, pageSizeMm) : builtinMarks(config, {
    widthMm: config.orientation === actualOrientation(pageSizeMm) ? pageSizeMm.widthMm : pageSizeMm.heightMm,
    heightMm: config.orientation === actualOrientation(pageSizeMm) ? pageSizeMm.heightMm : pageSizeMm.widthMm,
  }).map((mark) => ({
    ...mark,
    primitives: mark.primitives.map((primitive) => orientPrimitive(primitive, config.orientation, pageSizeMm)),
    bounds: unionBounds(mark.primitives.map((primitive) => primitiveBounds(orientPrimitive(primitive, config.orientation, pageSizeMm)))),
  }));

  const customZones = config.type === "custom"
    ? config.reservedZones.map((zone) => orientRect(zone, config.orientation, pageSizeMm))
    : makeZones(marks, config.reservedZoneClearanceMm);
  const uniqueZones = config.type === "custom" ? [...makeZones(marks, 0), ...customZones] : customZones;
  for (let index = 0; index < uniqueZones.length; index += 1) {
    assertInsidePage(uniqueZones[index], pageSizeMm, `reserved zone ${index + 1}`);
  }

  return Object.freeze({
    marks: Object.freeze(marks.map((mark) => Object.freeze({
      ...mark,
      primitives: Object.freeze(mark.primitives.map((primitive) => Object.freeze(primitive))),
      bounds: Object.freeze(mark.bounds),
    }))),
    reservedZones: Object.freeze(uniqueZones.map((zone) => Object.freeze(zone))),
  });
}
