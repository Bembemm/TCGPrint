import type { SafeXmlDocument } from "../../import-engine/importers/xml";
import { parseSafeXml } from "../../import-engine/importers/xml";
import type { CutArcSegmentMm, CutGeometryMm, CutPathMm, CutPointMm, CutSegmentMm, CutSourceIdentity } from "../../core/cut";
import { createCutGeometryMm } from "../../core/cut";
import { sourceFailure, CutSourceError } from "./errors";

const MAX_SVG_BYTES = 8 * 1024 * 1024;
const MAX_SVG_ELEMENTS = 50_000;
const MAX_SVG_DEPTH = 32;
const MAX_SVG_PATHS = 2_048;
const MAX_SVG_SEGMENTS = 20_000;
const MAX_PATH_DATA_CHARS = 64 * 1024;
const MAX_TRANSFORMS = 256;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PX_TO_MM = 25.4 / 96;
const EPSILON = 1e-12;

type Matrix = readonly [number, number, number, number, number, number];
type SvgElement = NonNullable<SafeXmlDocument["documentElement"]>;

export interface SvgCutParseOptions {
  readonly source: CutSourceIdentity;
  /** Explicit Project/template page dimensions are required to verify the SVG viewport. */
  readonly expectedPageSizeMm: { readonly widthMm: number; readonly heightMm: number };
}

export interface SvgCutLimits {
  readonly maxBytes: number;
  readonly maxElements: number;
  readonly maxDepth: number;
  readonly maxPaths: number;
  readonly maxSegments: number;
  readonly maxPathDataChars: number;
}

export const DEFAULT_SVG_CUT_LIMITS: SvgCutLimits = Object.freeze({
  maxBytes: MAX_SVG_BYTES,
  maxElements: MAX_SVG_ELEMENTS,
  maxDepth: MAX_SVG_DEPTH,
  maxPaths: MAX_SVG_PATHS,
  maxSegments: MAX_SVG_SEGMENTS,
  maxPathDataChars: MAX_PATH_DATA_CHARS,
});

function malformed(message: string, cause?: unknown): never {
  return sourceFailure("CUT_SOURCE_MALFORMED", `SVG cut source ${message}`, cause);
}

function unsupported(message: string): never {
  return sourceFailure("CUT_SOURCE_UNSUPPORTED", `SVG cut source uses an unsupported feature: ${message}`);
}

function limit(message: string): never {
  return sourceFailure("CUT_SOURCE_COMPLEXITY_LIMIT", `SVG cut source exceeds a safety limit: ${message}`);
}

function finite(value: number, field: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) malformed(`${field} must be a finite bounded number.`);
  return value;
}

function multiply(first: Matrix, second: Matrix): Matrix {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}

function transformPoint(matrix: Matrix, value: { readonly x: number; readonly y: number }): CutPointMm {
  return {
    xMm: finite(matrix[0] * value.x + matrix[2] * value.y + matrix[4], "transformed x coordinate"),
    yMm: finite(matrix[1] * value.x + matrix[3] * value.y + matrix[5], "transformed y coordinate"),
  };
}

function transformVector(matrix: Matrix, value: { readonly x: number; readonly y: number }): CutPointMm {
  return {
    xMm: finite(matrix[0] * value.x + matrix[2] * value.y, "transformed x vector"),
    yMm: finite(matrix[1] * value.x + matrix[3] * value.y, "transformed y vector"),
  };
}

