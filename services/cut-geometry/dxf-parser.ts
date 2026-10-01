import type { CutArcSegmentMm, CutGeometryMm, CutPathMm, CutPointMm, CutSegmentMm, CutSourceIdentity } from "../../core/cut";
import { createCutGeometryMm } from "../../core/cut";
import { CutSourceError, sourceFailure } from "./errors";

const MAX_DXF_BYTES = 8 * 1024 * 1024;
const MAX_DXF_PAIRS = 500_000;
const MAX_DXF_LINE_LENGTH = 4_096;
const MAX_DXF_ENTITIES = 2_048;
const MAX_DXF_VERTICES = 20_000;
const EPSILON = 1e-12;

interface DxfPair {
  readonly code: number;
  readonly value: string;
  readonly line: number;
}

interface DxfEntity {
  readonly type: string;
  readonly pairs: readonly DxfPair[];
  readonly vertices?: readonly DxfEntity[];
}

export type DxfUnits = "mm" | "cm" | "m" | "in" | "ft" | "yd";

export interface DxfCutParseOptions {
  readonly source: CutSourceIdentity;
  readonly expectedPageSizeMm: { readonly widthMm: number; readonly heightMm: number };
  /** Required when $INSUNITS is missing or set to unitless. */
  readonly unitsOverride?: DxfUnits;
}

export interface DxfCutLimits {
  readonly maxBytes: number;
  readonly maxPairs: number;
  readonly maxLineLength: number;
  readonly maxEntities: number;
  readonly maxVertices: number;
}

export const DEFAULT_DXF_CUT_LIMITS: DxfCutLimits = Object.freeze({
  maxBytes: MAX_DXF_BYTES,
  maxPairs: MAX_DXF_PAIRS,
  maxLineLength: MAX_DXF_LINE_LENGTH,
  maxEntities: MAX_DXF_ENTITIES,
  maxVertices: MAX_DXF_VERTICES,
});

const INSUNITS_MM_FACTOR: Readonly<Record<number, number>> = Object.freeze({
  1: 25.4,
  2: 304.8,
  3: 1_609_344,
  4: 1,
  5: 10,
  6: 1_000,
  7: 1_000_000,
  8: 0.0000254,
  9: 0.0254,
  10: 914.4,
  11: 0.0000001,
  12: 0.000001,
  13: 0.001,
  14: 100,
  15: 10_000,
  16: 100_000,
  17: 1_000_000_000,
  18: 149_597_870_700_000,
  19: 9.4607304725808e18,
  20: 3.0856775814913673e19,
  21: 304.8006096012192,
  22: 25.4000508001016,
  23: 914.4018288036576,
  24: 1_609_347.2186944373,
});

const OVERRIDE_FACTOR: Readonly<Record<DxfUnits, number>> = Object.freeze({ mm: 1, cm: 10, m: 1_000, in: 25.4, ft: 304.8, yd: 914.4 });
const STANDARD_IGNORABLE_SECTIONS = new Set(["CLASSES", "BLOCKS", "OBJECTS", "THUMBNAILIMAGE"]);
const STANDARD_TABLE_RECORDS: Readonly<Record<string, string>> = Object.freeze({
  APPID: "APPID",
  BLOCK_RECORD: "BLOCK_RECORD",
  DIMSTYLE: "DIMSTYLE",
  LAYER: "LAYER",
  LTYPE: "LTYPE",
  STYLE: "STYLE",
  UCS: "UCS",
  VIEW: "VIEW",
  VPORT: "VPORT",
});

function malformed(message: string): never {
  return sourceFailure("CUT_SOURCE_MALFORMED", `DXF cut source ${message}`);
}

function unsupported(message: string): never {
  return sourceFailure("CUT_SOURCE_UNSUPPORTED", `DXF cut source uses unsupported geometry or structure: ${message}`);
}

