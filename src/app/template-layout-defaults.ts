import type { TemplateLayoutGeometryMm } from "../../core/geometry";

export interface TemplateLayoutSettingsState {
  readonly rows: string;
  readonly columns: string;
  readonly skippedSlotIndices: readonly number[];
  readonly templateGeometry?: TemplateLayoutGeometryMm;
}

/** Applies versioned template layout defaults without leaving skips on an automatic grid. */
export function applyTemplateLayoutDefaults(
  current: TemplateLayoutSettingsState,
  templateGeometry: TemplateLayoutGeometryMm | undefined,
): TemplateLayoutSettingsState {
  if (templateGeometry) {
    return { rows: "", columns: "", skippedSlotIndices: [], templateGeometry };
  }
  const hasManualGrid = current.rows.trim().length > 0 && current.columns.trim().length > 0;
  return {
    rows: current.rows,
    columns: current.columns,
    skippedSlotIndices: hasManualGrid ? current.skippedSlotIndices : [],
  };
}
