"use client";

export interface CutGuideControlsProps {
  readonly trimEnabled: boolean;
  readonly trimExtentMm: string;
  readonly externalEnabled: boolean;
  readonly externalStrokeWidthPt: string;
  readonly onTrimEnabledChange: (enabled: boolean) => void;
  readonly onTrimExtentMmChange: (extentMm: string) => void;
  readonly onExternalEnabledChange: (enabled: boolean) => void;
  readonly onExternalStrokeWidthPtChange: (strokeWidthPt: string) => void;
}

const TRIM_EXTENTS_MM = ["1", "2", "3", "5", "10", "15", "20", "25", "30", "40", "full"] as const;

export default function CutGuideControls({
  trimEnabled,
  trimExtentMm,
  externalEnabled,
  externalStrokeWidthPt,
  onTrimEnabledChange,
  onTrimExtentMmChange,
  onExternalEnabledChange,
  onExternalStrokeWidthPtChange,
}: CutGuideControlsProps) {
  return (
    <>
      <label className="checkbox-field">
        <input type="checkbox" checked={trimEnabled} onChange={(event) => onTrimEnabledChange(event.currentTarget.checked)} />
        Trim Guide
      </label>
      <label className="narrow-field">
        Trim Guide extent (mm)
        <select value={trimExtentMm} disabled={!trimEnabled} onChange={(event) => onTrimExtentMmChange(event.currentTarget.value)}>
          {TRIM_EXTENTS_MM.map((value) => <option key={value} value={value}>{value === "full" ? "full" : `${value} mm`}</option>)}
        </select>
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={externalEnabled} onChange={(event) => onExternalEnabledChange(event.currentTarget.checked)} />
        External Cut Guide
      </label>
      <label className="narrow-field">
        External stroke width (pt)
        <input
          type="number"
          min="0.1"
          step="0.1"
          value={externalStrokeWidthPt}
          disabled={!externalEnabled}
          onChange={(event) => onExternalStrokeWidthPtChange(event.currentTarget.value)}
        />
      </label>
    </>
  );
}