function limit(message: string): never {
  return sourceFailure("CUT_SOURCE_COMPLEXITY_LIMIT", `DXF cut source exceeds a safety limit: ${message}`);
}

function pairsFromBytes(bytes: Uint8Array, limits: DxfCutLimits): DxfPair[] {
  if (bytes.byteLength > limits.maxBytes) sourceFailure("CUT_SOURCE_TOO_LARGE", `DXF cut source is ${bytes.byteLength} bytes; limit is ${limits.maxBytes}.`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { return malformed("must be valid UTF-8 ASCII text."); }
  if (text.includes("\0")) unsupported("binary DXF or NUL byte");
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length % 2 !== 0) malformed("is truncated: group-code/value pairs are incomplete.");
  if (lines.length / 2 > limits.maxPairs) limit(`more than ${limits.maxPairs} group-code/value pairs`);
  const pairs: DxfPair[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const rawCode = lines[index]!;
    const value = lines[index + 1]!;
    if (rawCode.length > 16 || value.length > limits.maxLineLength) limit(`line ${index + 1} exceeds the line-length limit`);
    if (!/^\s*\d{1,3}\s*$/.test(rawCode)) malformed(`has an invalid group code on line ${index + 1}.`);
    const code = Number(rawCode.trim());
    if (!Number.isSafeInteger(code) || code < 0 || code > 1071) malformed(`has an unsupported group code ${rawCode.trim()}.`);
    pairs.push({ code, value: value.trim(), line: index + 1 });
  }
  return pairs;
}

function numeric(pair: DxfPair | undefined, field: string, required = true, defaultValue = 0): number {
  if (!pair) {
    if (!required) return defaultValue;
    return malformed(`is missing ${field}.`);
  }
  if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(pair.value)) malformed(`${field} on line ${pair.line} is not numeric.`);
  const value = Number(pair.value);
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) malformed(`${field} on line ${pair.line} is non-finite or unbounded.`);
  return value;
}

function first(entity: DxfEntity, code: number): DxfPair | undefined {
  return entity.pairs.find((pair) => pair.code === code);
}

function values(entity: DxfEntity, code: number): readonly DxfPair[] {
  return entity.pairs.filter((pair) => pair.code === code);
}

function scalar(entity: DxfEntity, code: number, field: string, required = true, defaultValue = 0): number {
  const selected = values(entity, code);
  if (selected.length > 1) malformed(`${entity.type} has duplicate ${field} values.`);
  return numeric(selected[0], `${entity.type} ${field}`, required, defaultValue);
}

function parseSections(pairs: readonly DxfPair[], limits: DxfCutLimits): { header: Map<string, readonly DxfPair[]>; entities: DxfEntity[]; layers?: Map<string, { hidden: boolean }> } {
  const header = new Map<string, readonly DxfPair[]>();
  let layers: Map<string, { hidden: boolean }> | undefined;
  const entities: DxfEntity[] = [];
  const seen = new Set<string>();
  let foundEof = false;
  let index = 0;
  while (index < pairs.length) {
    const pair = pairs[index]!;
    if (pair.code === 0 && pair.value === "EOF") {
      foundEof = true;
      index += 1;
      if (pairs.slice(index).some(({ value }) => value !== "")) malformed("contains data after EOF.");
      break;
    }
    if (pair.code !== 0 || pair.value !== "SECTION" || pairs[index + 1]?.code !== 2) malformed(`expected SECTION at line ${pair.line}.`);
    const section = pairs[index + 1]!.value.toUpperCase();
    if (seen.has(section)) malformed(`contains more than one ${section} section.`);
    seen.add(section);
    index += 2;
    let end = index;
    while (end < pairs.length && !(pairs[end]?.code === 0 && pairs[end]?.value === "ENDSEC")) end += 1;
    if (end >= pairs.length) malformed(`${section} section is missing ENDSEC.`);
    const content = pairs.slice(index, end);
    if (section === "HEADER") parseHeader(content, header);
    else if (section === "ENTITIES") parseEntities(content, entities, limits);
    else if (section === "TABLES") layers = parseTables(content);
    else if (STANDARD_IGNORABLE_SECTIONS.has(section)) { /* Known non-geometric section, bounded by maxPairs/maxBytes. */ }
    else unsupported(`SECTION ${section}`);
    index = end + 1;
  }
  if (!foundEof) malformed("is missing EOF.");
  if (!seen.has("ENTITIES")) malformed("is missing the ENTITIES section.");
  return { header, entities, ...(layers ? { layers } : {}) };
}