function readNumber(value: string | null, field: string, defaultValue?: number): number {
  if (value === null) {
    if (defaultValue !== undefined) return defaultValue;
    malformed(`is missing ${field}.`);
  }
  if (!/^[\t\n\r ]*[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?[\t\n\r ]*$/.test(value)) malformed(`${field} must be a number in SVG user units.`);
  return finite(Number(value), field);
}

function lengthMm(value: string | null, field: string): number {
  if (value === null || value.length > 64) malformed(`root ${field} must declare a physical viewport size.`);
  const match = /^\s*([+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?)\s*(mm|cm|in|pt|pc|px)?\s*$/i.exec(value);
  if (!match) unsupported(`root ${field} unit or percentage`);
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) malformed(`root ${field} must be a positive bounded length.`);
  const unit = (match[2] ?? "px").toLowerCase();
  const factor = unit === "mm" ? 1
    : unit === "cm" ? 10
      : unit === "in" ? 25.4
        : unit === "pt" ? 25.4 / 72
          : unit === "pc" ? 25.4 / 6
            : PX_TO_MM;
  return amount * factor;
}

function readViewBox(value: string | null): { x: number; y: number; width: number; height: number } | undefined {
  if (value === null) return undefined;
  const pieces = value.trim().split(/[\s,]+/);
  if (pieces.length !== 4 || pieces.some((piece) => !/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(piece))) malformed("viewBox must contain exactly four finite numbers.");
  const [x, y, width, height] = pieces.map(Number);
  if (![x, y, width, height].every(Number.isFinite) || Math.max(Math.abs(x!), Math.abs(y!), Math.abs(width!), Math.abs(height!)) > 1_000_000 || width! <= 0 || height! <= 0) {
    malformed("viewBox has invalid or unbounded dimensions.");
  }
  return { x: x!, y: y!, width: width!, height: height! };
}

function viewportMatrix(
  viewBox: { x: number; y: number; width: number; height: number } | undefined,
  viewportWidthMm: number,
  viewportHeightMm: number,
  preserveAspectRatio: string | null,
): Matrix {
  if (!viewBox) return [PX_TO_MM, 0, 0, PX_TO_MM, 0, 0];
  const spec = (preserveAspectRatio ?? "xMidYMid meet").trim().split(/\s+/).filter(Boolean);
  if (spec[0] === "defer" || spec.length > 2) unsupported("preserveAspectRatio syntax");
  if (spec[0] === "none") {
    if (spec.length > 1) unsupported("preserveAspectRatio none with an extra mode");
    const sx = viewportWidthMm / viewBox.width;
    const sy = viewportHeightMm / viewBox.height;
    return [sx, 0, 0, sy, -viewBox.x * sx, -viewBox.y * sy];
  }
  const align = spec[0] ?? "xMidYMid";
  if (!/^x(?:Min|Mid|Max)Y(?:Min|Mid|Max)$/.test(align)) unsupported(`preserveAspectRatio alignment ${align}`);
  const mode = spec[1] ?? "meet";
  if (mode !== "meet" && mode !== "slice") unsupported(`preserveAspectRatio mode ${mode}`);
  const scale = mode === "meet"
    ? Math.min(viewportWidthMm / viewBox.width, viewportHeightMm / viewBox.height)
    : Math.max(viewportWidthMm / viewBox.width, viewportHeightMm / viewBox.height);
  const extraX = viewportWidthMm - viewBox.width * scale;
  const extraY = viewportHeightMm - viewBox.height * scale;
  const alignX = align.includes("xMin") ? 0 : align.includes("xMax") ? 1 : 0.5;
  const alignY = align.includes("YMin") ? 0 : align.includes("YMax") ? 1 : 0.5;
  return [scale, 0, 0, scale, extraX * alignX - viewBox.x * scale, extraY * alignY - viewBox.y * scale];
}

function transformList(value: string | null, stats: { transforms: number }): Matrix {
  if (!value) return [1, 0, 0, 1, 0, 0];
  const pattern = /([A-Za-z]+)\s*\(([^)]*)\)/gy;
  let position = 0;
  let result: Matrix = [1, 0, 0, 1, 0, 0];
  while (position < value.length) {
    while (/[\s,]/.test(value[position] ?? "")) position += 1;
    if (position >= value.length) break;
    pattern.lastIndex = position;
    const match = pattern.exec(value);
    if (!match || match.index !== position) malformed("transform list is malformed.");
    position = pattern.lastIndex;
    stats.transforms += 1;
    if (stats.transforms > MAX_TRANSFORMS) limit(`more than ${MAX_TRANSFORMS} transforms`);
    const args = match[2]!.trim() === "" ? [] : match[2]!.trim().split(/[\s,]+/).map((item) => {
      if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(item)) malformed("transform contains an invalid number.");
      return finite(Number(item), "transform value");
    });
    const name = match[1]!.toLowerCase();
    let next: Matrix;
    if (name === "matrix" && args.length === 6) next = args as unknown as Matrix;
    else if (name === "translate" && (args.length === 1 || args.length === 2)) next = [1, 0, 0, 1, args[0]!, args[1] ?? 0];
    else if (name === "scale" && (args.length === 1 || args.length === 2)) next = [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
    else if (name === "rotate" && (args.length === 1 || args.length === 3)) {
      const angle = args[0]! * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotation: Matrix = [cos, sin, -sin, cos, 0, 0];
      if (args.length === 1) next = rotation;
      else {
        const toOrigin: Matrix = [1, 0, 0, 1, -args[1]!, -args[2]!];
        const fromOrigin: Matrix = [1, 0, 0, 1, args[1]!, args[2]!];
        next = multiply(fromOrigin, multiply(rotation, toOrigin));
      }
    } else unsupported(`transform ${match[1]} with ${args.length} parameters`);
    if (!next.every(Number.isFinite)) malformed("transform composition overflowed.");
    result = multiply(result, next);
    if (!result.every(Number.isFinite) || result.some((number) => Math.abs(number) > 1_000_000)) malformed("transform composition is unbounded.");
  }
  return result;
}

