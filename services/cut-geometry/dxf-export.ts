import type { CutGeometryMm, CutPointMm, CutSegmentMm } from "../../core/cut";
import { sourceFailure } from "./errors";

export const DXF_CURVE_FLATNESS_TOLERANCE_MM = 0.005;
const DXF_SERIALIZATION_DECIMALS = 6;
const MAX_FLATTENED_VERTICES = 20_000;
const MAX_CURVE_DEPTH = 20;

function number(value: number): string {
  if (!Number.isFinite(value)) sourceFailure("CUT_EXPORT_FAILED", "DXF export received non-finite geometry.");
  const rounded = Number(value.toFixed(DXF_SERIALIZATION_DECIMALS));
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(DXF_SERIALIZATION_DECIMALS).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1");
}

function distanceToSegment(point: CutPointMm, start: CutPointMm, end: CutPointMm): number {
  const dx = end.xMm - start.xMm;
  const dy = end.yMm - start.yMm;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-20) return Math.hypot(point.xMm - start.xMm, point.yMm - start.yMm);
  const parameter = Math.max(0, Math.min(1, ((point.xMm - start.xMm) * dx + (point.yMm - start.yMm) * dy) / lengthSquared));
  return Math.hypot(point.xMm - (start.xMm + parameter * dx), point.yMm - (start.yMm + parameter * dy));
}

function midpoint(a: CutPointMm, b: CutPointMm): CutPointMm {
  return { xMm: (a.xMm + b.xMm) / 2, yMm: (a.yMm + b.yMm) / 2 };
}

function flattenCubic(segment: Extract<CutSegmentMm, { type: "cubic" }>, output: CutPointMm[], depth: number): void {
  const flatness = Math.max(distanceToSegment(segment.control1, segment.from, segment.to), distanceToSegment(segment.control2, segment.from, segment.to));
  if (flatness <= DXF_CURVE_FLATNESS_TOLERANCE_MM) { output.push(segment.to); return; }
  if (depth >= MAX_CURVE_DEPTH) sourceFailure("CUT_EXPORT_FAILED", `DXF curve exceeded subdivision depth ${MAX_CURVE_DEPTH}.`);
  const p01 = midpoint(segment.from, segment.control1);
  const p12 = midpoint(segment.control1, segment.control2);
  const p23 = midpoint(segment.control2, segment.to);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const p0123 = midpoint(p012, p123);
  flattenCubic({ type: "cubic", from: segment.from, control1: p01, control2: p012, to: p0123 }, output, depth + 1);
  flattenCubic({ type: "cubic", from: p0123, control1: p123, control2: p23, to: segment.to }, output, depth + 1);
}

function flattenQuadratic(segment: Extract<CutSegmentMm, { type: "quadratic" }>, output: CutPointMm[], depth: number): void {
  if (distanceToSegment(segment.control, segment.from, segment.to) <= DXF_CURVE_FLATNESS_TOLERANCE_MM) { output.push(segment.to); return; }
  if (depth >= MAX_CURVE_DEPTH) sourceFailure("CUT_EXPORT_FAILED", `DXF curve exceeded subdivision depth ${MAX_CURVE_DEPTH}.`);
  const p01 = midpoint(segment.from, segment.control);
  const p12 = midpoint(segment.control, segment.to);
  const p012 = midpoint(p01, p12);
  flattenQuadratic({ type: "quadratic", from: segment.from, control: p01, to: p012 }, output, depth + 1);
  flattenQuadratic({ type: "quadratic", from: p012, control: p12, to: segment.to }, output, depth + 1);
}

function ellipseSecondDerivativeBound(segment: Extract<CutSegmentMm, { type: "arc" }>): number {
  return Math.hypot(segment.axisU.xMm, segment.axisU.yMm) + Math.hypot(segment.axisV.xMm, segment.axisV.yMm);
}

function flattenArc(segment: Extract<CutSegmentMm, { type: "arc" }>, output: CutPointMm[]): void {
  const curvatureBound = ellipseSecondDerivativeBound(segment);
  const maxStep = curvatureBound <= 1e-15
    ? Math.PI * 2
    : Math.sqrt(8 * DXF_CURVE_FLATNESS_TOLERANCE_MM / curvatureBound);
  const count = Math.ceil(Math.abs(segment.sweepAngleRad) / Math.max(maxStep, 1e-7));
  if (count > 4_096) sourceFailure("CUT_EXPORT_FAILED", "DXF curve requires more than 4096 deterministic subdivisions.");
  for (let index = 1; index <= count; index += 1) {
    const angle = segment.startAngleRad + segment.sweepAngleRad * index / count;
    output.push(index === count ? segment.to : {
      xMm: segment.center.xMm + segment.axisU.xMm * Math.cos(angle) + segment.axisV.xMm * Math.sin(angle),
      yMm: segment.center.yMm + segment.axisU.yMm * Math.cos(angle) + segment.axisV.yMm * Math.sin(angle),
    });
  }
}

function flattenPath(path: CutGeometryMm["paths"][number]): CutPointMm[] {
  const points: CutPointMm[] = [path.start];
  for (const segment of path.segments) {
    if (segment.type === "line") points.push(segment.to);
    else if (segment.type === "quadratic") flattenQuadratic(segment, points, 0);
    else if (segment.type === "cubic") flattenCubic(segment, points, 0);
    else flattenArc(segment, points);
    if (points.length > MAX_FLATTENED_VERTICES) sourceFailure("CUT_EXPORT_FAILED", `DXF path ${path.id} exceeds ${MAX_FLATTENED_VERTICES} vertices after bounded curve flattening.`);
  }
  if (path.closed && points.length > 1 && Math.hypot(points.at(-1)!.xMm - path.start.xMm, points.at(-1)!.yMm - path.start.yMm) <= 1e-8) points.pop();
  if ((path.closed && points.length < 3) || (!path.closed && points.length < 2)) sourceFailure("CUT_EXPORT_FAILED", `DXF path ${path.id} has too few vertices.`);
  return points;
}

/**
 * Exports deterministic ASCII DXF in millimeters. Curves become LWPOLYLINE
 * chords with a fixed 0.005 mm mathematical flatness bound.
 */
export function exportCutGeometryToDxf(geometry: CutGeometryMm): string {
  if (geometry.units !== "mm" || geometry.coordinateFrame !== "page-top-left-y-down") sourceFailure("CUT_EXPORT_FAILED", "DXF export requires canonical page-frame millimeters.");
  const { widthMm, heightMm } = geometry.pageSizeMm;
  const lines = [
    "0", "SECTION", "2", "HEADER",
    "9", "$ACADVER", "1", "AC1015",
    "9", "$INSUNITS", "70", "4",
    "9", "$MEASUREMENT", "70", "1",
    "9", "$EXTMIN", "10", "0", "20", "0", "30", "0",
    "9", "$EXTMAX", "10", number(widthMm), "20", number(heightMm), "30", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER", "70", "1",
    "0", "LAYER", "5", "2", "2", "CUT", "70", "0", "62", "1", "6", "CONTINUOUS",
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
  ];
  geometry.paths.forEach((path, index) => {
    const handle = (0x100 + index).toString(16).toUpperCase();
    const points = flattenPath(path);
    lines.push("0", "LWPOLYLINE", "5", handle, "8", "CUT", "90", String(points.length), "70", path.closed ? "1" : "0");
    for (const point of points) lines.push("10", number(point.xMm), "20", number(heightMm - point.yMm));
  });
  lines.push("0", "ENDSEC", "0", "EOF", "");
  return lines.join("\n");
}
