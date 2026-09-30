import type {
  BuiltinRegistrationConfig,
  CustomRegistrationConfig,
  RegistrationConfig,
  RegistrationOrientation,
  RegistrationPrimitive,
  RegistrationRectMm,
  RegistrationType,
} from "./types";

export const MAX_REGISTRATION_PAGE_DIMENSION_MM = 2_000;
export const MAX_REGISTRATION_CUSTOM_MARKS = 32;
export const MAX_REGISTRATION_CUSTOM_PRIMITIVES = 128;
export const MAX_REGISTRATION_CUSTOM_PRIMITIVES_PER_MARK = 16;
export const MAX_REGISTRATION_CUSTOM_ZONES = 64;
export const MAX_REGISTRATION_CONFIG_JSON_BYTES = 64 * 1024;

const MAX_GEOMETRY_VALUE_MM = 2_000;
const MAX_STROKE_WIDTH_MM = 20;
const MAX_REGISTRATION_INPUT_NODES = 1_024;
const MAX_REGISTRATION_INPUT_DEPTH = 12;
const DEFAULT_INSET_X_MM = 10;
const DEFAULT_INSET_Y_MM = 10;
const DEFAULT_ARM_LENGTH_MM = 5;
const DEFAULT_LINE_THICKNESS_MM = 1;
const DEFAULT_SQUARE_SIZE_MM = 5;

export interface BuiltinRegistrationOverrides {
  readonly insetXMm?: number;
  readonly insetYMm?: number;
  readonly armLengthMm?: number;
  readonly lineThicknessMm?: number;
  readonly squareSizeMm?: number;
  readonly reservedZoneClearanceMm?: number;
}

type DataObject = Record<string, unknown>;

function invalid(message: string): never {
  throw new TypeError(`Registration configuration ${message}`);
}

function assertBoundedData(value: unknown): void {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_REGISTRATION_INPUT_NODES) invalid(`must contain at most ${MAX_REGISTRATION_INPUT_NODES} data nodes.`);
    if (depth > MAX_REGISTRATION_INPUT_DEPTH) invalid(`must not exceed nesting depth ${MAX_REGISTRATION_INPUT_DEPTH}.`);
    if (typeof current === "string") {
      if (current.length > MAX_REGISTRATION_CONFIG_JSON_BYTES) invalid(`must not exceed ${MAX_REGISTRATION_CONFIG_JSON_BYTES} serialized bytes.`);
      bytes += new TextEncoder().encode(current).byteLength;
      if (bytes > MAX_REGISTRATION_CONFIG_JSON_BYTES) invalid(`must not exceed ${MAX_REGISTRATION_CONFIG_JSON_BYTES} serialized bytes.`);
      return;
    }
    if (current === null || typeof current === "boolean") { bytes += 8; return; }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalid("must contain only finite JSON numbers.");
      bytes += 24;
      return;
    }
    if (typeof current !== "object") invalid("must contain only serializable JSON data.");
    if (ancestors.has(current)) invalid("must not contain cyclic data.");
    ancestors.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_REGISTRATION_CUSTOM_PRIMITIVES) invalid(`arrays must contain at most ${MAX_REGISTRATION_CUSTOM_PRIMITIVES} entries.`);
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) {
        invalid("arrays must not contain extra or symbol properties.");
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(current, index)) invalid("arrays must not contain sparse entries.");
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid("arrays must contain only data entries.");
        visit(descriptor.value, depth + 1);
      }
    } else {
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
        invalid("objects must be plain JSON records.");
      }
      const keys = Reflect.ownKeys(current);
      if (keys.length > 16) invalid("objects contain too many fields.");
      for (const key of keys) {
        if (typeof key !== "string") invalid("objects must not contain symbol fields.");
        bytes += new TextEncoder().encode(key).byteLength;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) invalid("objects must contain only enumerable data fields.");
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(current);
    if (bytes > MAX_REGISTRATION_CONFIG_JSON_BYTES) invalid(`must not exceed ${MAX_REGISTRATION_CONFIG_JSON_BYTES} serialized bytes.`);
  };
  visit(value, 0);
}

function record(value: unknown, label: string): DataObject {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid(`${label} must be a plain object.`);
  }
  return value as DataObject;
}

function exactKeys(source: DataObject, keys: readonly string[], label: string): void {
  if (Reflect.ownKeys(source).some((key) => typeof key !== "string" || !keys.includes(key))) {
    invalid(`${label} contains an unsupported field.`);
  }
}