function parseHeader(content: readonly DxfPair[], output: Map<string, readonly DxfPair[]>): void {
  let index = 0;
  while (index < content.length) {
    const pair = content[index]!;
    if (pair.code !== 9) malformed(`HEADER variable must begin with group code 9 on line ${pair.line}.`);
    const name = pair.value.toUpperCase();
    if (!/^\$[A-Z0-9_]+$/.test(name) || output.has(name)) malformed(`HEADER variable ${name} is invalid or duplicated.`);
    const start = index + 1;
    let end = start;
    while (end < content.length && content[end]!.code !== 9) end += 1;
    output.set(name, content.slice(start, end));
    index = end;
  }
}

function parseTables(content: readonly DxfPair[]): Map<string, { hidden: boolean }> {
  const layers = new Map<string, { hidden: boolean }>();
  const seenTables = new Set<string>();
  let index = 0;
  while (index < content.length) {
    if (content[index]?.code !== 0 || content[index]?.value !== "TABLE" || content[index + 1]?.code !== 2) malformed("TABLES section contains a malformed table.");
    const tableName = content[index + 1]!.value.toUpperCase();
    const expectedRecordType = STANDARD_TABLE_RECORDS[tableName];
    if (!expectedRecordType) unsupported(`TABLE ${tableName}`);
    if (seenTables.has(tableName)) malformed(`TABLES contains duplicate ${tableName} tables.`);
    seenTables.add(tableName);
    index += 2;
    let foundEndTable = false;
    while (index < content.length && !(content[index]?.code === 0 && content[index]?.value === "ENDTAB")) {
      if (content[index]?.code !== 0) { index += 1; continue; }
      const start = index;
      const recordType = content[index]!.value.toUpperCase();
      if (recordType !== expectedRecordType) unsupported(`record ${recordType} in TABLE ${tableName}`);
      index += 1;
      while (index < content.length && content[index]?.code !== 0) index += 1;
      if (tableName === "LAYER") {
        const entity: DxfEntity = { type: "LAYER", pairs: content.slice(start + 1, index) };
        const name = first(entity, 2)?.value;
        if (!name || name.length > 255 || layers.has(name)) malformed("LAYER table has an invalid or duplicate layer name.");
        const flags = scalar(entity, 70, "flags", false);
        const color = scalar(entity, 62, "color", false, 7);
        layers.set(name, { hidden: color < 0 || (flags & 1) !== 0 });
      }
    }
    if (content[index]?.code === 0 && content[index]?.value === "ENDTAB") foundEndTable = true;
    if (!foundEndTable) malformed(`${tableName} table is missing ENDTAB.`);
    index += 1;
  }
  return layers;
}

