"use client";

import { useMemo, type KeyboardEvent } from "react";
import { calculateGridPlacement, CutGuideEngine } from "../../core/geometry";
import { generateRegistrationGeometry, type RegistrationPrimitive } from "../../core/registration";
import type { ProjectSettingsV2 } from "../../persistence/projects/serializer";
import { cutPathToSvgD } from "../../core/cut";
import type { CutPreviewDto } from "../../services/cut-api";

interface RegistrationLayoutPreviewProps {
  readonly settings: ProjectSettingsV2;
  readonly cardCount: number;
  readonly cutPreview?: CutPreviewDto | null;
  readonly onToggleSkippedSlot: (index: number) => void;
}

function primitiveElement(primitive: RegistrationPrimitive, key: string) {
  if (primitive.type === "line") return <line key={key} x1={primitive.x1Mm} y1={primitive.y1Mm} x2={primitive.x2Mm} y2={primitive.y2Mm} stroke="#111827" strokeWidth={primitive.strokeWidthMm} />;
  if (primitive.type === "rect") return <rect key={key} x={primitive.xMm} y={primitive.yMm} width={primitive.widthMm} height={primitive.heightMm} fill={primitive.fill ? "#111827" : "none"} stroke={primitive.strokeWidthMm ? "#111827" : "none"} strokeWidth={primitive.strokeWidthMm} />;
  return <circle key={key} cx={primitive.cxMm} cy={primitive.cyMm} r={primitive.radiusMm} fill={primitive.fill ? "#111827" : "none"} stroke={primitive.strokeWidthMm ? "#111827" : "none"} strokeWidth={primitive.strokeWidthMm} />;
}

