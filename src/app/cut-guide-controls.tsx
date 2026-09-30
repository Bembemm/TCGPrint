"use client";

import { GUIDE_COLOR_OPTIONS, type GuideColor } from "../../core/geometry";

export interface CutGuideControlsProps {
  readonly disabled?: boolean;
  readonly trimEnabled: boolean;
  readonly trimExtentMm: string;
  readonly trimColor: GuideColor;
  readonly externalEnabled: boolean;
  readonly externalStrokeWidthPt: string;
  readonly externalColor: GuideColor;
  readonly onTrimEnabledChange: (enabled: boolean) => void;
  readonly onTrimExtentMmChange: (extentMm: string) => void;
  readonly onTrimColorChange: (color: GuideColor) => void;
  readonly onExternalEnabledChange: (enabled: boolean) => void;
  readonly onExternalStrokeWidthPtChange: (strokeWidthPt: string) => void;
  readonly onExternalColorChange: (color: GuideColor) => void;
}

const TRIM_EXTENTS_MM = ["1", "2", "3", "5", "10", "15", "20", "25", "30", "40", "full"] as const;

export default function CutGuideControls({
  trimEnabled,
  trimExtentMm,
  trimColor,
  externalEnabled,
  externalStrokeWidthPt,
  externalColor,
  disabled = false,
  onTrimEnabledChange,
  onTrimExtentMmChange,
  onTrimColorChange,
  onExternalEnabledChange,
  onExternalStrokeWidthPtChange,
  onExternalColorChange,
}: CutGuideControlsProps) {
  const hasPresetTrimExtent = (TRIM_EXTENTS_MM as readonly string[]).includes(trimExtentMm);

  return (
    <>
      <label className="checkbox-field">
        <input type="checkbox" checked={trimEnabled} disabled={disabled} onChange={(event) => onTrimEnabledChange(event.currentTarget.checked)} />
        Guia de corte no trim
      </label>
      <label className="narrow-field">
        Comprimento da guia no trim (mm)
        <select value={trimExtentMm} disabled={disabled || !trimEnabled} onChange={(event) => onTrimExtentMmChange(event.currentTarget.value)}>
          {!hasPresetTrimExtent && trimExtentMm !== "" && <option value={trimExtentMm}>{trimExtentMm} mm</option>}
          {TRIM_EXTENTS_MM.map((value) => <option key={value} value={value}>{value === "full" ? "full" : `${value} mm`}</option>)}
        </select>
      </label>
      <label className="narrow-field">
        Cor da guia no trim
        <select value={trimColor} disabled={disabled || !trimEnabled} onChange={(event) => onTrimColorChange(event.currentTarget.value as GuideColor)}>
          {GUIDE_COLOR_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={externalEnabled} disabled={disabled} onChange={(event) => onExternalEnabledChange(event.currentTarget.checked)} />
        Guia externa de corte
      </label>
      <label className="narrow-field">
        Espessura da guia externa (pt)
        <input
          type="number"
          min="0.1"
          step="0.1"
          value={externalStrokeWidthPt}
          disabled={disabled || !externalEnabled}
          onChange={(event) => onExternalStrokeWidthPtChange(event.currentTarget.value)}
        />
      </label>
      <label className="narrow-field">
        Cor da guia externa
        <select value={externalColor} disabled={disabled || !externalEnabled} onChange={(event) => onExternalColorChange(event.currentTarget.value as GuideColor)}>
          {GUIDE_COLOR_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </>
  );
}
