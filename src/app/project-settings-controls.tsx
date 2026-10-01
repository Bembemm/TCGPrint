"use client";

import { useEffect, useState } from "react";
import CutGuideControls from "./cut-guide-controls";
import type { GuideColor, PageMarginsMm, PageOrientation } from "../../core/geometry";
import { createDefaultRegistrationConfig, parseRegistrationConfig, type RegistrationConfig } from "../../core/registration";
import type { ExportContentMode, MissingBackPolicy } from "../../persistence/projects/serializer";
import type { DuplexFlipMode } from "../../core/duplex";

export interface ProjectSettingsControlsProps {
  readonly bleedMm: string;
  readonly roundedCorners: boolean;
  readonly trimGuideEnabled: boolean;
  readonly trimGuideExtentMm: string;
  readonly trimGuideColor: GuideColor;
  readonly externalGuideEnabled: boolean;
  readonly externalGuideStrokeWidthPt: string;
  readonly externalGuideColor: GuideColor;
  readonly pageOrientation: PageOrientation;
  readonly cardOrientation: PageOrientation;
  readonly marginsMm: PageMarginsMm;
  readonly horizontalGapMm: number;
  readonly verticalGapMm: number;
  readonly registration: RegistrationConfig;
  readonly layoutRows: string;
  readonly layoutColumns: string;
  readonly templateGeometryActive: boolean;
  readonly skippedSlotIndices: readonly number[];
  readonly exportContentMode: ExportContentMode;
  readonly missingBackPolicy: MissingBackPolicy;
  readonly duplexFlipMode: DuplexFlipMode;
  readonly disabled: boolean;
  readonly onBleedMmChange: (value: string) => void;
  readonly onRoundedCornersChange: (value: boolean) => void;
  readonly onTrimGuideEnabledChange: (value: boolean) => void;
  readonly onTrimGuideExtentMmChange: (value: string) => void;
  readonly onTrimGuideColorChange: (value: GuideColor) => void;
  readonly onExternalGuideEnabledChange: (value: boolean) => void;
  readonly onExternalGuideStrokeWidthPtChange: (value: string) => void;
  readonly onExternalGuideColorChange: (value: GuideColor) => void;
  readonly onPageOrientationChange: (value: PageOrientation) => void;
  readonly onCardOrientationChange: (value: PageOrientation) => void;
  readonly onMarginChange: (side: keyof PageMarginsMm, value: number) => void;
  readonly onHorizontalGapChange: (value: number) => void;
  readonly onVerticalGapChange: (value: number) => void;
  readonly onRegistrationChange: (value: RegistrationConfig) => void;
  readonly onLayoutRowsChange: (value: string) => void;
  readonly onLayoutColumnsChange: (value: string) => void;
  readonly onExportContentModeChange: (value: ExportContentMode) => void;
  readonly onMissingBackPolicyChange: (value: MissingBackPolicy) => void;
  readonly onDuplexFlipModeChange: (value: DuplexFlipMode) => void;
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
  pageOrientation,
  cardOrientation,
  marginsMm,
  horizontalGapMm,
  verticalGapMm,
  registration,
  layoutRows,
  layoutColumns,
  templateGeometryActive,
  skippedSlotIndices,
  exportContentMode,
  missingBackPolicy,
  duplexFlipMode,
  disabled,
  onBleedMmChange,
  onRoundedCornersChange,
  onTrimGuideEnabledChange,
  onTrimGuideExtentMmChange,
  onTrimGuideColorChange,
  onExternalGuideEnabledChange,
  onExternalGuideStrokeWidthPtChange,
  onExternalGuideColorChange,
  onPageOrientationChange,
  onCardOrientationChange,
  onMarginChange,
  onHorizontalGapChange,
  onVerticalGapChange,
  onRegistrationChange,
  onLayoutRowsChange,
  onLayoutColumnsChange,
  onExportContentModeChange,
  onMissingBackPolicyChange,
  onDuplexFlipModeChange,
}: ProjectSettingsControlsProps) {
  const [customGeometryJson, setCustomGeometryJson] = useState("");
  const [customGeometryError, setCustomGeometryError] = useState("");
  useEffect(() => {
    if (registration.type === "custom") setCustomGeometryJson(JSON.stringify(registration, null, 2));
  }, [registration]);
  const setRegistrationOrientation = (orientation: PageOrientation) => {
    try { onRegistrationChange(parseRegistrationConfig({ ...registration, orientation })); }
    catch { /* Keep the previous valid geometry until a valid orientation is supplied. */ }
  };
  const setBuiltinNumber = (key: "insetXMm" | "insetYMm" | "armLengthMm" | "lineThicknessMm" | "squareSizeMm" | "reservedZoneClearanceMm", value: string) => {
    if ((registration.type === "three-point" || registration.type === "four-point") && value.trim()) {
      try { onRegistrationChange(parseRegistrationConfig({ ...registration, [key]: Number(value) })); }
      catch { /* Keep the previous physical value until the new number is valid. */ }
    }
  };
  const setRegistrationType = (value: string) => {
    const orientation = registration.orientation;
    if (value === "custom") {
      onRegistrationChange(registration.type === "custom" ? registration : {
        type: "custom",
        orientation,
        marks: [[{ type: "line", x1Mm: 10, y1Mm: 10, x2Mm: 20, y2Mm: 10, strokeWidthMm: 1 }]],
        reservedZones: [],
      });
      return;
    }
    onRegistrationChange(createDefaultRegistrationConfig(value as "none" | "three-point" | "four-point", orientation));
  };
  const setPhysicalValue = (value: string, apply: (next: number) => void) => {
    if (!value.trim()) { apply(0); return; }
    const next = Number(value);
    if (Number.isFinite(next) && next >= 0 && next <= 2_000) apply(next);
  };
  const setCustomGeometry = (value: string) => {
    setCustomGeometryJson(value);
    try {
      const parsed = parseRegistrationConfig(JSON.parse(value) as unknown);
      if (parsed.type === "custom") { onRegistrationChange(parsed); setCustomGeometryError(""); }
      else setCustomGeometryError("A geometria precisa ter type custom.");
    } catch (error) { setCustomGeometryError(error instanceof Error ? error.message : "JSON inválido."); }
  };
  return <>
    <div className="registration-layout-controls">
      <label>Conteúdo do PDF<select aria-label="Modo de exportação" value={exportContentMode} disabled={disabled} onChange={(event) => onExportContentModeChange(event.currentTarget.value as ExportContentMode)}>
        <option value="front-only">Somente frente</option><option value="back-only">Somente verso</option><option value="front-back-separated">Frente e verso separados (2 PDFs)</option><option value="duplex">Duplex intercalado</option>
      </select></label>
      {exportContentMode !== "front-only" && <>
        <label>Virada da folha<select aria-label="Modo de virada duplex" value={duplexFlipMode} disabled={disabled} onChange={(event) => onDuplexFlipModeChange(event.currentTarget.value as DuplexFlipMode)}>
          <option value="long-edge">Long edge</option><option value="short-edge">Short edge</option>
        </select></label>
        <label>Cartas sem verso<select aria-label="Política para cartas sem verso" value={missingBackPolicy} disabled={disabled} onChange={(event) => onMissingBackPolicyChange(event.currentTarget.value as MissingBackPolicy)}>
          <option value="use-project-default">Usar verso padrão do Project</option><option value="blank">Slot em branco</option><option value="warn-and-continue">Avisar e continuar</option><option value="block">Bloquear export</option>
        </select></label>
        <p className="muted">Separated gera `front.pdf` e `back.pdf` independentes dentro de um ZIP com manifest pareado. Back-only e front-only continuam disponíveis em separado.</p>
      </>}
      <label>Orientação da página<select value={pageOrientation} disabled={disabled} onChange={(event) => onPageOrientationChange(event.currentTarget.value as PageOrientation)}>
        <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
      </select></label>
      <label>Orientação das cartas<select value={cardOrientation} disabled={disabled} onChange={(event) => onCardOrientationChange(event.currentTarget.value as PageOrientation)}>
        <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
      </select></label>
      <label>Registration type<select value={registration.type} disabled={disabled} onChange={(event) => setRegistrationType(event.currentTarget.value)}>
        <option value="none">None</option><option value="three-point">Three-point</option><option value="four-point">Four-point</option><option value="custom">Custom</option>
      </select></label>
      <label>Orientação do registration<select value={registration.orientation} disabled={disabled} onChange={(event) => setRegistrationOrientation(event.currentTarget.value as PageOrientation)}>
        <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
      </select></label>
      {(registration.type === "three-point" || registration.type === "four-point") && <>
        <label>Offset X (mm)<input type="number" min="0" max="2000" step="0.1" value={registration.insetXMm} disabled={disabled} onChange={(event) => setBuiltinNumber("insetXMm", event.currentTarget.value)} /></label>
        <label>Offset Y (mm)<input type="number" min="0" max="2000" step="0.1" value={registration.insetYMm} disabled={disabled} onChange={(event) => setBuiltinNumber("insetYMm", event.currentTarget.value)} /></label>
        <label>Comprimento do traço (mm)<input type="number" min="0.01" max="2000" step="0.1" value={registration.armLengthMm} disabled={disabled} onChange={(event) => setBuiltinNumber("armLengthMm", event.currentTarget.value)} /></label>
        <label>Espessura (mm)<input type="number" min="0.01" max="20" step="0.1" value={registration.lineThicknessMm} disabled={disabled} onChange={(event) => setBuiltinNumber("lineThicknessMm", event.currentTarget.value)} /></label>
        {registration.type === "three-point" && <label>Lado do quadrado (mm)<input type="number" min="0.01" max="2000" step="0.1" value={registration.squareSizeMm} disabled={disabled} onChange={(event) => setBuiltinNumber("squareSizeMm", event.currentTarget.value)} /></label>}
        <label>Folga da zona reservada (mm)<input type="number" min="0" max="2000" step="0.1" value={registration.reservedZoneClearanceMm} disabled={disabled} onChange={(event) => setBuiltinNumber("reservedZoneClearanceMm", event.currentTarget.value)} /></label>
      </>}
      {registration.type === "custom" && <label>Custom geometry JSON (mm; exemplo ainda precisa validação física)
        <textarea rows={5} disabled={disabled} value={customGeometryJson} onChange={(event) => setCustomGeometry(event.currentTarget.value)} />
        {customGeometryError && <span role="alert">Custom geometry inválida: {customGeometryError}</span>}
      </label>}
      <label>Linhas da grade (opcional)<input type="number" min="1" max="1128" step="1" value={layoutRows} disabled={disabled || templateGeometryActive} onChange={(event) => onLayoutRowsChange(event.currentTarget.value)} /></label>
      <label>Colunas da grade (opcional)<input type="number" min="1" max="1128" step="1" value={layoutColumns} disabled={disabled || templateGeometryActive} onChange={(event) => onLayoutColumnsChange(event.currentTarget.value)} /></label>
      <label>Gap horizontal (mm)<input type="number" min="0" max="2000" step="0.1" value={horizontalGapMm} disabled={disabled} onChange={(event) => setPhysicalValue(event.currentTarget.value, onHorizontalGapChange)} /></label>
      <label>Gap vertical (mm)<input type="number" min="0" max="2000" step="0.1" value={verticalGapMm} disabled={disabled} onChange={(event) => setPhysicalValue(event.currentTarget.value, onVerticalGapChange)} /></label>
      <label>Margem superior (mm)<input type="number" min="0" max="2000" step="0.1" value={marginsMm.top} disabled={disabled} onChange={(event) => setPhysicalValue(event.currentTarget.value, (value) => onMarginChange("top", value))} /></label>
      <label>Margem direita (mm)<input type="number" min="0" max="2000" step="0.1" value={marginsMm.right} disabled={disabled} onChange={(event) => setPhysicalValue(event.currentTarget.value, (value) => onMarginChange("right", value))} /></label>
      <label>Margem inferior (mm)<input type="number" min="0" max="2000" step="0.1" value={marginsMm.bottom} disabled={disabled} onChange={(event) => setPhysicalValue(event.currentTarget.value, (value) => onMarginChange("bottom", value))} /></label>
      <label>Margem esquerda (mm)<input type="number" min="0" max="2000" step="0.1" value={marginsMm.left} disabled={disabled} onChange={(event) => setPhysicalValue(event.currentTarget.value, (value) => onMarginChange("left", value))} /></label>
      <p>{templateGeometryActive
        ? `Grade bloqueada pela geometria do template. Slots desativados: ${skippedSlotIndices.length ? skippedSlotIndices.map((index) => index + 1).join(", ") : "nenhum"}.`
        : layoutRows.trim() && layoutColumns.trim()
          ? `Slots desativados: ${skippedSlotIndices.length ? skippedSlotIndices.map((index) => index + 1).join(", ") : "nenhum"}. Clique em uma posição no preview para alternar.`
          : "Defina linhas e colunas antes de desativar slots."}</p>
    </div>
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
