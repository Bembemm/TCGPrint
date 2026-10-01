import type {
  CutArcSegmentMm,
  CutBoundsMm,
  CutGeometryComparison,
  CutGeometryInput,
  CutGeometrySource,
  CutGeometryMm,
  CutPathMm,
  CutPointMm,
  CutSegmentMm,
} from "./types";

export const CUT_GEOMETRY_TOLERANCE_MM = 0.000001;
export const MAX_CUT_PAGE_DIMENSION_MM = 2_000;
export const MAX_CUT_PATHS = 2_048;
export const MAX_CUT_SEGMENTS = 20_000;
const CONNECT_EPSILON_MM = 1e-8;
const BOUNDS_EPSILON_MM = 1e-7;

function fail(message: string): never {
  throw new RangeError(`Cut geometry ${message}`);
}

function finite(value: unknown, field: string, maximum = 100_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maximum) {
    fail(`${field} must be finite and within ±${maximum} mm.`);
  }
  return value;
}

function point(value: unknown, field: string): CutPointMm {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be a point.`);
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 2 || !Object.hasOwn(source, "xMm") || !Object.hasOwn(source, "yMm")) {
    fail(`${field} must contain only xMm and yMm.`);
  }
  return Object.freeze({ xMm: finite(source.xMm, `${field}.xMm`), yMm: finite(source.yMm, `${field}.yMm`) });
}

function samePoint(first: CutPointMm, second: CutPointMm, tolerance = CONNECT_EPSILON_MM): boolean {
  return Math.abs(first.xMm - second.xMm) <= tolerance && Math.abs(first.yMm - second.yMm) <= tolerance;
}

function arcPoint(segment: CutArcSegmentMm, angle: number): CutPointMm {
  return {
    xMm: segment.center.xMm + segment.axisU.xMm * Math.cos(angle) + segment.axisV.xMm * Math.sin(angle),
    yMm: segment.center.yMm + segment.axisU.yMm * Math.cos(angle) + segment.axisV.yMm * Math.sin(angle),
  };
}

function segmentPoints(segment: CutSegmentMm): readonly CutPointMm[] {
  switch (segment.type) {
    case "line": return [segment.from, segment.to];
    case "cubic": return [segment.from, segment.control1, segment.control2, segment.to];
    case "quadratic": return [segment.from, segment.control, segment.to];
    case "arc": return [segment.from, segment.to, segment.center, segment.axisU, segment.axisV];
  }
}

function normalizeSegment(value: unknown, index: number): CutSegmentMm {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`segment ${index + 1} must be an object.`);
  const source = value as Record<string, unknown>;
  const type = source.type;
  if (type === "line") {
    if (Object.keys(source).length !== 3) fail(`line segment ${index + 1} contains unsupported fields.`);
    return Object.freeze({ type, from: point(source.from, `segment ${index + 1}.from`), to: point(source.to, `segment ${index + 1}.to`) });
  }
  if (type === "cubic") {
    if (Object.keys(source).length !== 5) fail(`cubic segment ${index + 1} contains unsupported fields.`);
    return Object.freeze({
      type,
      from: point(source.from, `segment ${index + 1}.from`),
      control1: point(source.control1, `segment ${index + 1}.control1`),
      control2: point(source.control2, `segment ${index + 1}.control2`),
      to: point(source.to, `segment ${index + 1}.to`),
    });
  }
  if (type === "quadratic") {
    if (Object.keys(source).length !== 4) fail(`quadratic segment ${index + 1} contains unsupported fields.`);
    return Object.freeze({
      type,
      from: point(source.from, `segment ${index + 1}.from`),
      control: point(source.control, `segment ${index + 1}.control`),
      to: point(source.to, `segment ${index + 1}.to`),
    });
  }
  if (type === "arc") {
    if (Object.keys(source).length !== 8) fail(`arc segment ${index + 1} contains unsupported fields.`);
    const normalized = {
      type,
      from: point(source.from, `segment ${index + 1}.from`),
      to: point(source.to, `segment ${index + 1}.to`),
      center: point(source.center, `segment ${index + 1}.center`),
      axisU: point(source.axisU, `segment ${index + 1}.axisU`),
      axisV: point(source.axisV, `segment ${index + 1}.axisV`),
      startAngleRad: finite(source.startAngleRad, `segment ${index + 1}.startAngleRad`, Math.PI * 1_000),
      sweepAngleRad: finite(source.sweepAngleRad, `segment ${index + 1}.sweepAngleRad`, Math.PI * 2 + 1e-8),
    } as const;
    if (Math.abs(normalized.sweepAngleRad) <= Number.EPSILON) fail(`arc segment ${index + 1} must have a non-zero sweep.`);
    const start = arcPoint(normalized, normalized.startAngleRad);
    const end = arcPoint(normalized, normalized.startAngleRad + normalized.sweepAngleRad);
    if (!samePoint(start, normalized.from, BOUNDS_EPSILON_MM) || !samePoint(end, normalized.to, BOUNDS_EPSILON_MM)) {
      fail(`arc segment ${index + 1} endpoints do not match its ellipse parameters.`);
    }
    return Object.freeze(normalized);
  }
  fail(`segment ${index + 1} has an unsupported type.`);
}

function addPoint(point: CutPointMm, bounds: { minX: number; minY: number; maxX: number; maxY: number }): void {
  bounds.minX = Math.min(bounds.minX, point.xMm);
  bounds.minY = Math.min(bounds.minY, point.yMm);
  bounds.maxX = Math.max(bounds.maxX, point.xMm);
  bounds.maxY = Math.max(bounds.maxY, point.yMm);
}

function evaluateQuadratic(p0: number, p1: number, p2: number, t: number): number {
  const oneMinus = 1 - t;
  return oneMinus * oneMinus * p0 + 2 * oneMinus * t * p1 + t * t * p2;
}

function evaluateCubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const oneMinus = 1 - t;
  return oneMinus ** 3 * p0 + 3 * oneMinus ** 2 * t * p1 + 3 * oneMinus * t ** 2 * p2 + t ** 3 * p3;
}

function quadraticExtremum(p0: number, p1: number, p2: number): number[] {
  const denominator = p0 - 2 * p1 + p2;
  if (Math.abs(denominator) < 1e-14) return [];
  const t = (p0 - p1) / denominator;
  return t > 0 && t < 1 ? [t] : [];
}

function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  if (Math.abs(a) < 1e-14) {
    if (Math.abs(b) < 1e-14) return [];
    const t = -c / b;
    return t > 0 && t < 1 ? [t] : [];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)].filter((t) => t > 0 && t < 1);
}

function angleInSweep(angle: number, start: number, sweep: number): boolean {
  const fullTurn = Math.PI * 2;
  if (Math.abs(sweep) >= fullTurn - 1e-12) return true;
  const normalized = ((angle % fullTurn) + fullTurn) % fullTurn;
  const normalizedStart = ((start % fullTurn) + fullTurn) % fullTurn;
  const delta = sweep >= 0
    ? (normalized - normalizedStart + fullTurn) % fullTurn
    : (normalizedStart - normalized + fullTurn) % fullTurn;
  return delta <= Math.abs(sweep) + 1e-12;
}

function includeArcExtrema(segment: CutArcSegmentMm, bounds: { minX: number; minY: number; maxX: number; maxY: number }): void {
  addPoint(segment.from, bounds);
  addPoint(segment.to, bounds);
  const candidates = [
    Math.atan2(segment.axisV.xMm, segment.axisU.xMm),
    Math.atan2(segment.axisV.xMm, segment.axisU.xMm) + Math.PI,
    Math.atan2(segment.axisV.yMm, segment.axisU.yMm),
    Math.atan2(segment.axisV.yMm, segment.axisU.yMm) + Math.PI,
  ];
  for (const angle of candidates) {
    if (angleInSweep(angle, segment.startAngleRad, segment.sweepAngleRad)) addPoint(arcPoint(segment, angle), bounds);
  }
}

export function computeCutPathBoundsMm(path: Pick<CutPathMm, "start" | "segments">): CutBoundsMm {
  const bounds = { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY };
  addPoint(path.start, bounds);
  for (const segment of path.segments) {
    if (segment.type === "line") {
      addPoint(segment.from, bounds);
      addPoint(segment.to, bounds);
    } else if (segment.type === "quadratic") {
      addPoint(segment.from, bounds);
      addPoint(segment.to, bounds);
      for (const t of quadraticExtremum(segment.from.xMm, segment.control.xMm, segment.to.xMm)) {
        addPoint({ xMm: evaluateQuadratic(segment.from.xMm, segment.control.xMm, segment.to.xMm, t), yMm: evaluateQuadratic(segment.from.yMm, segment.control.yMm, segment.to.yMm, t) }, bounds);
      }
      for (const t of quadraticExtremum(segment.from.yMm, segment.control.yMm, segment.to.yMm)) {
        addPoint({ xMm: evaluateQuadratic(segment.from.xMm, segment.control.xMm, segment.to.xMm, t), yMm: evaluateQuadratic(segment.from.yMm, segment.control.yMm, segment.to.yMm, t) }, bounds);
      }
    } else if (segment.type === "cubic") {
      addPoint(segment.from, bounds);
      addPoint(segment.to, bounds);
      const extrema = new Set([
        ...cubicExtrema(segment.from.xMm, segment.control1.xMm, segment.control2.xMm, segment.to.xMm),
        ...cubicExtrema(segment.from.yMm, segment.control1.yMm, segment.control2.yMm, segment.to.yMm),
      ]);
      for (const t of extrema) {
        addPoint({
          xMm: evaluateCubic(segment.from.xMm, segment.control1.xMm, segment.control2.xMm, segment.to.xMm, t),
          yMm: evaluateCubic(segment.from.yMm, segment.control1.yMm, segment.control2.yMm, segment.to.yMm, t),
        }, bounds);
      }
    } else includeArcExtrema(segment, bounds);
  }
  if (!Number.isFinite(bounds.minX)) fail("path must contain a finite starting point.");
  return Object.freeze({
    xMm: bounds.minX,
    yMm: bounds.minY,
    widthMm: bounds.maxX - bounds.minX,
    heightMm: bounds.maxY - bounds.minY,
  });
}

function normalizeIdentity(value: unknown): CutGeometrySource {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("source identity must be an object.");
  const source = value as Record<string, unknown>;
  if (source.kind === "project-layout") {
    if (Object.keys(source).length !== 3 || typeof source.projectId !== "string" || !source.projectId
      || source.projectId.length > 180 || /[\u0000-\u001f]/.test(source.projectId)
      || !Number.isSafeInteger(source.projectRevision) || (source.projectRevision as number) < 1) {
      fail("manual source must identify one Project and positive revision.");
    }
    return Object.freeze({ kind: "project-layout", projectId: source.projectId, projectRevision: source.projectRevision as number });
  }
  if (source.kind !== "template-file") fail("source identity kind is unsupported.");
  const keys = ["templateId", "version", "packageHash", "fileId", "fileHash"];
  if (Object.keys(source).length !== keys.length + 1 || !Object.hasOwn(source, "kind") || keys.some((key) => !Object.hasOwn(source, key))) fail("source identity must contain its exact template, version, package, and file hashes.");
  for (const key of ["templateId", "version", "fileId"] as const) {
    const text = source[key];
    if (typeof text !== "string" || text.length < 1 || text.length > 180 || /[\u0000-\u001f]/.test(text)) fail(`source ${key} is invalid.`);
  }
  for (const key of ["packageHash", "fileHash"] as const) {
    if (typeof source[key] !== "string" || !/^[a-f0-9]{64}$/.test(source[key] as string)) fail(`source ${key} must be a SHA-256 hex digest.`);
  }
  return Object.freeze({
    kind: "template-file",
    templateId: source.templateId as string,
    version: source.version as string,
    packageHash: source.packageHash as string,
    fileId: source.fileId as string,
    fileHash: source.fileHash as string,
  });
}

function normalizePath(value: unknown, index: number): CutPathMm {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`path ${index + 1} must be an object.`);
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 4 || !["id", "start", "closed", "segments"].every((key) => Object.hasOwn(source, key))) {
    fail(`path ${index + 1} contains unsupported fields.`);
  }
  if (typeof source.id !== "string" || !source.id || source.id.length > 180 || /[\u0000-\u001f]/.test(source.id)) fail(`path ${index + 1} has an invalid stable ID.`);
  if (typeof source.closed !== "boolean") fail(`path ${index + 1}.closed must be boolean.`);
  if (!Array.isArray(source.segments) || source.segments.length < 1 || source.segments.length > MAX_CUT_SEGMENTS) fail(`path ${index + 1} must contain between 1 and ${MAX_CUT_SEGMENTS} segments.`);
  const start = point(source.start, `path ${index + 1}.start`);
  const segments = source.segments.map((segment, segmentIndex) => normalizeSegment(segment, segmentIndex));
  let previous = start;
  for (const segment of segments) {
    if (!samePoint(previous, segment.from)) fail(`path ${index + 1} has disconnected segments.`);
    previous = segment.to;
  }
  return Object.freeze({ id: source.id, start, closed: source.closed, segments: Object.freeze(segments), boundsMm: computeCutPathBoundsMm({ start, segments }) });
}

export function createCutGeometryMm(input: CutGeometryInput): CutGeometryMm {
  const page = input?.pageSizeMm;
  if (!page || !Number.isFinite(page.widthMm) || !Number.isFinite(page.heightMm)
    || page.widthMm <= 0 || page.heightMm <= 0
    || page.widthMm > MAX_CUT_PAGE_DIMENSION_MM || page.heightMm > MAX_CUT_PAGE_DIMENSION_MM) {
    fail(`page dimensions must be finite and from 0 to ${MAX_CUT_PAGE_DIMENSION_MM} mm.`);
  }
  if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > MAX_CUT_PATHS) fail(`must contain between 1 and ${MAX_CUT_PATHS} paths.`);
  const paths = input.paths.map((path, index) => normalizePath(path, index));
  const ids = new Set<string>();
  let totalSegments = 0;
  const pageBounds = { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY };
  for (const path of paths) {
    if (ids.has(path.id)) fail(`contains duplicate path ID ${path.id}.`);
    ids.add(path.id);
    totalSegments += path.segments.length;
    if (totalSegments > MAX_CUT_SEGMENTS) fail(`contains more than ${MAX_CUT_SEGMENTS} segments.`);
    const { xMm, yMm, widthMm, heightMm } = path.boundsMm;
    if (xMm < -BOUNDS_EPSILON_MM || yMm < -BOUNDS_EPSILON_MM
      || xMm + widthMm > page.widthMm + BOUNDS_EPSILON_MM
      || yMm + heightMm > page.heightMm + BOUNDS_EPSILON_MM) fail(`path ${path.id} is outside page bounds.`);
    addPoint({ xMm, yMm }, pageBounds);
    addPoint({ xMm: xMm + widthMm, yMm: yMm + heightMm }, pageBounds);
  }
  return Object.freeze({
    modelVersion: 1,
    units: "mm",
    coordinateFrame: "page-top-left-y-down",
    pageSizeMm: Object.freeze({ widthMm: page.widthMm, heightMm: page.heightMm }),
    source: normalizeIdentity(input.source),
    paths: Object.freeze(paths),
    boundsMm: Object.freeze({
      xMm: pageBounds.minX,
      yMm: pageBounds.minY,
      widthMm: pageBounds.maxX - pageBounds.minX,
      heightMm: pageBounds.maxY - pageBounds.minY,
    }),
  });
}

export function createRectangularCutPathMm(id: string, bounds: CutBoundsMm): Omit<CutPathMm, "boundsMm"> {
  const { xMm, yMm, widthMm, heightMm } = bounds;
  const topLeft = Object.freeze({ xMm, yMm });
  const topRight = Object.freeze({ xMm: xMm + widthMm, yMm });
  const bottomRight = Object.freeze({ xMm: xMm + widthMm, yMm: yMm + heightMm });
  const bottomLeft = Object.freeze({ xMm, yMm: yMm + heightMm });
  return Object.freeze({
    id,
    start: topLeft,
    closed: true,
    segments: Object.freeze([
      Object.freeze({ type: "line" as const, from: topLeft, to: topRight }),
      Object.freeze({ type: "line" as const, from: topRight, to: bottomRight }),
      Object.freeze({ type: "line" as const, from: bottomRight, to: bottomLeft }),
      Object.freeze({ type: "line" as const, from: bottomLeft, to: topLeft }),
    ]),
  });
}

function maxNumberDelta(first: number, second: number): number {
  return Math.abs(first - second);
}

export function compareCutGeometryMm(
  expected: CutGeometryMm,
  actual: CutGeometryMm,
  toleranceMm = CUT_GEOMETRY_TOLERANCE_MM,
  options: { readonly compareIds?: boolean } = {},
): CutGeometryComparison {
  if (!Number.isFinite(toleranceMm) || toleranceMm < 0) throw new RangeError("Cut geometry comparison tolerance must be finite and non-negative.");
  const differences: string[] = [];
  let maximumDeltaMm = 0;
  const compareNumber = (left: number, right: number, label: string) => {
    const delta = maxNumberDelta(left, right);
    maximumDeltaMm = Math.max(maximumDeltaMm, delta);
    if (delta > toleranceMm) differences.push(`${label} differs by ${delta} mm`);
  };
  compareNumber(expected.pageSizeMm.widthMm, actual.pageSizeMm.widthMm, "page width");
  compareNumber(expected.pageSizeMm.heightMm, actual.pageSizeMm.heightMm, "page height");
  if (expected.paths.length !== actual.paths.length) differences.push("path count differs");
  const count = Math.min(expected.paths.length, actual.paths.length);
  for (let index = 0; index < count; index += 1) {
    const left = expected.paths[index]!;
    const right = actual.paths[index]!;
    if (options.compareIds && left.id !== right.id) differences.push(`path ${index + 1} ID differs`);
    if (left.closed !== right.closed) differences.push(`path ${index + 1} closure differs`);
    if (left.segments.length !== right.segments.length) differences.push(`path ${index + 1} segment count differs`);
    compareNumber(left.start.xMm, right.start.xMm, `path ${index + 1} start x`);
    compareNumber(left.start.yMm, right.start.yMm, `path ${index + 1} start y`);
    for (let segmentIndex = 0; segmentIndex < Math.min(left.segments.length, right.segments.length); segmentIndex += 1) {
      const a = left.segments[segmentIndex]!;
      const b = right.segments[segmentIndex]!;
      if (a.type !== b.type) { differences.push(`path ${index + 1} segment ${segmentIndex + 1} type differs`); continue; }
      const comparePoint = (first: CutPointMm, second: CutPointMm, label: string) => {
        compareNumber(first.xMm, second.xMm, `${label} x`);
        compareNumber(first.yMm, second.yMm, `${label} y`);
      };
      comparePoint(a.from, b.from, `path ${index + 1} segment ${segmentIndex + 1} from`);
      comparePoint(a.to, b.to, `path ${index + 1} segment ${segmentIndex + 1} to`);
      if (a.type === "cubic" && b.type === "cubic") {
        comparePoint(a.control1, b.control1, `path ${index + 1} segment ${segmentIndex + 1} control1`);
        comparePoint(a.control2, b.control2, `path ${index + 1} segment ${segmentIndex + 1} control2`);
      }
      if (a.type === "quadratic" && b.type === "quadratic") comparePoint(a.control, b.control, `path ${index + 1} segment ${segmentIndex + 1} control`);
      if (a.type === "arc" && b.type === "arc") {
        comparePoint(a.center, b.center, `path ${index + 1} segment ${segmentIndex + 1} center`);
        comparePoint(a.axisU, b.axisU, `path ${index + 1} segment ${segmentIndex + 1} axisU`);
        comparePoint(a.axisV, b.axisV, `path ${index + 1} segment ${segmentIndex + 1} axisV`);
        compareNumber(a.startAngleRad, b.startAngleRad, `path ${index + 1} segment ${segmentIndex + 1} start angle`);
        compareNumber(a.sweepAngleRad, b.sweepAngleRad, `path ${index + 1} segment ${segmentIndex + 1} sweep`);
      }
    }
    for (const field of ["xMm", "yMm", "widthMm", "heightMm"] as const) compareNumber(left.boundsMm[field], right.boundsMm[field], `path ${index + 1} bounds ${field}`);
  }
  return Object.freeze({ equal: differences.length === 0, maximumDeltaMm, differences: Object.freeze(differences) });
}
