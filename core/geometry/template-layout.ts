import type { PageOrientation } from "./index";

export interface TemplateLayoutSlotMm {
  /** Stable zero-based row-major identity. */
  readonly index: number;
  readonly row: number;
  readonly column: number;
  readonly xMm: number;
  readonly yMm: number;
}

/** Immutable, bounded layout geometry supplied by one exact Template Library version. */
export interface TemplateLayoutGeometryMm {
  /** Coordinate frame for paper placement; independent from card orientation. */
  readonly orientation: PageOrientation;
  /** Physical orientation represented by cardSizeMm and each template slot. */
  readonly cardOrientation: PageOrientation;
  readonly pageSizeMm: { readonly widthMm: number; readonly heightMm: number };
  readonly cardSizeMm: { readonly widthMm: number; readonly heightMm: number };
  readonly rows: number;
  readonly columns: number;
  readonly slots: readonly TemplateLayoutSlotMm[];
}

const MAX_TEMPLATE_LAYOUT_BYTES = 128 * 1024;
const MAX_TEMPLATE_LAYOUT_SLOTS = 1_128;
const MAX_TEMPLATE_LAYOUT_DIMENSION_MM = 2_000;
const EPSILON_MM = 1e-9;

function invalid(reason: string): never {
  throw new RangeError(`Template layout geometry ${reason}`);
}

function object(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object.`);
  const source = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${field} must be a plain JSON object.`);
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid(`${field} contains unsupported field ${String(key)}.`);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) invalid(`${field} must not contain accessors.`);
  }
  return source;
}

function dimension(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TEMPLATE_LAYOUT_DIMENSION_MM) {
    invalid(`${field} must be a finite dimension from 0 mm to ${MAX_TEMPLATE_LAYOUT_DIMENSION_MM} mm.`);
  }
  return value;
}

function arrayValues(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TEMPLATE_LAYOUT_SLOTS) {
    invalid(`${field} must contain between 1 and ${MAX_TEMPLATE_LAYOUT_SLOTS} values.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^\d+$/.test(key)))) {
    invalid(`${field} must be a dense JSON array without custom properties.`);
  }
  return Array.from({ length: value.length }, (_unused, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) invalid(`${field}[${index}] must be a JSON value without an accessor.`);
    return descriptor.value;
  });
}

function nonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_TEMPLATE_LAYOUT_DIMENSION_MM) {
    invalid(`${field} must be a finite coordinate from 0 mm to ${MAX_TEMPLATE_LAYOUT_DIMENSION_MM} mm.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TEMPLATE_LAYOUT_SLOTS) {
    invalid(`${field} must be a positive integer no greater than ${MAX_TEMPLATE_LAYOUT_SLOTS}.`);
  }
  return value;
}

/** Strictly parses serializable template geometry and rejects unsafe or unbounded structures. */
export function parseTemplateLayoutGeometry(value: unknown): TemplateLayoutGeometryMm {
  const source = object(value, "root", ["orientation", "cardOrientation", "pageSizeMm", "cardSizeMm", "rows", "columns", "slots"]);
  const orientation = source.orientation;
  if (orientation !== "portrait" && orientation !== "landscape") invalid("orientation must be portrait or landscape.");
  const cardOrientation = source.cardOrientation;
  if (cardOrientation !== "portrait" && cardOrientation !== "landscape") invalid("cardOrientation must be portrait or landscape.");
  const pageSource = object(source.pageSizeMm, "pageSizeMm", ["widthMm", "heightMm"]);
  const cardSource = object(source.cardSizeMm, "cardSizeMm", ["widthMm", "heightMm"]);
  const pageSizeMm = Object.freeze({
    widthMm: dimension(pageSource.widthMm, "pageSizeMm.widthMm"),
    heightMm: dimension(pageSource.heightMm, "pageSizeMm.heightMm"),
  });
  const cardSizeMm = Object.freeze({
    widthMm: dimension(cardSource.widthMm, "cardSizeMm.widthMm"),
    heightMm: dimension(cardSource.heightMm, "cardSizeMm.heightMm"),
  });
  if (orientation === "portrait" && pageSizeMm.widthMm > pageSizeMm.heightMm + EPSILON_MM) {
    invalid("page dimensions do not match its portrait orientation.");
  }
  if (orientation === "landscape" && pageSizeMm.heightMm > pageSizeMm.widthMm + EPSILON_MM) {
    invalid("page dimensions do not match its landscape orientation.");
  }
  const rows = positiveInteger(source.rows, "rows");
  const columns = positiveInteger(source.columns, "columns");
  if (rows * columns > MAX_TEMPLATE_LAYOUT_SLOTS) invalid(`grid may contain at most ${MAX_TEMPLATE_LAYOUT_SLOTS} positions.`);
  const slotValues = arrayValues(source.slots, "slots");
  const identities = new Set<number>();
  const cells = new Set<string>();
  const slots = slotValues.map((slotValue, position) => {
    const slot = object(slotValue, `slots[${position}]`, ["index", "row", "column", "xMm", "yMm"]);
    const index = slot.index;
    const row = slot.row;
    const column = slot.column;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= rows * columns
      || typeof row !== "number" || !Number.isSafeInteger(row) || row < 0 || row >= rows
      || typeof column !== "number" || !Number.isSafeInteger(column) || column < 0 || column >= columns) {
      invalid(`slots[${position}] has an index, row, or column outside its fixed grid.`);
    }
    if (index !== row * columns + column) invalid(`slots[${position}] index must equal row * columns + column.`);
    if (identities.has(index) || cells.has(`${row}:${column}`)) invalid(`slots[${position}] duplicates a slot identity.`);
    identities.add(index);
    cells.add(`${row}:${column}`);
    const xMm = nonNegative(slot.xMm, `slots[${position}].xMm`);
    const yMm = nonNegative(slot.yMm, `slots[${position}].yMm`);
    if (xMm + cardSizeMm.widthMm > pageSizeMm.widthMm + EPSILON_MM
      || yMm + cardSizeMm.heightMm > pageSizeMm.heightMm + EPSILON_MM) {
      invalid(`slots[${position}] trim is outside page bounds.`);
    }
    return Object.freeze({ index, row, column, xMm, yMm });
  }).sort((left, right) => left.index - right.index);
  for (let firstIndex = 0; firstIndex < slots.length; firstIndex += 1) {
    const first = slots[firstIndex]!;
    for (let secondIndex = firstIndex + 1; secondIndex < slots.length; secondIndex += 1) {
      const second = slots[secondIndex]!;
      const overlapX = first.xMm < second.xMm + cardSizeMm.widthMm - EPSILON_MM
        && first.xMm + cardSizeMm.widthMm > second.xMm + EPSILON_MM;
      const overlapY = first.yMm < second.yMm + cardSizeMm.heightMm - EPSILON_MM
        && first.yMm + cardSizeMm.heightMm > second.yMm + EPSILON_MM;
      if (overlapX && overlapY) invalid(`slots ${first.index} and ${second.index} overlap.`);
    }
  }
  const normalized = Object.freeze({ orientation, cardOrientation, pageSizeMm, cardSizeMm, rows, columns, slots: Object.freeze(slots) });
  const serialized = JSON.stringify(normalized);
  if (new TextEncoder().encode(serialized).byteLength > MAX_TEMPLATE_LAYOUT_BYTES) {
    invalid(`must be at most ${MAX_TEMPLATE_LAYOUT_BYTES} bytes.`);
  }
  return normalized;
}
