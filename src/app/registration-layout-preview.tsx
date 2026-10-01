"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { CutGuideEngine } from "../../core/geometry";
import { calculateSharedPagePlacements, createDuplexPagePairing, getDuplexPreviewOverlayMatrix } from "../../core/duplex";
import { generateRegistrationGeometry, transformRegistrationGeometry, type RegistrationPrimitive } from "../../core/registration";
import type { WorkingCard } from "../../core/cards/types";
import { isDoubleFacedIdentity } from "../../core/cards/back-selection";
import { resolveBackForMissingPolicy } from "./back-validation";
import type { ProjectSettingsV2 } from "../../persistence/projects/serializer";
import { cutPathToSvgD } from "../../core/cut";
import type { CutPreviewDto } from "../../services/cut-api";

interface RegistrationLayoutPreviewProps {
  readonly settings: ProjectSettingsV2;
  readonly cardCount: number;
  readonly cards: readonly WorkingCard[];
  readonly cutPreview?: CutPreviewDto | null;
  readonly selectedPageNumber: number;
  readonly onSelectPage: (pageNumber: number) => void;
  readonly onToggleSkippedSlot: (index: number) => void;
}

function primitiveElement(primitive: RegistrationPrimitive, key: string) {
  if (primitive.type === "line") return <line key={key} x1={primitive.x1Mm} y1={primitive.y1Mm} x2={primitive.x2Mm} y2={primitive.y2Mm} stroke="#111827" strokeWidth={primitive.strokeWidthMm} />;
  if (primitive.type === "rect") return <rect key={key} x={primitive.xMm} y={primitive.yMm} width={primitive.widthMm} height={primitive.heightMm} fill={primitive.fill ? "#111827" : "none"} stroke={primitive.strokeWidthMm ? "#111827" : "none"} strokeWidth={primitive.strokeWidthMm} />;
  return <circle key={key} cx={primitive.cxMm} cy={primitive.cyMm} r={primitive.radiusMm} fill={primitive.fill ? "#111827" : "none"} stroke={primitive.strokeWidthMm ? "#111827" : "none"} strokeWidth={primitive.strokeWidthMm} />;
}