function parseEntities(content: readonly DxfPair[], output: DxfEntity[], limits: DxfCutLimits): void {
  let index = 0;
  while (index < content.length) {
    if (content[index]?.code !== 0) malformed(`ENTITIES record must begin with code 0 on line ${content[index]!.line}.`);
    const type = content[index]!.value.toUpperCase();
    const start = index + 1;
    index += 1;
    if (type === "POLYLINE") {
      const headerStart = index;
      while (index < content.length && content[index]?.code !== 0) index += 1;
      const header = content.slice(headerStart, index);
      const vertices: DxfEntity[] = [];
      while (index < content.length && content[index]?.code === 0 && content[index]?.value === "VERTEX") {
        if (vertices.length >= limits.maxVertices) limit(`more than ${limits.maxVertices} vertices in one POLYLINE`);
        const vertexStart = index + 1;
        index += 1;
        while (index < content.length && content[index]?.code !== 0) index += 1;
        vertices.push({ type: "VERTEX", pairs: content.slice(vertexStart, index) });
      }
      if (content[index]?.code !== 0 || content[index]?.value !== "SEQEND") malformed("POLYLINE is missing its SEQEND record.");
      index += 1;
      while (index < content.length && content[index]?.code !== 0) index += 1;
      if (output.length >= limits.maxEntities) limit(`more than ${limits.maxEntities} entities`);
      output.push({ type, pairs: header, vertices });
    } else {
      while (index < content.length && content[index]?.code !== 0) index += 1;
      if (output.length >= limits.maxEntities) limit(`more than ${limits.maxEntities} entities`);
      output.push({ type, pairs: content.slice(start, index) });
    }
    if (output.length > MAX_DXF_ENTITIES) limit(`more than ${MAX_DXF_ENTITIES} entities`);
  }
}

function headerValue(header: Map<string, readonly DxfPair[]>, name: string, code: number): DxfPair | undefined {
  const pairs = header.get(name);
  if (!pairs) return undefined;
  const matching = pairs.filter((pair) => pair.code === code);
  if (matching.length > 1) malformed(`HEADER ${name} contains duplicate values.`);
  return matching[0];
}

function unitFactor(header: Map<string, readonly DxfPair[]>, override: DxfUnits | undefined): number {
  const unitPairs = header.get("$INSUNITS");
  if (unitPairs && (unitPairs.length !== 1 || unitPairs[0]?.code !== 70)) malformed("HEADER $INSUNITS must contain exactly one group-code 70 value.");
  const declared = headerValue(header, "$INSUNITS", 70);
  const code = declared ? numeric(declared, "$INSUNITS") : undefined;
  if (code === undefined || code === 0) {
    if (!override) sourceFailure("CUT_SOURCE_UNITS_AMBIGUOUS", "DXF $INSUNITS is missing or unitless; select an explicit unit override (mm, cm, m, in, ft, yd)." );
    return OVERRIDE_FACTOR[override];
  }
  if (!Number.isSafeInteger(code) || code < 1 || code > 24 || INSUNITS_MM_FACTOR[code] === undefined) unsupported(`$INSUNITS value ${code}`);
  if (override && OVERRIDE_FACTOR[override] !== INSUNITS_MM_FACTOR[code]) sourceFailure("CUT_SOURCE_UNITS_AMBIGUOUS", `DXF $INSUNITS conflicts with the selected ${override} unit override.`);
  return INSUNITS_MM_FACTOR[code]!;
}

function checkEntityFrame(entity: DxfEntity): void {
  const zCodes = entity.type === "LINE" ? [30, 31]
    : entity.type === "LWPOLYLINE" || entity.type === "POLYLINE" ? [30, 38]
      : entity.type === "ARC" || entity.type === "CIRCLE" || entity.type === "ELLIPSE" ? [30, 31, 32]
        : [];
  for (const code of zCodes) {
    const pair = first(entity, code);
    if (pair && Math.abs(numeric(pair, `${entity.type} elevation`)) > EPSILON) unsupported(`${entity.type} non-planar Z coordinate`);
  }
  const thickness = first(entity, 39);
  if (thickness && Math.abs(numeric(thickness, `${entity.type} thickness`)) > EPSILON) unsupported(`${entity.type} nonzero thickness`);
  const extrusion = [
    [210, 0], [220, 0], [230, 1],
  ] as const;
  for (const [code, expected] of extrusion) {
    const pair = first(entity, code);
    if (pair && Math.abs(numeric(pair, `${entity.type} extrusion`) - expected) > EPSILON) unsupported(`${entity.type} non-default extrusion vector`);
  }
  const invisible = scalar(entity, 60, `${entity.type} visibility`, false);
  if (invisible !== 0) unsupported(`${entity.type} invisible entity`);
  const paperSpace = scalar(entity, 67, `${entity.type} paper-space flag`, false);
  if (paperSpace !== 0) unsupported(`${entity.type} paper-space entity`);
  const layoutNames = values(entity, 410);
  if (layoutNames.length > 1) malformed(`${entity.type} has duplicate layout names.`);
  if (layoutNames.length === 1 && layoutNames[0]!.value.toUpperCase() !== "MODEL") unsupported(`${entity.type} is assigned to a non-model layout`);
}