function allElements(document: SafeXmlDocument, limits: SvgCutLimits): { root: SvgElement; count: number } {
  const root = document.documentElement;
  if (!root || (root.localName ?? root.nodeName) !== "svg") malformed("root element must be <svg>.");
  let count = 0;
  const stack: Array<{ element: SvgElement; depth: number }> = [{ element: root, depth: 1 }];
  while (stack.length) {
    const current = stack.pop()!;
    count += 1;
    if (count > limits.maxElements) limit(`more than ${limits.maxElements} elements`);
    if (current.depth > limits.maxDepth) limit(`nesting deeper than ${limits.maxDepth}`);
    for (let index = current.element.childNodes.length - 1; index >= 0; index -= 1) {
      const child = current.element.childNodes.item(index);
      if (child?.nodeType === 1) stack.push({ element: child as unknown as SvgElement, depth: current.depth + 1 });
    }
  }
  return { root, count };
}

function validateElementAttributes(element: SvgElement, allowed: readonly string[], isRoot: boolean): void {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (!attribute) continue;
    const name = attribute.name;
    if (isRoot && (name === "xmlns" || name.startsWith("xmlns:"))) continue;
    if (/^on/i.test(name)) unsupported(`event handler ${name}`);
    if (!allowed.includes(name)) unsupported(`attribute ${name}`);
  }
  const namespace = element.namespaceURI;
  if (namespace && namespace !== SVG_NAMESPACE) unsupported(`XML namespace ${namespace}`);
}

function children(element: SvgElement): SvgElement[] {
  const result: SvgElement[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (!child) continue;
    if (child.nodeType === 1) result.push(child as unknown as SvgElement);
    else if ((child.nodeType === 3 || child.nodeType === 4) && child.nodeValue?.trim()) malformed("contains non-whitespace text in a geometry-only document.");
    else if (child.nodeType !== 3 && child.nodeType !== 4 && child.nodeType !== 8) unsupported(`XML node type ${child.nodeType}`);
  }
  return result;
}

function transformSegment(segment: CutSegmentMm, matrix: Matrix): CutSegmentMm {
  const mapped = (point: CutPointMm): CutPointMm => transformPoint(matrix, { x: point.xMm, y: point.yMm });
  if (segment.type === "line") return { type: "line", from: mapped(segment.from), to: mapped(segment.to) };
  if (segment.type === "quadratic") return { type: "quadratic", from: mapped(segment.from), control: mapped(segment.control), to: mapped(segment.to) };
  if (segment.type === "cubic") return { type: "cubic", from: mapped(segment.from), control1: mapped(segment.control1), control2: mapped(segment.control2), to: mapped(segment.to) };
  const center = mapped(segment.center);
  const axisU = transformVector(matrix, { x: segment.axisU.xMm, y: segment.axisU.yMm });
  const axisV = transformVector(matrix, { x: segment.axisV.xMm, y: segment.axisV.yMm });
  return { type: "arc", from: mapped(segment.from), to: mapped(segment.to), center, axisU, axisV, startAngleRad: segment.startAngleRad, sweepAngleRad: segment.sweepAngleRad };
}