export default function RegistrationLayoutPreview({ settings, cardCount, cards, cutPreview = null, selectedPageNumber, onSelectPage, onToggleSkippedSlot }: RegistrationLayoutPreviewProps) {
  const [previewSide, setPreviewSide] = useState<"front" | "back">("front");
  const paper = settings.paperFormat;
  const card = settings.cardFormat;
  const physicalCards = useMemo(() => cards.slice().sort((left, right) => left.order - right.order).flatMap((entry) => Array.from({ length: entry.quantity }, () => entry)), [cards]);
  const result = useMemo(() => {
    try {
      const templateGeometry = settings.layout.templateGeometry ?? cutPreview?.derivedTemplateGeometry;
      const { pages, pageOrientation } = calculateSharedPagePlacements(cardCount, {
        bleedMm: settings.bleedMm,
        paperFormat: paper,
        cardFormat: card,
        pageOrientation: settings.pageOrientation,
        cardOrientation: settings.cardOrientation,
        marginsMm: settings.marginsMm,
        horizontalGapMm: settings.horizontalGapMm,
        verticalGapMm: settings.verticalGapMm,
        registration: settings.registration,
        skippedSlotIndices: settings.layout.skippedSlotIndices,
        ...(templateGeometry ? { templateGeometry } : {}),
        ...(settings.layout.rows !== undefined && settings.layout.columns !== undefined
          ? { layoutRows: settings.layout.rows, layoutColumns: settings.layout.columns }
          : {}),
      });
      const pageSizeMm = pages[0]?.placement.pageSizeMm;
      if (!pageSizeMm) throw new Error("Nenhuma página física foi composta.");
      const geometry = generateRegistrationGeometry(settings.registration, pageSizeMm);
      const pairing = createDuplexPagePairing(pages, { pageOrientation, flipMode: settings.duplexFlipMode });
      return { pages, geometry, pairing, error: null } as const;
    } catch (error) {
      return { pages: null, geometry: null, pairing: null, error: error instanceof Error ? error.message : "Layout inválido." } as const;
    }
  }, [settings, cardCount, paper, card, cutPreview?.derivedTemplateGeometry]);

  if (!result.pages || !result.geometry) {
    return <section className="registration-preview" aria-label="Preview da folha">
      <h4>Preview de folha</h4><p className="error-message" role="alert">Layout inválido: {result.error}</p>
    </section>;
  }
  const { geometry } = result;
  const activePageIndex = Math.min(selectedPageNumber, result.pages.length) - 1;
  const pagePair = result.pairing!.pagePairs[activePageIndex]!;
  const pagePlacement = previewSide === "front" ? pagePair.frontPlacement : pagePair.backPlacement;
  const registrationForPage = previewSide === "front"
    ? geometry
    : transformRegistrationGeometry(geometry, pagePair.backPlacement.placement.pageSizeMm, pagePair.backPageTransform.registrationReflectionAxis);
  const { placement } = pagePlacement;
  const physicalSheet = pagePair.frontPlacement.placement;
  const cutGeometry = new CutGuideEngine().generate({
    cards: physicalSheet.slots.map((slot) => ({ trim: slot.trim, bleedMm: settings.bleedMm })),
    pageSizeMm: physicalSheet.pageSizeMm,
    config: settings.cutGuides,
  });
  const cutOverlayMatrix = getDuplexPreviewOverlayMatrix(previewSide, pagePair.backPageTransform.registrationReflectionAxis, placement.pageSizeMm);
  const cutOverlayTransform = `matrix(${cutOverlayMatrix.a} ${cutOverlayMatrix.b} ${cutOverlayMatrix.c} ${cutOverlayMatrix.d} ${cutOverlayMatrix.e} ${cutOverlayMatrix.f})`;
  const cutPreviewPage = cutPreview?.pages.find(({ pageNumber: sourcePage }) => sourcePage === activePageIndex + 1);
  const page = placement.pageSizeMm;
  const fontSize = Math.min(7, page.widthMm / 35);
  const skipped = new Set(placement.gridSlots.filter(({ skippedByUser }) => skippedByUser).map(({ index }) => index));
  const assigned = new Set(placement.slots.map(({ index }) => index));
  const reserved = new Set(placement.gridSlots.filter(({ reserved: isReserved }) => isReserved).map(({ index }) => index));
  const toggle = (index: number) => onToggleSkippedSlot(index);
  const slotsCanBeSkipped = Boolean(settings.layout.templateGeometry
    || cutPreview?.derivedTemplateGeometry
    || (settings.layout.rows !== undefined && settings.layout.columns !== undefined));

  return <section className="registration-preview" aria-label="Preview da folha">
    <div className="registration-preview-heading"><div><h4>Preview da folha</h4><p>{settings.paperFormat.name} {settings.pageOrientation} · {settings.cardFormat.name} {card.widthMm} × {card.heightMm} mm / {settings.cardOrientation} · registration {settings.registration.type}/{settings.registration.orientation} · capacidade {placement.capacity} · página PDF {activePageIndex + 1}/{result.pages.length} · cartas {pagePlacement.startCardIndex + 1}–{pagePlacement.endCardIndex}</p></div>
      <span>Bleed · trim · cut guides · reserved zones · skipped slots</span>
    </div>
    <div className="duplex-preview-controls" role="group" aria-label="Face do preview">
      <button type="button" className={`button ${previewSide === "front" ? "primary" : "secondary"}`} aria-pressed={previewSide === "front"} onClick={() => setPreviewSide("front")}>Frente</button>
      <button type="button" className={`button ${previewSide === "back" ? "primary" : "secondary"}`} aria-pressed={previewSide === "back"} onClick={() => setPreviewSide("back")}>Verso</button>
      <span>{cards.some((entry) => isDoubleFacedIdentity(entry.identity)) ? "Front ↔ Back · carta dupla-face · coordenadas do verso já pareadas" : `Verso · ${settings.duplexFlipMode} · artwork ${pagePair.backPageTransform.artworkOrientation.rotationDegrees}° no PDF para ficar upright após virar`}</span>
    </div>
    {result.pages.length > 1 && <label className="registration-page-picker">Página PDF
      <select aria-label="Página PDF do preview físico" value={activePageIndex + 1} onChange={(event) => onSelectPage(Number(event.currentTarget.value))}>
        {result.pages.map((entry, index) => <option key={entry.pageIndex} value={entry.pageIndex + 1}>Página {index + 1} · cartas {entry.startCardIndex + 1}–{entry.endCardIndex}</option>)}
      </select>
    </label>}
    <svg className="registration-sheet-preview" viewBox={`0 0 ${page.widthMm} ${page.heightMm}`} role="img" aria-label={`Preview ${previewSide === "front" ? "frente" : "verso"} ${settings.paperFormat.name} ${settings.pageOrientation}, página pareada ${activePageIndex + 1} e ${geometry.marks.length} registration marks`}>
      <rect x="0" y="0" width={page.widthMm} height={page.heightMm} fill="#fff" stroke="#64748b" strokeWidth="0.5" />
      {placement.gridSlots.map((slot) => <g
        key={`slot-${slot.index}`}
        {...(slotsCanBeSkipped && previewSide === "front" ? { role: "button", tabIndex: 0 } : {})}
        aria-label={`Slot ${slot.index + 1}${skipped.has(slot.index) ? " desativado" : reserved.has(slot.index) ? " reservado" : assigned.has(slot.index) ? ` carta física ${pagePlacement.startCardIndex + slot.cardIndex! + 1}` : " vazio"}`}
        aria-pressed={skipped.has(slot.index)}
        {...(slotsCanBeSkipped && previewSide === "front" ? {
          onClick: () => toggle(slot.index),
          onKeyDown: (event: KeyboardEvent<SVGGElement>) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(slot.index); } },
        } : {})}
        className={`registration-preview-slot ${previewSide === "back" ? "is-back" : ""}`}
      >
        <rect x={slot.slotXmm} y={slot.slotYmm} width={slot.slotWidthMm} height={slot.slotHeightMm} fill={skipped.has(slot.index) ? "#f3e8ff" : "#fff7ed"} stroke={skipped.has(slot.index) ? "#7e22ce" : "#f97316"} strokeWidth="0.35" />
        {assigned.has(slot.index) && (() => {
          const physicalIndex = pagePlacement.startCardIndex + slot.cardIndex!;
          const physicalCard = physicalCards[physicalIndex];
          const policyBack = physicalCard
            ? resolveBackForMissingPolicy(physicalCard, settings.projectDefaultBack, settings.missingBackPolicy)
            : null;
          const hasBack = previewSide === "front" || policyBack?.status === "available";
          const name = physicalCard?.identity?.name ?? physicalCard?.identityHints.name ?? physicalCard?.importSource.filename ?? "Custom card";
          const dfcLabel = physicalCard && isDoubleFacedIdentity(physicalCard.identity) ? " · DFC" : "";
          return <>
            <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill={hasBack ? "#eff6ff" : "#f1f5f9"} stroke={hasBack ? "#1d4ed8" : "#64748b"} strokeWidth="0.5" />
            <g transform={previewSide === "back" && pagePair.backPageTransform.artworkOrientation.rotationDegrees === 180
              ? `rotate(180 ${slot.trim.xMm + slot.trim.widthMm / 2} ${slot.trim.yMm + slot.trim.heightMm / 2})`
              : undefined}>
              <text x={slot.trim.xMm + slot.trim.widthMm / 2} y={slot.trim.yMm + slot.trim.heightMm * 0.34} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fill="#1e3a8a">TOP ↑</text>
              <text x={slot.trim.xMm + slot.trim.widthMm / 2} y={slot.trim.yMm + slot.trim.heightMm * 0.56} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize * 0.76} fill="#1e3a8a">{String(physicalIndex + 1).padStart(2, "0")}{previewSide === "front" ? "F" : "B"} · {name.slice(0, 18)}{dfcLabel}</text>
            </g>
            {!hasBack && <text x={slot.trim.xMm + slot.trim.widthMm / 2} y={slot.trim.yMm + slot.trim.heightMm * 0.76} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize * 0.68} fill="#475569">BLANK BACK</text>}
          </>;
        })()}
        {skipped.has(slot.index) && <>
          <line x1={slot.trim.xMm} y1={slot.trim.yMm} x2={slot.trim.xMm + slot.trim.widthMm} y2={slot.trim.yMm + slot.trim.heightMm} stroke="#7e22ce" strokeWidth="1" />
          <line x1={slot.trim.xMm + slot.trim.widthMm} y1={slot.trim.yMm} x2={slot.trim.xMm} y2={slot.trim.yMm + slot.trim.heightMm} stroke="#7e22ce" strokeWidth="1" />
          <text x={slot.trim.xMm + slot.trim.widthMm / 2} y={slot.trim.yMm + slot.trim.heightMm / 2} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fill="#581c87">SKIP {slot.index + 1}</text>
        </>}
        {!assigned.has(slot.index) && !skipped.has(slot.index) && <text x={slot.trim.xMm + slot.trim.widthMm / 2} y={slot.trim.yMm + slot.trim.heightMm / 2} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fill="#64748b">{slot.index + 1}</text>}
      </g>)}
      {registrationForPage.reservedZones.map((zone, index) => <rect key={`reserved-${index}`} x={zone.xMm} y={zone.yMm} width={zone.widthMm} height={zone.heightMm} fill="#fecaca" fillOpacity="0.75" stroke="#dc2626" strokeWidth="0.7" strokeDasharray="2 1" />)}
      <g data-duplex-cut-overlay={previewSide} transform={cutOverlayTransform}>
        {(cutPreviewPage?.geometry ?? cutPreview?.geometry)?.paths.map((path) => {
          const state = (cutPreviewPage?.slotPaths ?? cutPreview?.slotPaths ?? []).find(({ pathId }) => pathId === path.id)?.state ?? "empty";
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
      </g>
      {registrationForPage.marks.flatMap((mark) => mark.primitives.map((primitive, index) => primitiveElement(primitive, `${mark.id}-${index}`)))}
    </svg>
    {!slotsCanBeSkipped && <p>Defina linhas e colunas antes de desativar slots.</p>}
    {previewSide === "back" && <p className="muted">Verso físico: slots e registration refletidos no eixo {pagePair.backPageTransform.physicalSlotReflectionAxis.toUpperCase()} em mm; artwork rotacionado {pagePair.backPageTransform.artworkOrientation.rotationDegrees}° no PDF quando necessário para ler upright depois do flip {pagePair.flipMode}. Slots blank, skipped e reserved permanecem pareados sem compactação.</p>}
    <div className="registration-preview-legend"><span><i className="legend-bleed" /> Bleed</span><span><i className="legend-trim" /> Trim/card</span><span><i className="legend-cut-source" /> Cut path ativo</span><span><i className="legend-skipped" /> Skipped slot/path</span><span><i className="legend-reserved" /> Reserved zone</span><span><i className="legend-mark" /> Registration mark</span></div>
  </section>;
}