function entityIdentity(entity: DxfEntity, index: number): string {
  const handle = first(entity, 5)?.value;
  if (handle !== undefined) {
    if (!/^[0-9a-f]{1,16}$/i.test(handle)) malformed(`${entity.type} has an invalid entity handle.`);
    return `dxf-${handle.toUpperCase()}`;
  }
  return `dxf-path-${String(index + 1).padStart(4, "0")}`;
}

function pagePoint(x: number, y: number, factor: number, pageHeightMm: number): CutPointMm {
  return { xMm: x * factor, yMm: pageHeightMm - y * factor };
}

function vector(x: number, y: number, factor: number): CutPointMm {
  return { xMm: x * factor, yMm: -y * factor };
}

interface PolyVertex { readonly x: number; readonly y: number; readonly bulge: number; }

function bulgeArc(first: PolyVertex, second: PolyVertex, factor: number, pageHeightMm: number): CutArcSegmentMm {
  const bulge = first.bulge;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const chord = Math.hypot(dx, dy);
  if (chord <= EPSILON || !Number.isFinite(bulge) || Math.abs(bulge) > 1_000_000) malformed("polyline bulge is degenerate or unbounded.");
  const sweepAngleRad = 4 * Math.atan(bulge);
  const offset = chord * (1 - bulge * bulge) / (4 * bulge);
  const centerX = (first.x + second.x) / 2 - dy / chord * offset;
  const centerY = (first.y + second.y) / 2 + dx / chord * offset;
  const radius = Math.hypot(first.x - centerX, first.y - centerY);
  const startAngleRad = Math.atan2(first.y - centerY, first.x - centerX);
  const center = pagePoint(centerX, centerY, factor, pageHeightMm);
  const axisU = vector(radius, 0, factor);
  const axisV = vector(0, radius, factor);
  const from = pagePoint(first.x, first.y, factor, pageHeightMm);
  const to = pagePoint(second.x, second.y, factor, pageHeightMm);
  return { type: "arc", from, to, center, axisU, axisV, startAngleRad, sweepAngleRad };
}