function parsePathTokens(data: string, maxPathDataChars = MAX_PATH_DATA_CHARS): Array<string | number> {
  if (data.length > maxPathDataChars) limit(`path data longer than ${maxPathDataChars} characters`);
  const result: Array<string | number> = [];
  const tokenPattern = /[A-Za-z]|[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/gy;
  let position = 0;
  while (position < data.length) {
    tokenPattern.lastIndex = position;
    const match = tokenPattern.exec(data);
    if (!match || match.index !== position) {
      if (/^[\s,]*$/.test(data.slice(position))) break;
      malformed("path d contains a malformed token or unsupported syntax.");
    }
    const token = match[0]!;
    result.push(/^[A-Za-z]$/.test(token) ? token : finite(Number(token), "path coordinate"));
    position = tokenPattern.lastIndex;
    if (result.length > 100_000) limit("more than 100000 path commands/parameters");
    const separatorStart = position;
    while (/[\s,]/.test(data[position] ?? "")) position += 1;
    if (position < data.length && separatorStart === position && !/[A-Za-z+-\.\d]/.test(data[position]!)) malformed("path d has an invalid separator.");
  }
  return result;
}

function arcFromSvg(
  start: { x: number; y: number },
  rxInput: number,
  ryInput: number,
  rotationDegrees: number,
  largeArcFlag: number,
  sweepFlag: number,
  end: { x: number; y: number },
): CutArcSegmentMm | CutSegmentMm {
  let rx = Math.abs(rxInput);
  let ry = Math.abs(ryInput);
  if (largeArcFlag !== 0 && largeArcFlag !== 1 || sweepFlag !== 0 && sweepFlag !== 1) malformed("arc flags must be exactly 0 or 1.");
  if (sameUserPoint(start, end)) return { type: "line", from: { xMm: start.x, yMm: start.y }, to: { xMm: end.x, yMm: end.y } };
  if (rx <= EPSILON || ry <= EPSILON) return { type: "line", from: { xMm: start.x, yMm: start.y }, to: { xMm: end.x, yMm: end.y } };
  const phi = rotationDegrees * Math.PI / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const xPrime = cosPhi * dx + sinPhi * dy;
  const yPrime = -sinPhi * dx + cosPhi * dy;
  const radiiScale = xPrime * xPrime / (rx * rx) + yPrime * yPrime / (ry * ry);
  if (radiiScale > 1) {
    const factor = Math.sqrt(radiiScale);
    rx *= factor;
    ry *= factor;
  }
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * yPrime * yPrime - ry * ry * xPrime * xPrime);
  const denominator = rx * rx * yPrime * yPrime + ry * ry * xPrime * xPrime;
  const sign = largeArcFlag === sweepFlag ? -1 : 1;
  const coefficient = denominator <= EPSILON ? 0 : sign * Math.sqrt(numerator / denominator);
  const cxPrime = coefficient * rx * yPrime / ry;
  const cyPrime = coefficient * -ry * xPrime / rx;
  const cx = cosPhi * cxPrime - sinPhi * cyPrime + (start.x + end.x) / 2;
  const cy = sinPhi * cxPrime + cosPhi * cyPrime + (start.y + end.y) / 2;
  const ux = (xPrime - cxPrime) / rx;
  const uy = (yPrime - cyPrime) / ry;
  const vx = (-xPrime - cxPrime) / rx;
  const vy = (-yPrime - cyPrime) / ry;
  const startAngleRad = Math.atan2(uy, ux);
  let sweepAngleRad = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (sweepFlag === 0 && sweepAngleRad > 0) sweepAngleRad -= Math.PI * 2;
  if (sweepFlag === 1 && sweepAngleRad < 0) sweepAngleRad += Math.PI * 2;
  return {
    type: "arc",
    from: { xMm: start.x, yMm: start.y },
    to: { xMm: end.x, yMm: end.y },
    center: { xMm: cx, yMm: cy },
    axisU: { xMm: rx * cosPhi, yMm: rx * sinPhi },
    axisV: { xMm: -ry * sinPhi, yMm: ry * cosPhi },
    startAngleRad,
    sweepAngleRad,
  };
}

function sameUserPoint(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return Math.abs(left.x - right.x) <= EPSILON && Math.abs(left.y - right.y) <= EPSILON;
}

