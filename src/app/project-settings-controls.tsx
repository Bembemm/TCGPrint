"use client";

import CutGuideControls from "./cut-guide-controls";
import type { GuideColor } from "../../core/geometry";

export interface ProjectSettingsControlsProps {
  readonly bleedMm: string;
  readonly roundedCorners: boolean;
  readonly trimGuideEnabled: boolean;
  readonly trimGuideExtentMm: string;
  readonly trimGuideColor: GuideColor;
  readonly externalGuideEnabled: boolean;
  readonly externalGuideStrokeWidthPt: string;
  readonly externalGuideColor: GuideColor;
  readonly disabled: boolean;
  readonly onBleedMmChange: (value: string) => void;
  readonly onRoundedCornersChange: (value: boolean) => void;
  readonly onTrimGuideEnabledChange: (value: boolean) => void;
  readonly onTrimGuideExtentMmChange: (value: string) => void;
  readonly onTrimGuideColorChange: (value: GuideColor) => void;
  readonly onExternalGuideEnabledChange: (value: boolean) => void;
  readonly onExternalGuideStrokeWidthPtChange: (value: string) => void;
  readonly onExternalGuideColorChange: (value: GuideColor) => void;
}

export default function ProjectSettingsControls({
  bleedMm,
  roundedCorners,
  trimGuideEnabled,
  trimGuideExtentMm,
  trimGuideColor,
  externalGuideEnabled,
  externalGuideStrokeWidthPt,
  externalGuideColor,
  disabled,
  onBleedMmChange,
  onRoundedCornersChange,
  onTrimGuideEnabledChange,
  onTrimGuideExtentMmChange,
  onTrimGuideColorChange,
  onExternalGuideEnabledChange,
  onExternalGuideStrokeWidthPtChange,
  onExternalGuideColorChange,
}: ProjectSettingsControlsProps) {
  return <>
    <label className="narrow-field">Bleed externo (mm)
      <input type="number" min="0" max="3" step="0.125" value={bleedMm} disabled={disabled} onChange={(event) => onBleedMmChange(event.currentTarget.value)} />
    </label>
    <label className="checkbox-field">
      <input type="checkbox" checked={roundedCorners} disabled={disabled} onChange={(event) => onRoundedCornersChange(event.currentTarget.checked)} />
      Cantos arredondados (opcional; desligado por padrão)
    </label>
    <CutGuideControls
      trimEnabled={trimGuideEnabled}
      trimExtentMm={trimGuideExtentMm}
      trimColor={trimGuideColor}
      externalEnabled={externalGuideEnabled}
      externalStrokeWidthPt={externalGuideStrokeWidthPt}
      externalColor={externalGuideColor}
      disabled={disabled}
      onTrimEnabledChange={onTrimGuideEnabledChange}
      onTrimExtentMmChange={onTrimGuideExtentMmChange}
      onTrimColorChange={onTrimGuideColorChange}
      onExternalEnabledChange={onExternalGuideEnabledChange}
      onExternalStrokeWidthPtChange={onExternalGuideStrokeWidthPtChange}
      onExternalColorChange={onExternalGuideColorChange}
    />
  </>;
}