function polylinePath(entity: DxfEntity, id: string, factor: number, pageHeightMm: number, limits: DxfCutLimits): Omit<CutPathMm, "boundsMm"> {
  if (entity.type === "LWPOLYLINE") {
    const flags = scalar(entity, 70, "LWPOLYLINE flags", false);
    if ((flags & (8 | 16 | 64)) !== 0) unsupported("3D, polygon mesh, or polyface LWPOLYLINE");
    if ((flags & ~(1 | 128)) !== 0) unsupported(`LWPOLYLINE flags ${flags}`);
    const declaredCount = scalar(entity, 90, "LWPOLYLINE vertex count");
    const vertices: Array<{ x?: number; y?: number; bulge: number }> = [];
    for (const pair of entity.pairs) {
      if (pair.code === 10) vertices.push({ x: numeric(pair, "LWPOLYLINE x"), bulge: 0 });
      else if (pair.code === 20) {
        const current = vertices.at(-1);
        if (!current || current.y !== undefined) malformed("LWPOLYLINE has a y coordinate without a matching x coordinate.");
        current.y = numeric(pair, "LWPOLYLINE y");
      } else if (pair.code === 42) {
        const current = vertices.at(-1);
        if (!current || current.y === undefined) malformed("LWPOLYLINE bulge must follow a complete vertex.");
        current.bulge = numeric(pair, "LWPOLYLINE bulge");
      } else if ([30, 38].includes(pair.code)) {
        if (Math.abs(numeric(pair, "LWPOLYLINE elevation/width")) > EPSILON) unsupported("LWPOLYLINE elevation or width");
      } else if ([40, 41, 43].includes(pair.code)) {
        if (Math.abs(numeric(pair, "LWPOLYLINE vertex/constant width")) > EPSILON) unsupported("LWPOLYLINE width");
      }
    }
    if (vertices.length !== declaredCount || vertices.some(({ x, y }) => x === undefined || y === undefined)) malformed("LWPOLYLINE declared vertex count does not match its coordinates.");
    if (vertices.length > limits.maxVertices) limit(`more than ${limits.maxVertices} vertices in one polyline`);
    return makePolyline(id, vertices as PolyVertex[], Boolean(flags & 1), factor, pageHeightMm);
  }
  for (const code of [40, 41]) {
    if (values(entity, code).some((pair) => Math.abs(numeric(pair, "POLYLINE width")) > EPSILON)) unsupported("POLYLINE width");
  }
  const flags = scalar(entity, 70, "POLYLINE flags", false);
  if ((flags & (8 | 16 | 64)) !== 0) unsupported("3D, polygon mesh, or polyface POLYLINE");
  if ((flags & ~(1 | 128)) !== 0) unsupported(`POLYLINE flags ${flags}`);
  const vertexCount = entity.vertices?.length ?? 0;
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 2 || vertexCount > limits.maxVertices) limit("POLYLINE vertex count");
  const vertices: PolyVertex[] = [];
  for (const vertex of entity.vertices ?? []) {
    checkEntityFrame(vertex);
    for (const code of [40, 41]) {
      if (values(vertex, code).some((pair) => Math.abs(numeric(pair, "VERTEX width")) > EPSILON)) unsupported("POLYLINE vertex width");
    }
    const x = numeric(first(vertex, 10), "VERTEX x");
    const y = numeric(first(vertex, 20), "VERTEX y");
    const vertexFlags = numeric(first(vertex, 70), "VERTEX flags", false);
    if ((vertexFlags & (2 | 4 | 8 | 16 | 32 | 64 | 128)) !== 0) unsupported("curve-fit, 3D, or mesh VERTEX");
    const z = first(vertex, 30);
    if (z && Math.abs(numeric(z, "VERTEX z")) > EPSILON) unsupported("non-planar VERTEX");
    const bulge = numeric(first(vertex, 42), "VERTEX bulge", false);
    vertices.push({ x, y, bulge });
  }
  if (vertices.length !== vertexCount) malformed("POLYLINE vertex count does not match its VERTEX records.");
  return makePolyline(id, vertices, Boolean(flags & 1), factor, pageHeightMm);
}

function makePolyline(id: string, vertices: readonly PolyVertex[], closed: boolean, factor: number, pageHeightMm: number): Omit<CutPathMm, "boundsMm"> {
  if (vertices.length < (closed ? 3 : 2)) malformed("polyline has too few vertices.");
  const start = pagePoint(vertices[0]!.x, vertices[0]!.y, factor, pageHeightMm);
  const segments: CutSegmentMm[] = [];
  const edgeCount = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < edgeCount; index += 1) {
    const firstVertex = vertices[index]!;
    const secondVertex = vertices[(index + 1) % vertices.length]!;
    segments.push(Math.abs(firstVertex.bulge) > EPSILON
      ? bulgeArc(firstVertex, secondVertex, factor, pageHeightMm)
      : { type: "line", from: pagePoint(firstVertex.x, firstVertex.y, factor, pageHeightMm), to: pagePoint(secondVertex.x, secondVertex.y, factor, pageHeightMm) });
  }
  return { id, start, closed, segments };
}