function parsePathData(idPrefix: string, data: string, matrix: Matrix, stats: { paths: number; segments: number; maxPaths: number; maxSegments: number; maxPathDataChars: number }): Array<Omit<CutPathMm, "boundsMm">> {
  const tokens = parsePathTokens(data, stats.maxPathDataChars);
  const paths: Array<Omit<CutPathMm, "boundsMm">> = [];
  let cursor = 0;
  let command = "";
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  let pathStart: CutPointMm | undefined;
  let segments: CutSegmentMm[] = [];
  let closed = false;
  let previousControl: { x: number; y: number } | undefined;
  let previousCommand = "";
  let subpathCount = 0;

  const mappedPoint = (point: { x: number; y: number }) => transformPoint(matrix, point);
  const rawPoint = (point: { x: number; y: number }): CutPointMm => ({ xMm: point.x, yMm: point.y });
  const append = (segment: CutSegmentMm) => {
    segments.push(transformSegment(segment, matrix));
    stats.segments += 1;
    if (stats.segments > stats.maxSegments) limit(`more than ${stats.maxSegments} path segments`);
    if (segments.length > 100_000) limit("one path contains too many segments");
  };
  const flush = () => {
    if (!pathStart) return;
    if (segments.length === 0) malformed("path contains a move without a cut segment.");
    stats.paths += 1;
    if (stats.paths > stats.maxPaths) limit(`more than ${stats.maxPaths} paths`);
    paths.push({ id: `${idPrefix}${subpathCount ? `-${subpathCount}` : ""}`, start: pathStart, closed, segments: Object.freeze(segments) });
    subpathCount += 1;
    pathStart = undefined;
    segments = [];
    closed = false;
  };
  const hasNumber = () => typeof tokens[cursor] === "number";
  const take = (field: string): number => {
    if (!hasNumber()) malformed(`path d is missing ${field}.`);
    return tokens[cursor++] as number;
  };
  const hasValuesFor = (count: number) => cursor + count <= tokens.length && tokens.slice(cursor, cursor + count).every((token) => typeof token === "number");
  const absolutePoint = (x: number, y: number, relative: boolean) => ({ x: relative ? current.x + x : x, y: relative ? current.y + y : y });

  while (cursor < tokens.length) {
    if (typeof tokens[cursor] === "string") command = tokens[cursor++] as string;
    else if (!command) malformed("path d must begin with a command.");
    const upper = command.toUpperCase();
    const relative = command !== upper;
    if (!"MLHVZCSQTA".includes(upper)) unsupported(`path command ${command}`);
    if (upper === "Z") {
      if (!pathStart || closed) malformed("path close command has no open subpath.");
      closed = true;
      current = { ...subpathStart };
      flush();
      previousCommand = upper;
      previousControl = undefined;
      command = "";
      if (cursor < tokens.length && (typeof tokens[cursor] !== "string" || (tokens[cursor] as string).toUpperCase() !== "M")) malformed("path commands after Z require a new M command.");
      continue;
    }
    const parameterCount = upper === "H" || upper === "V" ? 1
      : upper === "M" || upper === "L" || upper === "T" ? 2
        : upper === "S" || upper === "Q" ? 4
          : upper === "C" ? 6
            : upper === "A" ? 7 : 0;
    if (parameterCount === 0 || !hasValuesFor(parameterCount)) malformed(`path command ${command} has incomplete parameters.`);
    let consumedAny = false;
    let firstMovePair = upper === "M";
    while (hasValuesFor(parameterCount)) {
      consumedAny = true;
      if (upper === "M" || upper === "L" || upper === "T") {
        const x = take("x coordinate");
        const y = take("y coordinate");
        const next = absolutePoint(x, y, relative);
        if (upper === "M" && firstMovePair) {
          flush();
          current = next;
          subpathStart = next;
          pathStart = mappedPoint(next);
          firstMovePair = false;
          if (relative) command = "l";
          else command = "L";
          previousControl = undefined;
        } else if (upper === "M") {
          append({ type: "line", from: rawPoint(current), to: rawPoint(next) });
          current = next;
          previousControl = undefined;
        } else if (upper === "T") {
          const control = previousCommand === "Q" || previousCommand === "T"
            ? { x: 2 * current.x - (previousControl?.x ?? current.x), y: 2 * current.y - (previousControl?.y ?? current.y) }
            : { ...current };
          append({ type: "quadratic", from: rawPoint(current), control: rawPoint(control), to: rawPoint(next) });
          current = next;
          previousControl = control;
        } else {
          append({ type: "line", from: rawPoint(current), to: rawPoint(next) });
          current = next;
          previousControl = undefined;
        }
      } else if (upper === "H") {
        const x = take("x coordinate");
        const next = { x: relative ? current.x + x : x, y: current.y };
        append({ type: "line", from: rawPoint(current), to: rawPoint(next) });
        current = next;
        previousControl = undefined;
      } else if (upper === "V") {
        const y = take("y coordinate");
        const next = { x: current.x, y: relative ? current.y + y : y };
        append({ type: "line", from: rawPoint(current), to: rawPoint(next) });
        current = next;
        previousControl = undefined;
      } else if (upper === "C" || upper === "S") {
        let first: { x: number; y: number };
        if (upper === "S") {
          first = previousCommand === "C" || previousCommand === "S"
            ? { x: 2 * current.x - (previousControl?.x ?? current.x), y: 2 * current.y - (previousControl?.y ?? current.y) }
            : { ...current };
        } else first = absolutePoint(take("first control x"), take("first control y"), relative);
        const second = absolutePoint(take("second control x"), take("second control y"), relative);
        const next = absolutePoint(take("end x"), take("end y"), relative);
        append({ type: "cubic", from: rawPoint(current), control1: rawPoint(first), control2: rawPoint(second), to: rawPoint(next) });
        current = next;
        previousControl = second;
      } else if (upper === "Q") {
        const control = absolutePoint(take("control x"), take("control y"), relative);
        const next = absolutePoint(take("end x"), take("end y"), relative);
        append({ type: "quadratic", from: rawPoint(current), control: rawPoint(control), to: rawPoint(next) });
        current = next;
        previousControl = control;
      } else if (upper === "A") {
        const rx = take("arc x radius");
        const ry = take("arc y radius");
        const rotation = take("arc rotation");
        const largeArcFlag = take("large-arc flag");
        const sweepFlag = take("sweep flag");
        const next = absolutePoint(take("arc end x"), take("arc end y"), relative);
        const local = arcFromSvg(current, rx, ry, rotation, largeArcFlag, sweepFlag, next);
        append(local);
        current = next;
        previousControl = undefined;
      }
      previousCommand = upper;
      if (upper !== "M" && !hasValuesFor(parameterCount)) break;
    }
    if (!consumedAny) malformed(`path command ${command} has no parameters.`);
  }
  flush();
  return paths;
}