export default function RegistrationLayoutPreview({ settings, cardCount, cutPreview = null, onToggleSkippedSlot }: RegistrationLayoutPreviewProps) {
  const paper = settings.paperFormat;
  const card = settings.cardFormat;
  const result = useMemo(() => {
    try {
      const baseIsLandscape = paper.widthMm > paper.heightMm;
      const pageIsLandscape = settings.pageOrientation === "landscape";
      const pageSizeMm = baseIsLandscape === pageIsLandscape
        ? { widthMm: paper.widthMm, heightMm: paper.heightMm }
        : { widthMm: paper.heightMm, heightMm: paper.widthMm };
      const geometry = generateRegistrationGeometry(settings.registration, pageSizeMm);
      const templateGeometry = settings.layout.templateGeometry ?? cutPreview?.derivedTemplateGeometry;
      const placement = calculateGridPlacement({
        paper,
        pageOrientation: settings.pageOrientation,
        card,
        cardOrientation: settings.cardOrientation,
        count: cardCount,
        bleedMm: settings.bleedMm,
        marginsMm: settings.marginsMm,
        horizontalGapMm: settings.horizontalGapMm,
        verticalGapMm: settings.verticalGapMm,
        ...(templateGeometry ? { templateGeometry } : {}),
        reservedZonesMm: geometry.reservedZones,
        skippedSlotIndices: settings.layout.skippedSlotIndices,
        ...(settings.layout.rows !== undefined && settings.layout.columns !== undefined
          ? { rows: settings.layout.rows, columns: settings.layout.columns }
          : {}),
      });
      const cutGeometry = new CutGuideEngine().generate({
        cards: placement.slots.map((slot) => ({ trim: slot.trim, bleedMm: settings.bleedMm })),
        pageSizeMm: placement.pageSizeMm,
        config: settings.cutGuides,
      });
      return { placement, geometry, cutGeometry, error: null } as const;
    } catch (error) {
      return { placement: null, geometry: null, cutGeometry: null, error: error instanceof Error ? error.message : "Layout inválido." } as const;
    }
  }, [settings, cardCount, paper, card, cutPreview?.derivedTemplateGeometry]);

  if (!result.placement || !result.geometry || !result.cutGeometry) {
    return <section className="registration-preview" aria-label="Preview da folha">
      <h4>Preview de folha</h4><p className="error-message" role="alert">Layout inválido: {result.error}</p>
    </section>;
  }
  const { placement, geometry, cutGeometry } = result;
  const page = placement.pageSizeMm;
  const fontSize = Math.min(7, page.widthMm / 35);
  const skipped = new Set(settings.layout.skippedSlotIndices);
  const assigned = new Set(placement.slots.map(({ index }) => index));
  const reserved = new Set(placement.gridSlots.filter(({ reserved }) => reserved).map(({ index }) => index));
  const toggle = (index: number) => onToggleSkippedSlot(index);
  const slotsCanBeSkipped = Boolean(settings.layout.templateGeometry
    || cutPreview?.derivedTemplateGeometry
    || (settings.layout.rows !== undefined && settings.layout.columns !== undefined));

  return <section className="registration-preview" aria-label="Preview da folha">
    <div className="registration-preview-heading"><div><h4>Preview da folha</h4><p>{settings.paperFormat.name} {settings.pageOrientation} · {settings.cardFormat.name} {card.widthMm} × {card.heightMm} mm / {settings.cardOrientation} · registration {settings.registration.type}/{settings.registration.orientation} · capacidade {placement.capacity}</p></div>
      <span>Bleed · trim · cut guides · reserved zones · skipped slots</span>
    </div>
    <svg className="registration-sheet-preview" viewBox={`0 0 ${page.widthMm} ${page.heightMm}`} role="img" aria-label={`Folha ${settings.paperFormat.name} ${settings.pageOrientation} com ${cardCount} cartas e ${geometry.marks.length} registration marks`}>
      <rect x="0" y="0" width={page.widthMm} height={page.heightMm} fill="#fff" stroke="#64748b" strokeWidth="0.5" />
      {placement.gridSlots.map((slot) => <g
        key={`slot-${slot.index}`}
        {...(slotsCanBeSkipped ? { role: "button", tabIndex: 0 } : {})}
        aria-label={`Slot ${slot.index + 1}${skipped.has(slot.index) ? " desativado" : reserved.has(slot.index) ? " reservado" : assigned.has(slot.index) ? ` carta ${slot.cardIndex! + 1}` : " vazio"}`}
        aria-pressed={skipped.has(slot.index)}
        {...(slotsCanBeSkipped ? {
          onClick: () => toggle(slot.index),
          onKeyDown: (event: KeyboardEvent<SVGGElement>) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(slot.index); } },
        } : {})}
        className="registration-preview-slot"
      >
        <rect x={slot.slotXmm} y={slot.slotYmm} width={slot.slotWidthMm} height={slot.slotHeightMm} fill={skipped.has(slot.index) ? "#f3e8ff" : "#fff7ed"} stroke={skipped.has(slot.index) ? "#7e22ce" : "#f97316"} strokeWidth="0.35" />
        {assigned.has(slot.index) && <>
          <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill="#eff6ff" stroke="#1d4ed8" strokeWidth="0.5" />
          <text x={slot.trim.xMm + slot.trim.widthMm / 2} y={slot.trim.yMm + slot.trim.heightMm / 2} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fill="#1e3a8a">{String(slot.cardIndex! + 1).padStart(2, "0")}</text>
        </>}
        {skipped.has(slot.index) && <>
          <line x1={slot.trim.xMm} y1={slot.trim.yMm} x2={slot.trim.xMm + slot.trim.widthMm} y2={slot.trim.yMm + slot.trim.heightMm} stroke="#7e22ce" strokeWidth="1" />
          <line x1={slot.trim.xMm + slot.trim.widthMm} y1={slot.trim.yMm} x2={slot.trim.xMm} y2={slot.trim.yMm + slot.trim.heightMm} stroke="#7e22ce" strokeWidth="1" />
          <text x={slot.trim.xMm + slot.trim.widthMm / 2} y={slot.trim.yMm + slot.trim.heightMm / 2} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fill="#581c87">SKIP {slot.index + 1}</text>
        </>}
        {!assigned.has(slot.index) && !skipped.has(slot.index) && <text x={slot.trim.xMm + slot.trim.widthMm / 2} y={slot.trim.yMm + slot.trim.heightMm / 2} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fill="#64748b">{slot.index + 1}</text>}
      </g>)}
      {geometry.reservedZones.map((zone, index) => <rect key={`reserved-${index}`} x={zone.xMm} y={zone.yMm} width={zone.widthMm} height={zone.heightMm} fill="#fecaca" fillOpacity="0.75" stroke="#dc2626" strokeWidth="0.7" strokeDasharray="2 1" />)}
      {cutPreview?.geometry.paths.map((path) => {
        const state = cutPreview.slotPaths.find(({ pathId }) => pathId === path.id)?.state ?? "empty";
        const active = state === "active";
        const skippedPath = state === "skipped";
        return <path
          key={`source-cut-${path.id}`}
          d={cutPathToSvgD(path)}
          fill="none"
          stroke={active ? "#dc2626" : skippedPath ? "#7e22ce" : state === "reserved" ? "#ea580c" : "#64748b"}
          strokeWidth={active ? "0.65" : "0.4"}
          strokeDasharray={active ? undefined : "1.5 1"}
          opacity={active ? "0.95" : "0.75"}
          data-cut-slot-state={state}
          aria-label={`Cut path ${path.id}: ${state}`}
        />;
      })}
      {cutGeometry.trimSegments.map((segment, index) => <line key={`cut-${index}`} x1={segment.x1Mm} y1={segment.y1Mm} x2={segment.x2Mm} y2={segment.y2Mm} stroke="#2563eb" strokeWidth="0.2" />)}
      {cutGeometry.externalSegments.map((segment, index) => <line key={`external-cut-${index}`} x1={segment.x1Mm} y1={segment.y1Mm} x2={segment.x2Mm} y2={segment.y2Mm} stroke="#111827" strokeWidth="0.2" />)}
      {geometry.marks.flatMap((mark) => mark.primitives.map((primitive, index) => primitiveElement(primitive, `${mark.id}-${index}`)))}
    </svg>
    {!slotsCanBeSkipped && <p>Defina linhas e colunas antes de desativar slots.</p>}
    <div className="registration-preview-legend"><span><i className="legend-bleed" /> Bleed</span><span><i className="legend-trim" /> Trim/card</span><span><i className="legend-cut-source" /> Cut path ativo</span><span><i className="legend-skipped" /> Skipped slot/path</span><span><i className="legend-reserved" /> Reserved zone</span><span><i className="legend-mark" /> Registration mark</span></div>
  </section>;
}