function simpleCurvePath(entity: DxfEntity, id: string, factor: number, pageHeightMm: number): Omit<CutPathMm, "boundsMm"> {
  checkEntityFrame(entity);
  if (entity.type === "LINE") {
    const start = pagePoint(scalar(entity, 10, "LINE start x"), scalar(entity, 20, "LINE start y"), factor, pageHeightMm);
    const end = pagePoint(scalar(entity, 11, "LINE end x"), scalar(entity, 21, "LINE end y"), factor, pageHeightMm);
    return { id, start, closed: false, segments: [{ type: "line", from: start, to: end }] };
  }
  if (entity.type === "ARC" || entity.type === "CIRCLE") {
    const x = scalar(entity, 10, `${entity.type} center x`);
    const y = scalar(entity, 20, `${entity.type} center y`);
    const radius = scalar(entity, 40, `${entity.type} radius`);
    if (radius <= 0) malformed(`${entity.type} radius must be positive.`);
    const startAngle = entity.type === "CIRCLE" ? 0 : scalar(entity, 50, "ARC start angle") * Math.PI / 180;
    const endAngle = entity.type === "CIRCLE" ? Math.PI * 2 : scalar(entity, 51, "ARC end angle") * Math.PI / 180;
    let sweep = entity.type === "CIRCLE" ? Math.PI * 2 : (endAngle - startAngle + Math.PI * 2) % (Math.PI * 2);
    if (entity.type === "ARC" && sweep <= EPSILON) malformed("ARC start and end angles must define a positive sweep.");
    const center = pagePoint(x, y, factor, pageHeightMm);
    const axisU = vector(radius, 0, factor);
    const axisV = vector(0, radius, factor);
    const segment: CutArcSegmentMm = {
      type: "arc",
      from: { xMm: center.xMm + axisU.xMm * Math.cos(startAngle) + axisV.xMm * Math.sin(startAngle), yMm: center.yMm + axisU.yMm * Math.cos(startAngle) + axisV.yMm * Math.sin(startAngle) },
      to: { xMm: center.xMm + axisU.xMm * Math.cos(startAngle + sweep) + axisV.xMm * Math.sin(startAngle + sweep), yMm: center.yMm + axisU.yMm * Math.cos(startAngle + sweep) + axisV.yMm * Math.sin(startAngle + sweep) },
      center,
      axisU,
      axisV,
      startAngleRad: startAngle,
      sweepAngleRad: sweep,
    };
    return { id, start: segment.from, closed: entity.type === "CIRCLE", segments: [segment] };
  }
  if (entity.type === "ELLIPSE") {
    const cx = scalar(entity, 10, "ELLIPSE center x");
    const cy = scalar(entity, 20, "ELLIPSE center y");
    const majorX = scalar(entity, 11, "ELLIPSE major-axis x");
    const majorY = scalar(entity, 21, "ELLIPSE major-axis y");
    const ratio = scalar(entity, 40, "ELLIPSE minor/major ratio");
    if (ratio <= 0 || ratio > 1 || Math.hypot(majorX, majorY) <= EPSILON) malformed("ELLIPSE axes or ratio are invalid.");
    const startAngle = scalar(entity, 41, "ELLIPSE start parameter", false, 0);
    const endAngle = scalar(entity, 42, "ELLIPSE end parameter", false, Math.PI * 2);
    let sweep = (endAngle - startAngle + Math.PI * 2) % (Math.PI * 2);
    const closed = Math.abs(endAngle - startAngle) >= Math.PI * 2 - EPSILON;
    if (closed) sweep = Math.PI * 2;
    else if (sweep <= EPSILON) malformed("ELLIPSE parameter interval is empty.");
    const center = pagePoint(cx, cy, factor, pageHeightMm);
    const axisU = vector(majorX, majorY, factor);
    const axisV = vector(-majorY * ratio, majorX * ratio, factor);
    const start = {
      xMm: center.xMm + axisU.xMm * Math.cos(startAngle) + axisV.xMm * Math.sin(startAngle),
      yMm: center.yMm + axisU.yMm * Math.cos(startAngle) + axisV.yMm * Math.sin(startAngle),
    };
    const end = {
      xMm: center.xMm + axisU.xMm * Math.cos(startAngle + sweep) + axisV.xMm * Math.sin(startAngle + sweep),
      yMm: center.yMm + axisU.yMm * Math.cos(startAngle + sweep) + axisV.yMm * Math.sin(startAngle + sweep),
    };
    const segment: CutArcSegmentMm = { type: "arc", from: start, to: end, center, axisU, axisV, startAngleRad: startAngle, sweepAngleRad: sweep };
    return { id, start, closed, segments: [segment] };
  }
  unsupported(`entity ${entity.type}`);
}