function transformCommandPoint(command: string, x: number, y: number, matrix: Matrix): CutPointMm {
  if (!command) return transformPoint(matrix, { x, y });
  return transformPoint(matrix, { x, y });
}

function arcSegment(
  center: { x: number; y: number },
  rx: number,
  ry: number,
  startAngleRad: number,
  sweepAngleRad: number,
  matrix: Matrix,
): CutArcSegmentMm {
  const raw: CutArcSegmentMm = {
    type: "arc",
    from: { xMm: center.x + rx * Math.cos(startAngleRad), yMm: center.y + ry * Math.sin(startAngleRad) },
    to: { xMm: center.x + rx * Math.cos(startAngleRad + sweepAngleRad), yMm: center.y + ry * Math.sin(startAngleRad + sweepAngleRad) },
    center: { xMm: center.x, yMm: center.y },
    axisU: { xMm: rx, yMm: 0 },
    axisV: { xMm: 0, yMm: ry },
    startAngleRad,
    sweepAngleRad,
  };
  return transformSegment(raw, matrix) as CutArcSegmentMm;
}

function shapePaths(element: SvgElement, tag: string, id: string, matrix: Matrix, stats: { paths: number; segments: number; maxPaths: number; maxSegments: number; maxPathDataChars: number }): Array<Omit<CutPathMm, "boundsMm">> {
  const numeric = (attribute: string, defaultValue?: number) => readNumber(element.getAttribute(attribute), `${tag}.${attribute}`, defaultValue);
  const line = (from: CutPointMm, to: CutPointMm): CutSegmentMm => ({ type: "line", from, to });
  const path = (start: CutPointMm, closed: boolean, segments: CutSegmentMm[]) => {
    if (segments.length === 0) malformed(`<${tag}> has no cut segments.`);
    stats.paths += 1;
    stats.segments += segments.length;
    if (stats.paths > stats.maxPaths || stats.segments > stats.maxSegments) limit("path or segment count");
    return [{ id, start, closed, segments: Object.freeze(segments) }];
  };
  const p = (x: number, y: number) => transformCommandPoint("", x, y, matrix);
  if (tag === "line") {
    const from = p(numeric("x1", 0), numeric("y1", 0));
    const to = p(numeric("x2", 0), numeric("y2", 0));
    return path(from, false, [line(from, to)]);
  }
  if (tag === "polyline" || tag === "polygon") {
    const text = element.getAttribute("points");
    if (text === null || text.length > 65_536) malformed(`<${tag}> points are missing or too long.`);
    const tokens = parsePathTokens(text, stats.maxPathDataChars);
    if (tokens.some((token) => typeof token === "string") || tokens.length % 2 !== 0 || tokens.length < (tag === "polygon" ? 6 : 4)) malformed(`<${tag}> points must contain complete coordinate pairs.`);
    const points: CutPointMm[] = [];
    for (let index = 0; index < tokens.length; index += 2) points.push(p(tokens[index] as number, tokens[index + 1] as number));
    const segments = points.slice(1).map((next, index) => line(points[index]!, next));
    if (tag === "polygon") segments.push(line(points[points.length - 1]!, points[0]!));
    return path(points[0]!, tag === "polygon", segments);
  }
  if (tag === "rect") {
    const x = numeric("x", 0);
    const y = numeric("y", 0);
    const width = numeric("width");
    const height = numeric("height");
    if (width <= 0 || height <= 0) malformed("rect dimensions must be positive.");
    let rx = numeric("rx", numeric("ry", 0));
    let ry = numeric("ry", rx);
    if (rx < 0 || ry < 0) malformed("rect corner radii cannot be negative.");
    rx = Math.min(rx, width / 2);
    ry = Math.min(ry, height / 2);
    if (rx === 0 || ry === 0) {
      const start = p(x, y);
      const corners = [p(x + width, y), p(x + width, y + height), p(x, y + height), start];
      const segments = corners.map((to, index) => line(index === 0 ? start : corners[index - 1]!, to));
      return path(start, true, segments);
    }
    const points = [
      { x: x + rx, y }, { x: x + width - rx, y },
      { x: x + width, y: y + ry }, { x: x + width, y: y + height - ry },
      { x: x + width - rx, y: y + height }, { x: x + rx, y: y + height },
      { x, y: y + height - ry }, { x, y: y + ry },
    ];
    const segments: CutSegmentMm[] = [];
    const start = p(points[0]!.x, points[0]!.y);
    let current = start;
    const lineTo = (index: number) => {
      const next = p(points[index]!.x, points[index]!.y);
      segments.push(line(current, next));
      current = next;
    };
    {
      lineTo(1);
      segments.push(arcSegment({ x: x + width - rx, y: y + ry }, rx, ry, -Math.PI / 2, Math.PI / 2, matrix)); current = segments[segments.length - 1]!.to;
      lineTo(3);
      segments.push(arcSegment({ x: x + width - rx, y: y + height - ry }, rx, ry, 0, Math.PI / 2, matrix)); current = segments[segments.length - 1]!.to;
      lineTo(5);
      segments.push(arcSegment({ x: x + rx, y: y + height - ry }, rx, ry, Math.PI / 2, Math.PI / 2, matrix)); current = segments[segments.length - 1]!.to;
      lineTo(7);
      segments.push(arcSegment({ x: x + rx, y: y + ry }, rx, ry, Math.PI, Math.PI / 2, matrix));
    }
    return path(start, true, segments);
  }
  if (tag === "circle" || tag === "ellipse") {
    const cx = numeric("cx", 0);
    const cy = numeric("cy", 0);
    const rx = tag === "circle" ? numeric("r") : numeric("rx");
    const ry = tag === "circle" ? rx : numeric("ry");
    if (rx <= 0 || ry <= 0) malformed(`<${tag}> radii must be positive.`);
    const segment = arcSegment({ x: cx, y: cy }, rx, ry, 0, Math.PI * 2, matrix);
    return path(segment.from, true, [segment]);
  }
  if (tag === "path") {
    const data = element.getAttribute("d");
    if (data === null) malformed("path is missing d.");
    const paths = parsePathData(id, data, matrix, stats);
    return paths;
  }
  unsupported(`element <${tag}>`);
}

