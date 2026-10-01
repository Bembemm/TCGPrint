import { cutPathToSvgD, formatCutNumber } from "../../core/cut";
import type { CutGeometryMm } from "../../core/cut";
import { sourceFailure } from "./errors";

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Serializes a minimal vector-only SVG; the geometry is already in page-frame millimeters. */
export function exportCutGeometryToSvg(geometry: CutGeometryMm): string {
  if (geometry.units !== "mm" || geometry.coordinateFrame !== "page-top-left-y-down") sourceFailure("CUT_EXPORT_FAILED", "SVG export requires canonical page-frame millimeters.");
  const { widthMm, heightMm } = geometry.pageSizeMm;
  const paths = geometry.paths.map((path) => `  <path id="${escapeAttribute(path.id)}" d="${cutPathToSvgD(path)}" />`);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatCutNumber(widthMm)}mm" height="${formatCutNumber(heightMm)}mm" viewBox="0 0 ${formatCutNumber(widthMm)} ${formatCutNumber(heightMm)}">`,
    ...paths,
    `</svg>`,
    "",
  ].join("\n");
}