/**
 * Reads a bounded ASCII DXF subset (LINE, LWPOLYLINE, 2D POLYLINE/VERTEX,
 * ARC, CIRCLE, ELLIPSE). WCS XY is inches/INSUNITS-scaled then mapped from
 * CAD's bottom-left/Y-up page frame into the application's top-left/Y-down mm.
 */
export function parseDxfCutGeometry(
  bytes: Uint8Array,
  options: DxfCutParseOptions,
  overrides: Partial<DxfCutLimits> = {},
): CutGeometryMm {
  const limits = { ...DEFAULT_DXF_CUT_LIMITS, ...overrides };
  const pairs = pairsFromBytes(bytes, limits);
  const parsed = parseSections(pairs, limits);
  const factor = unitFactor(parsed.header, options.unitsOverride);
  const page = options.expectedPageSizeMm;
  if (![page.widthMm, page.heightMm].every((value) => Number.isFinite(value) && value > 0 && value <= 2_000)) malformed("expected Project page dimensions are invalid.");
  if (parsed.entities.length === 0) malformed("contains no cut entities.");
  if (parsed.entities.length > limits.maxEntities) limit(`more than ${limits.maxEntities} entities`);
  const ids = new Set<string>();
  const paths = parsed.entities.map((entity, index) => {
    if (!["LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "ELLIPSE"].includes(entity.type)) unsupported(`entity ${entity.type}`);
    checkEntityFrame(entity);
    const layer = first(entity, 8)?.value ?? "0";
    const layerInfo = parsed.layers?.get(layer);
    if (parsed.layers && !layerInfo) malformed(`${entity.type} references unknown layer ${layer}.`);
    if (layerInfo?.hidden) unsupported(`${entity.type} is on hidden/frozen layer ${layer}`);
    if (!parsed.layers && layer !== "0") {
      malformed(`${entity.type} references layer ${layer} without a LAYER table, so its visibility/frozen state cannot be verified.`);
    }
    const id = entityIdentity(entity, index);
    if (ids.has(id)) malformed(`contains duplicate entity handle ${id}.`);
    ids.add(id);
    const path = entity.type === "LINE" || entity.type === "ARC" || entity.type === "CIRCLE" || entity.type === "ELLIPSE"
      ? simpleCurvePath(entity, id, factor, page.heightMm)
      : polylinePath(entity, id, factor, page.heightMm, limits);
    return path;
  });
  try {
    return createCutGeometryMm({ source: options.source, pageSizeMm: page, paths });
  } catch (error) {
    if (error instanceof RangeError) sourceFailure("CUT_SOURCE_DIMENSIONS_MISMATCH", `DXF cut coordinates do not fit the selected ${page.widthMm} × ${page.heightMm} mm page: ${error.message}`, error);
    throw error;
  }
}