function parseGeometryChildren(
  parent: SvgElement,
  parentMatrix: Matrix,
  depth: number,
  context: { elements: number; transforms: number; paths: number; segments: number; maxPaths: number; maxSegments: number; maxPathDataChars: number; ids: Set<string> },
): Array<Omit<CutPathMm, "boundsMm">> {
  if (depth > MAX_SVG_DEPTH) limit(`nesting deeper than ${MAX_SVG_DEPTH}`);
  const paths: Array<Omit<CutPathMm, "boundsMm">> = [];
  for (const element of children(parent)) {
    context.elements += 1;
    if (context.elements > MAX_SVG_ELEMENTS) limit(`more than ${MAX_SVG_ELEMENTS} elements`);
    const tag = element.localName ?? element.nodeName;
    if (tag === "g") {
      validateElementAttributes(element, ["id", "transform"], false);
      const local = transformList(element.getAttribute("transform"), context);
      paths.push(...parseGeometryChildren(element, multiply(parentMatrix, local), depth + 1, context));
      continue;
    }
    if (!["path", "line", "polyline", "polygon", "rect", "circle", "ellipse"].includes(tag)) unsupported(`element <${tag}>`);
    const allowedByTag: Record<string, readonly string[]> = {
      path: ["id", "transform", "d"],
      line: ["id", "transform", "x1", "y1", "x2", "y2"],
      polyline: ["id", "transform", "points"],
      polygon: ["id", "transform", "points"],
      rect: ["id", "transform", "x", "y", "width", "height", "rx", "ry"],
      circle: ["id", "transform", "cx", "cy", "r"],
      ellipse: ["id", "transform", "cx", "cy", "rx", "ry"],
    };
    validateElementAttributes(element, allowedByTag[tag]!, false);
    if (children(element).length !== 0) unsupported(`child content inside <${tag}>`);
    const local = transformList(element.getAttribute("transform"), context);
    const matrix = multiply(parentMatrix, local);
    const explicitId = element.getAttribute("id");
    if (explicitId !== null && (!explicitId || explicitId.length > 160 || /[\u0000-\u001f\s]/.test(explicitId))) malformed(`<${tag}> id is invalid.`);
    const pathId = explicitId ?? `svg-path-${String(context.paths + 1).padStart(4, "0")}`;
    const result = shapePaths(element, tag, pathId, matrix, context);
    for (const path of result) {
      if (context.ids.has(path.id)) malformed(`contains duplicate path ID ${path.id}.`);
      context.ids.add(path.id);
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Reads geometry-only SVGs. Physical dimensions use SVG/CSS absolute units,
 * including 1px = 25.4/96 mm; shape coordinates are numeric SVG user units.
 */
export function parseSvgCutGeometry(
  bytes: Uint8Array,
  options: SvgCutParseOptions,
  overrides: Partial<SvgCutLimits> = {},
): CutGeometryMm {
  const limits = { ...DEFAULT_SVG_CUT_LIMITS, ...overrides };
  if (bytes.byteLength > limits.maxBytes) sourceFailure("CUT_SOURCE_TOO_LARGE", `SVG cut source is ${bytes.byteLength} bytes; limit is ${limits.maxBytes}.`);
  let document: SafeXmlDocument;
  try {
    document = parseSafeXml(bytes, { maxXmlBytes: limits.maxBytes, maxXmlNodes: limits.maxElements, maxXmlDepth: limits.maxDepth });
  } catch (error) {
    if (error instanceof CutSourceError) throw error;
    const message = error instanceof Error ? error.message : "XML parse failed.";
    if (/limit/i.test(message)) sourceFailure("CUT_SOURCE_COMPLEXITY_LIMIT", `SVG XML parser limit: ${message}`, error);
    malformed(`is not well formed or contains blocked XML declarations: ${message}`, error);
  }
  const { root, count } = allElements(document, limits);
  const rootAllowed = ["xmlns", "version", "id", "width", "height", "viewBox", "preserveAspectRatio", "transform"];
  validateElementAttributes(root, rootAllowed, true);
  const widthMm = lengthMm(root.getAttribute("width"), "width");
  const heightMm = lengthMm(root.getAttribute("height"), "height");
  const expected = options.expectedPageSizeMm;
  if (![expected.widthMm, expected.heightMm].every((value) => Number.isFinite(value) && value > 0 && value <= 2_000)) malformed("expected Project page dimensions are invalid.");
  if (Math.abs(widthMm - expected.widthMm) > 0.000001 || Math.abs(heightMm - expected.heightMm) > 0.000001) {
    sourceFailure("CUT_SOURCE_DIMENSIONS_MISMATCH", `SVG physical page is ${widthMm} × ${heightMm} mm; selected layout is ${expected.widthMm} × ${expected.heightMm} mm.`);
  }
  const viewBox = readViewBox(root.getAttribute("viewBox"));
  const viewport = viewportMatrix(viewBox, widthMm, heightMm, root.getAttribute("preserveAspectRatio"));
  const context = { elements: count - 1, transforms: 0, paths: 0, segments: 0, maxPaths: limits.maxPaths, maxSegments: limits.maxSegments, maxPathDataChars: limits.maxPathDataChars, ids: new Set<string>() };
  const rootTransform = transformList(root.getAttribute("transform"), context);
  // A transform on the outer <svg> acts outside its viewBox viewport. Its
  // translation values are in the parent CSS user units (96 dpi px).
  const rootTransformMm: Matrix = [rootTransform[0], rootTransform[1], rootTransform[2], rootTransform[3], rootTransform[4] * PX_TO_MM, rootTransform[5] * PX_TO_MM];
  const matrix = multiply(rootTransformMm, viewport);
  const paths = parseGeometryChildren(root, matrix, 1, context);
  if (paths.length === 0) malformed("contains no supported cut paths.");
  return createCutGeometryMm({ source: options.source, pageSizeMm: expected, paths });
}