function finite(value: unknown, label: string, minimum: number, maximum = MAX_GEOMETRY_VALUE_MM): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be a finite millimeter value between ${minimum} and ${maximum}.`);
  }
  return value;
}

function orientation(value: unknown): RegistrationOrientation {
  if (value !== "portrait" && value !== "landscape") invalid("orientation must be portrait or landscape.");
  return value;
}

function configuredNumber(source: DataObject, key: string, fallback: number, minimum: number, maximum = MAX_GEOMETRY_VALUE_MM): number {
  return source[key] === undefined ? fallback : finite(source[key], key, minimum, maximum);
}

function parseRect(value: unknown, label: string): RegistrationRectMm {
  const source = record(value, label);
  exactKeys(source, ["xMm", "yMm", "widthMm", "heightMm"], label);
  return Object.freeze({
    xMm: finite(source.xMm, `${label}.xMm`, 0),
    yMm: finite(source.yMm, `${label}.yMm`, 0),
    widthMm: finite(source.widthMm, `${label}.widthMm`, Number.MIN_VALUE),
    heightMm: finite(source.heightMm, `${label}.heightMm`, Number.MIN_VALUE),
  });
}

function parsePrimitive(value: unknown, label: string): RegistrationPrimitive {
  const source = record(value, label);
  if (source.type === "line") {
    exactKeys(source, ["type", "x1Mm", "y1Mm", "x2Mm", "y2Mm", "strokeWidthMm"], label);
    const x1Mm = finite(source.x1Mm, `${label}.x1Mm`, 0);
    const y1Mm = finite(source.y1Mm, `${label}.y1Mm`, 0);
    const x2Mm = finite(source.x2Mm, `${label}.x2Mm`, 0);
    const y2Mm = finite(source.y2Mm, `${label}.y2Mm`, 0);
    if (x1Mm === x2Mm && y1Mm === y2Mm) invalid(`${label} line must have a positive length.`);
    return Object.freeze({
      type: "line", x1Mm, y1Mm, x2Mm, y2Mm,
      strokeWidthMm: finite(source.strokeWidthMm, `${label}.strokeWidthMm`, Number.MIN_VALUE, MAX_STROKE_WIDTH_MM),
    });
  }
  if (source.type === "rect") {
    exactKeys(source, ["type", "xMm", "yMm", "widthMm", "heightMm", "fill", "strokeWidthMm"], label);
    if (typeof source.fill !== "boolean") invalid(`${label}.fill must be a boolean.`);
    const strokeWidthMm = finite(source.strokeWidthMm, `${label}.strokeWidthMm`, 0, MAX_STROKE_WIDTH_MM);
    if (!source.fill && strokeWidthMm === 0) invalid(`${label} must be filled or have a positive stroke width.`);
    return Object.freeze({
      type: "rect",
      xMm: finite(source.xMm, `${label}.xMm`, 0),
      yMm: finite(source.yMm, `${label}.yMm`, 0),
      widthMm: finite(source.widthMm, `${label}.widthMm`, Number.MIN_VALUE),
      heightMm: finite(source.heightMm, `${label}.heightMm`, Number.MIN_VALUE),
      fill: source.fill,
      strokeWidthMm,
    });
  }
  if (source.type === "circle") {
    exactKeys(source, ["type", "cxMm", "cyMm", "radiusMm", "fill", "strokeWidthMm"], label);
    if (typeof source.fill !== "boolean") invalid(`${label}.fill must be a boolean.`);
    const strokeWidthMm = finite(source.strokeWidthMm, `${label}.strokeWidthMm`, 0, MAX_STROKE_WIDTH_MM);
    if (!source.fill && strokeWidthMm === 0) invalid(`${label} must be filled or have a positive stroke width.`);
    return Object.freeze({
      type: "circle",
      cxMm: finite(source.cxMm, `${label}.cxMm`, 0),
      cyMm: finite(source.cyMm, `${label}.cyMm`, 0),
      radiusMm: finite(source.radiusMm, `${label}.radiusMm`, Number.MIN_VALUE),
      fill: source.fill,
      strokeWidthMm,
    });
  }
  return invalid(`${label} has an unsupported primitive type.`);
}

function parseCustom(source: DataObject, base: { type: "custom"; orientation: RegistrationOrientation }): CustomRegistrationConfig {
  exactKeys(source, ["type", "orientation", "marks", "reservedZones"], "custom");
  if (!Array.isArray(source.marks) || source.marks.length < 1 || source.marks.length > MAX_REGISTRATION_CUSTOM_MARKS) {
    invalid(`custom marks must contain between 1 and ${MAX_REGISTRATION_CUSTOM_MARKS} marks.`);
  }
  let primitiveCount = 0;
  const marks = source.marks.map((markValue, markIndex) => {
    if (!Array.isArray(markValue) || markValue.length < 1 || markValue.length > MAX_REGISTRATION_CUSTOM_PRIMITIVES_PER_MARK) {
      invalid(`custom mark ${markIndex + 1} must contain between 1 and ${MAX_REGISTRATION_CUSTOM_PRIMITIVES_PER_MARK} primitives.`);
    }
    primitiveCount += markValue.length;
    if (primitiveCount > MAX_REGISTRATION_CUSTOM_PRIMITIVES) {
      invalid(`custom geometry may contain at most ${MAX_REGISTRATION_CUSTOM_PRIMITIVES} primitives.`);
    }
    return Object.freeze(markValue.map((primitive, primitiveIndex) =>
      parsePrimitive(primitive, `custom mark ${markIndex + 1} primitive ${primitiveIndex + 1}`)));
  });
  if (source.reservedZones !== undefined && !Array.isArray(source.reservedZones)) {
    invalid("custom reservedZones must be an array.");
  }
  const zoneValues = (source.reservedZones ?? []) as unknown[];
  if (zoneValues.length > MAX_REGISTRATION_CUSTOM_ZONES) {
    invalid(`custom reservedZones may contain at most ${MAX_REGISTRATION_CUSTOM_ZONES} rectangles.`);
  }
  const reservedZones = zoneValues.map((zone, index) => parseRect(zone, `custom reserved zone ${index + 1}`));
  return Object.freeze({ ...base, marks: Object.freeze(marks), reservedZones: Object.freeze(reservedZones) });
}

export function createDefaultRegistrationConfig(
  type: Exclude<RegistrationType, "custom">,
  orientationValue: RegistrationOrientation = "portrait",
  overrides: BuiltinRegistrationOverrides = {},
): RegistrationConfig {
  const selectedOrientation = orientation(orientationValue);
  if (type === "none") return Object.freeze({ type, orientation: selectedOrientation });
  if (type !== "three-point" && type !== "four-point") invalid("type is unsupported.");
  return parseRegistrationConfig({
    type,
    orientation: selectedOrientation,
    insetXMm: overrides.insetXMm ?? DEFAULT_INSET_X_MM,
    insetYMm: overrides.insetYMm ?? DEFAULT_INSET_Y_MM,
    armLengthMm: overrides.armLengthMm ?? DEFAULT_ARM_LENGTH_MM,
    lineThicknessMm: overrides.lineThicknessMm ?? DEFAULT_LINE_THICKNESS_MM,
    squareSizeMm: overrides.squareSizeMm ?? DEFAULT_SQUARE_SIZE_MM,
    reservedZoneClearanceMm: overrides.reservedZoneClearanceMm ?? 0,
  });
}

export function parseRegistrationConfig(value: unknown): RegistrationConfig {
  assertBoundedData(value);
  const source = record(value, "value");
  const selectedType = source.type;
  const selectedOrientation = orientation(source.orientation);
  let result: RegistrationConfig;
  if (selectedType === "none") {
    exactKeys(source, ["type", "orientation"], "none");
    result = Object.freeze({ type: "none", orientation: selectedOrientation });
  } else if (selectedType === "custom") {
    result = parseCustom(source, { type: "custom", orientation: selectedOrientation });
  } else if (selectedType === "three-point" || selectedType === "four-point") {
    exactKeys(source, [
      "type", "orientation", "insetXMm", "insetYMm", "armLengthMm", "lineThicknessMm", "squareSizeMm", "reservedZoneClearanceMm",
    ], selectedType);
    const config: BuiltinRegistrationConfig = {
      type: selectedType,
      orientation: selectedOrientation,
      insetXMm: configuredNumber(source, "insetXMm", DEFAULT_INSET_X_MM, 0),
      insetYMm: configuredNumber(source, "insetYMm", DEFAULT_INSET_Y_MM, 0),
      armLengthMm: configuredNumber(source, "armLengthMm", DEFAULT_ARM_LENGTH_MM, Number.MIN_VALUE),
      lineThicknessMm: configuredNumber(source, "lineThicknessMm", DEFAULT_LINE_THICKNESS_MM, Number.MIN_VALUE, MAX_STROKE_WIDTH_MM),
      squareSizeMm: configuredNumber(source, "squareSizeMm", DEFAULT_SQUARE_SIZE_MM, Number.MIN_VALUE),
      reservedZoneClearanceMm: configuredNumber(source, "reservedZoneClearanceMm", 0, 0),
    };
    result = Object.freeze(config);
  } else {
    invalid("type must be none, three-point, four-point, or custom.");
  }

  let json: string;
  try { json = JSON.stringify(result); }
  catch { return invalid("must contain only finite, serializable data."); }
  if (new TextEncoder().encode(json).byteLength > MAX_REGISTRATION_CONFIG_JSON_BYTES) {
    invalid(`must not exceed ${MAX_REGISTRATION_CONFIG_JSON_BYTES} serialized bytes.`);
  }
  return result;
}
