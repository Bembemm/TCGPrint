"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { CutGuideEngine } from "../../core/geometry";
import type { CardSlotMm } from "../../core/geometry/placement";
import { buildCanonicalPrintPlan, getDuplexPreviewOverlayMatrix } from "../../core/duplex";
import { createPrintCalibrationTransform } from "../../core/calibration";
import type { WorkingCard } from "../../core/cards/types";
import { createPhysicalOrder, type PhysicalOrder } from "../../core/cards/physical-instance-order";
import { isDoubleFacedIdentity } from "../../core/cards/back-selection";
import { resolveBackForMissingPolicy } from "./back-validation";
import type { ProjectSettingsV2 } from "../../persistence/projects/serializer";
import { cutPathToSvgD } from "../../core/cut";
import type { CutPreviewDto } from "../../services/cut-api";
import { transformRegistrationGeometry, type RegistrationPrimitive } from "../../core/registration";
import { calculateCompositorScale, COMPOSITOR_CSS_PX_PER_MM, stepCompositorScale, type CompositorViewportSize, type CompositorZoomMode } from "./compositor-zoom";

interface RegistrationLayoutPreviewProps {
  readonly settings: ProjectSettingsV2;
  readonly cardCount: number;
  readonly cards: readonly WorkingCard[];
  readonly physicalOrder?: PhysicalOrder;
  readonly selectedPhysicalInstanceId?: string | null;
  readonly face?: "front" | "back";
  readonly interactionBusy?: boolean;
  readonly cutPreview?: CutPreviewDto | null;
  readonly selectedPageNumber: number;
  readonly onSelectPage: (pageNumber: number) => void;
  readonly onToggleSkippedSlot: (index: number) => void;
  readonly onSelectPhysicalInstance?: (instanceId: string, cardId: string, side: "front" | "back") => void;
  readonly onFaceChange?: (side: "front" | "back") => void;
  readonly onSelectArtwork?: (cardId: string, instanceId: string, physicalCardIndex: number, side: "front" | "back", opener: HTMLButtonElement, copyNumber: number, totalCopies: number) => void;
  readonly onPhysicalAction?: (action: "increase" | "remove-copy" | "duplicate-copy" | "delete-entry" | "open-settings", instanceId: string, cardId: string) => void;
  readonly onReorderPhysicalInstance?: (instanceId: string, targetInstanceId: string | null, placement: "before" | "after") => void;
}

type CompositorLayer = "artwork" | "bleed" | "trim" | "cut" | "silhouette" | "registration" | "reserved" | "margins" | "calibration";
interface PhysicalCardInstance {
  readonly id: string;
  readonly physicalCardIndex: number;
  readonly workingCardId: string;
  readonly copyNumber: number;
  readonly totalCopies: number;
  readonly card: WorkingCard;
}

interface ContextualHudTarget {
  readonly instanceId: string;
  readonly workingCardId: string;
}

const COMPOSITOR_LAYERS: readonly { readonly id: CompositorLayer; readonly label: string }[] = [
  { id: "artwork", label: "Artwork" },
  { id: "bleed", label: "Bleed" },
  { id: "trim", label: "Trim" },
  { id: "cut", label: "Cut guides" },
  { id: "silhouette", label: "Silhouette / SVG-DXF" },
  { id: "registration", label: "Registration" },
  { id: "reserved", label: "Reserved zones" },
  { id: "margins", label: "Margins" },
  { id: "calibration", label: "Calibration" },
];

function primitiveElement(primitive: RegistrationPrimitive, key: string) {
  if (primitive.type === "line") return <line key={key} x1={primitive.x1Mm} y1={primitive.y1Mm} x2={primitive.x2Mm} y2={primitive.y2Mm} stroke="#111827" strokeWidth={primitive.strokeWidthMm} />;
  if (primitive.type === "rect") return <rect key={key} x={primitive.xMm} y={primitive.yMm} width={primitive.widthMm} height={primitive.heightMm} fill={primitive.fill ? "#111827" : "none"} stroke={primitive.strokeWidthMm ? "#111827" : "none"} strokeWidth={primitive.strokeWidthMm} />;
  return <circle key={key} cx={primitive.cxMm} cy={primitive.cyMm} r={primitive.radiusMm} fill={primitive.fill ? "#111827" : "none"} stroke={primitive.strokeWidthMm ? "#111827" : "none"} strokeWidth={primitive.strokeWidthMm} />;
}

function previewGeometryQuery(trimWidthMm: number, trimHeightMm: number, bleedMm: number, roundedCorners: boolean, cornerRadiusMm: number): string {
  const query = new URLSearchParams({
    trimWidthMm: String(trimWidthMm),
    trimHeightMm: String(trimHeightMm),
    bleedMm: String(bleedMm),
    roundedCorners: String(roundedCorners),
    ...(roundedCorners ? { cornerRadiusMm: String(cornerRadiusMm) } : {}),
  });
  return `?${query.toString()}`;
}

function artworkPreviewUrl(candidateId: string, trimWidthMm: number, trimHeightMm: number, bleedMm: number, roundedCorners: boolean, cornerRadiusMm: number): string {
  return `/api/cards/artworks/${encodeURIComponent(candidateId)}/preview${previewGeometryQuery(trimWidthMm, trimHeightMm, bleedMm, roundedCorners, cornerRadiusMm)}`;
}

function backPreviewUrl(assetId: string, trimWidthMm: number, trimHeightMm: number, bleedMm: number, roundedCorners: boolean, cornerRadiusMm: number): string {
  return `/api/back-library/${encodeURIComponent(assetId)}/preview${previewGeometryQuery(trimWidthMm, trimHeightMm, bleedMm, roundedCorners, cornerRadiusMm)}`;
}

function calibrationSvgMatrix(matrix: { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number }): string {
  return `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
}

export default function RegistrationLayoutPreview({ settings, cardCount, cards, physicalOrder: suppliedPhysicalOrder, selectedPhysicalInstanceId, face, interactionBusy = false, cutPreview = null, selectedPageNumber, onSelectPage, onToggleSkippedSlot, onSelectPhysicalInstance, onFaceChange, onSelectArtwork, onPhysicalAction, onReorderPhysicalInstance }: RegistrationLayoutPreviewProps) {
  const physicalOrder = suppliedPhysicalOrder ?? createPhysicalOrder(cards);
  const [uncontrolledSide, setUncontrolledSide] = useState<"front" | "back">("front");
  const previewSide = face ?? uncontrolledSide;
  const [uncontrolledSelectedInstanceId, setUncontrolledSelectedInstanceId] = useState<string | null>(null);
  const selectedInstanceId = selectedPhysicalInstanceId === undefined ? uncontrolledSelectedInstanceId : selectedPhysicalInstanceId;
  const [hudTarget, setHudTarget] = useState<ContextualHudTarget | null>(null);
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropFeedback, setDropFeedback] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [manualZoomScale, setManualZoomScale] = useState(1);
  const [zoomMode, setZoomMode] = useState<CompositorZoomMode>("fit-page");
  const sheetViewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<CompositorViewportSize>({ widthPx: 0, heightPx: 0 });
  const [layers, setLayers] = useState<Record<CompositorLayer, boolean>>({
    artwork: true, bleed: true, trim: true, cut: true, silhouette: true, registration: true, reserved: true, margins: true, calibration: true,
  });
  const paper = settings.paperFormat;
  const card = settings.cardFormat;
  const physicalCards = useMemo(() => {
    const cardsById = new Map(cards.map((entry) => [entry.id, entry]));
    const totals = new Map<string, number>();
    for (const reference of physicalOrder.instances) totals.set(reference.workingCardId, (totals.get(reference.workingCardId) ?? 0) + 1);
    const seen = new Map<string, number>();
    return physicalOrder.instances.flatMap((reference, physicalCardIndex) => {
      const entry = cardsById.get(reference.workingCardId);
      if (!entry) return [];
      const copyNumber = (seen.get(entry.id) ?? 0) + 1;
      seen.set(entry.id, copyNumber);
      return [{ id: reference.id, physicalCardIndex, workingCardId: entry.id, copyNumber, totalCopies: totals.get(entry.id) ?? entry.quantity, card: entry } satisfies PhysicalCardInstance];
    });
  }, [cards, physicalOrder]);
  const result = useMemo(() => {
    try {
      const templateGeometry = settings.layout.templateGeometry ?? cutPreview?.derivedTemplateGeometry;
      const plan = buildCanonicalPrintPlan(cardCount, {
        bleedMm: settings.bleedMm,
        paperFormat: paper,
        cardFormat: card,
        pageOrientation: settings.pageOrientation,
        cardOrientation: settings.cardOrientation,
        marginsMm: settings.marginsMm,
        horizontalGapMm: settings.horizontalGapMm,
        verticalGapMm: settings.verticalGapMm,
        registration: settings.registration,
        duplexFlipMode: settings.duplexFlipMode,
        skippedSlotIndices: settings.layout.skippedSlotIndices,
        ...(templateGeometry ? { templateGeometry } : {}),
        ...(settings.layout.rows !== undefined && settings.layout.columns !== undefined
          ? { layoutRows: settings.layout.rows, layoutColumns: settings.layout.columns }
          : {}),
      });
      return { pages: plan.pages, geometry: plan.registrationGeometry, pairing: plan.duplexPairing, error: null } as const;
    } catch (error) {
      return { pages: null, geometry: null, pairing: null, error: error instanceof Error ? error.message : "Layout inválido." } as const;
    }
  }, [settings, cardCount, paper, card, cutPreview?.derivedTemplateGeometry]);

  const pageCount = result.pages?.length ?? 1;
  const activePageIndex = Math.min(Math.max(selectedPageNumber, 1), pageCount) - 1;
  const activePage = result.pages?.[activePageIndex];
  const selectedPhysicalCardIndex = selectedInstanceId === null
    ? null
    : physicalCards.find(({ id }) => id === selectedInstanceId)?.physicalCardIndex ?? null;
  const physicalOrderSignature = physicalOrder.instances.map(({ id }) => id).join("\u0000");
  const pageLayoutSignature = result.pages?.map(({ startCardIndex, endCardIndex }) => `${startCardIndex}:${endCardIndex}`).join("|") ?? "";
  const previousSelectionLocation = useRef({
    instanceId: selectedInstanceId,
    physicalIndex: selectedPhysicalCardIndex,
    physicalOrderSignature,
    pageLayoutSignature,
  });
  const visibleSelectedPhysicalCardIndex = activePage
    && selectedPhysicalCardIndex !== null
    && selectedPhysicalCardIndex >= activePage.startCardIndex
    && selectedPhysicalCardIndex < activePage.endCardIndex
    ? selectedPhysicalCardIndex
    : null;
  useEffect(() => {
    const previous = previousSelectionLocation.current;
    const selectionMoved = selectedInstanceId !== previous.instanceId
      || physicalOrderSignature !== previous.physicalOrderSignature
      || pageLayoutSignature !== previous.pageLayoutSignature;
    if (selectionMoved && selectedPhysicalCardIndex !== null && result.pages) {
      const selectedPage = result.pages.find(({ startCardIndex, endCardIndex }) => selectedPhysicalCardIndex >= startCardIndex && selectedPhysicalCardIndex < endCardIndex);
      if (selectedPage && selectedPage.pageIndex + 1 !== selectedPageNumber) onSelectPage(selectedPage.pageIndex + 1);
    }
    previousSelectionLocation.current = {
      instanceId: selectedInstanceId,
      physicalIndex: selectedPhysicalCardIndex,
      physicalOrderSignature,
      pageLayoutSignature,
    };
  }, [selectedInstanceId, selectedPhysicalCardIndex, physicalOrderSignature, pageLayoutSignature, result.pages, selectedPageNumber, onSelectPage]);

  useEffect(() => {
    const viewport = sheetViewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const next = {
        widthPx: Math.round(viewport.clientWidth),
        heightPx: Math.round(viewport.clientHeight),
      };
      setViewportSize((current) => {
        if (current.widthPx === next.widthPx && current.heightPx === next.heightPx) return current;
        return next;
      });
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => measure());
      observer.observe(viewport);
      return () => observer.disconnect();
    }
    const handleWindowResize = () => measure();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [Boolean(result.pages)]);

  if (!result.pages || !result.geometry) {
    return <section className="registration-preview canonical-compositor" aria-label="Compositor live">
      <h2>Compositor live</h2><p className="error-message" role="alert">Layout inválido: {result.error}</p>
    </section>;
  }
  const { geometry } = result;
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
  const zoomScale = zoomMode === "fit-page" || zoomMode === "fit-width"
    ? calculateCompositorScale(zoomMode, viewportSize, page)
    : zoomMode === "100%" ? 1 : manualZoomScale;
  const fontSize = Math.min(7, page.widthMm / 35);
  const skipped = new Set(placement.gridSlots.filter(({ skippedByUser }) => skippedByUser).map(({ index }) => index));
  const assigned = new Set(placement.slots.map(({ index }) => index));
  const reserved = new Set(placement.gridSlots.filter(({ reserved: isReserved }) => isReserved).map(({ index }) => index));
  const toggle = (index: number) => onToggleSkippedSlot(index);
  const slotsCanBeSkipped = Boolean(settings.layout.templateGeometry
    || cutPreview?.derivedTemplateGeometry
    || (settings.layout.rows !== undefined && settings.layout.columns !== undefined));
  const sideCalibration = settings.printerProfileSelection?.[previewSide];
  const calibrationTransform = sideCalibration ? createPrintCalibrationTransform(page, sideCalibration, previewSide) : null;
  const calibrationMatrix = calibrationTransform && !calibrationTransform.isIdentity
    ? calibrationSvgMatrix(calibrationTransform.svgMatrix)
    : undefined;
  const visibleCalibrationMatrix = layers.calibration ? calibrationMatrix : undefined;
  const sourceCardIsLandscape = card.widthMm > card.heightMm;
  const requestedCardIsLandscape = settings.cardOrientation === undefined ? sourceCardIsLandscape : settings.cardOrientation === "landscape";
  const artworkRotationDegrees = sourceCardIsLandscape === requestedCardIsLandscape ? 0 : sourceCardIsLandscape ? -90 : 90;

  function changeZoom(mode: Exclude<CompositorZoomMode, "manual">) {
    setZoomMode(mode);
    if (mode === "100%") setManualZoomScale(1);
  }

  function stepZoom(direction: -1 | 1) {
    setZoomMode("manual");
    setManualZoomScale(stepCompositorScale(zoomScale, direction));
  }

  function previewArtwork(cardEntry: WorkingCard | undefined) {
    const bleedMm = layers.bleed ? settings.bleedMm : 0;
    const roundedCorners = settings.roundedCorners;
    const cornerRadiusMm = settings.cardFormat.cornerRadiusMm ?? 3.175;
    const sourceTrimWidthMm = settings.cardFormat.widthMm;
    const sourceTrimHeightMm = settings.cardFormat.heightMm;
    if (!cardEntry) return { url: undefined, label: "Carta sem arte selecionada", available: false };
    if (previewSide === "front") {
      const artwork = cardEntry.selectedArtworkByFace.front;
      return artwork
        ? { url: artworkPreviewUrl(artwork.candidateId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm), label: `${cardEntry.identity?.name ?? cardEntry.identityHints.name ?? "Carta"} · frente`, available: true }
        : { url: undefined, label: "Frente sem artwork selecionada", available: false };
    }
    const back = resolveBackForMissingPolicy(cardEntry, settings.projectDefaultBack, settings.missingBackPolicy);
    if (back.status !== "available") return { url: undefined, label: back.status === "intentional-none" ? "Verso intencionalmente em branco" : "Verso sem artwork disponível", available: false };
    if (back.artwork) return { url: artworkPreviewUrl(back.artwork.candidateId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm), label: `${cardEntry.identity?.name ?? cardEntry.identityHints.name ?? "Carta"} · verso`, available: true };
    if (back.asset) return {
      url: backPreviewUrl(back.asset.assetId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm),
      label: back.mode === "project-default" ? "Verso padrão do Project" : "Verso da Back Library",
      available: true,
    };
    return { url: undefined, label: "Verso sem artwork disponível", available: false };
  }

  const selectedInstance = selectedInstanceId === null
    ? undefined
    : physicalCards.find(({ id }) => id === selectedInstanceId);
  const hudInstance = hudTarget === null
    ? undefined
    : physicalCards.find(({ id, workingCardId }) => id === hudTarget.instanceId && workingCardId === hudTarget.workingCardId);
  useEffect(() => {
    if (hudTarget !== null && !hudInstance) setHudTarget(null);
  }, [hudTarget, hudInstance]);
  const selectedPageSlot = visibleSelectedPhysicalCardIndex === null
    ? undefined
    : placement.slots.find((slot) => pagePlacement.startCardIndex + slot.cardIndex! === visibleSelectedPhysicalCardIndex);
  const selectedCardName = selectedInstance
    ? selectedInstance.card.identity?.name ?? selectedInstance.card.identityHints.name ?? selectedInstance.card.importSource.filename ?? "Carta custom"
    : undefined;
  const lastAssignedGridSlot = placement.gridSlots.reduce((last, slot) => assigned.has(slot.index) ? Math.max(last, slot.index) : last, -1);

  function selectInstance(instance: PhysicalCardInstance) {
    setUncontrolledSelectedInstanceId(instance.id);
    setHudTarget(null);
    onSelectPhysicalInstance?.(instance.id, instance.workingCardId, previewSide);
  }

  function beginSlotDrag(event: DragEvent<SVGGElement>, instance: PhysicalCardInstance) {
    if (interactionBusy || !onReorderPhysicalInstance) {
      event.preventDefault();
      return;
    }
    selectInstance(instance);
    setDragSourceId(instance.id);
    setDropFeedback(null);
    setDropTargetId(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", instance.id);
  }

  function overPageDuringDrag(event: DragEvent<HTMLButtonElement>, pageNumber: number) {
    if (!dragSourceId || interactionBusy) return;
    event.preventDefault();
    onSelectPage(pageNumber);
  }

  function dropOnSlot(event: DragEvent<SVGGElement>, instance: PhysicalCardInstance | undefined, canDropAtEnd: boolean, invalidReason?: string, invalidTargetId?: string) {
    if (!dragSourceId || interactionBusy) return;
    event.preventDefault();
    if (invalidReason) {
      setDropFeedback(invalidReason);
      setDropTargetId(invalidTargetId ?? "invalid");
      return;
    }
    if (!instance && !canDropAtEnd) {
      setDropFeedback("Este slot não é um destino elegível.");
      setDropTargetId("invalid");
      return;
    }
    if (instance?.id === dragSourceId) {
      setDragSourceId(null);
      setDropFeedback(null);
      setDropTargetId(null);
      return;
    }
    onReorderPhysicalInstance?.(dragSourceId, instance?.id ?? null, "after");
    setDropFeedback(null);
    setDragSourceId(null);
    setDropTargetId(null);
  }

  function moveInstanceRelative(instance: PhysicalCardInstance, direction: "before" | "after") {
    if (!onReorderPhysicalInstance || interactionBusy) return;
    const index = physicalCards.findIndex(({ id, workingCardId }) => id === instance.id && workingCardId === instance.workingCardId);
    if (index < 0) return;
    const neighbor = direction === "before" ? physicalCards[index - 1] : physicalCards[index + 1];
    if (!neighbor) return;
    onReorderPhysicalInstance(instance.id, neighbor.id, direction);
  }

  return <section className="registration-preview canonical-compositor" aria-label="Compositor live">
    <div className="registration-preview-heading compositor-heading">
      <div><h2>Compositor live</h2><p>{settings.paperFormat.name} {settings.pageOrientation} · {settings.cardFormat.name} {card.widthMm} × {card.heightMm} mm / {settings.cardOrientation} · capacidade {placement.capacity} · página {activePageIndex + 1} de {pageCount}</p></div>
      <span>{cardCount ? `${cardCount} cartas físicas · atualiza automaticamente` : "Adicione cartas na seção Cartas para compor a folha"}</span>
    </div>
    <div className="compositor-toolbar">
      <div className="duplex-preview-controls" role="group" aria-label="Face do compositor">
        <button type="button" className={`button ${previewSide === "front" ? "primary" : "secondary"}`} aria-pressed={previewSide === "front"} onClick={() => { setUncontrolledSide("front"); onFaceChange?.("front"); }}>Frente</button>
        <button type="button" className={`button ${previewSide === "back" ? "primary" : "secondary"}`} aria-pressed={previewSide === "back"} onClick={() => { setUncontrolledSide("back"); onFaceChange?.("back"); }}>Verso</button>
      </div>
      <div className="compositor-page-controls" role="group" aria-label="Navegação de páginas">
        <button type="button" className="button secondary" aria-label="Página anterior" disabled={activePageIndex === 0} onDragOver={(event) => overPageDuringDrag(event, activePageIndex)} onClick={() => onSelectPage(activePageIndex)}>Anterior</button>
        <span aria-live="polite">Página {activePageIndex + 1} de {pageCount}</span>
        <button type="button" className="button secondary" aria-label="Próxima página" disabled={activePageIndex >= pageCount - 1} onDragOver={(event) => overPageDuringDrag(event, activePageIndex + 2)} onClick={() => onSelectPage(activePageIndex + 2)}>Próxima</button>
        {pageCount > 1 && <label className="registration-page-picker">Ir para<select aria-label="Página do compositor" value={activePageIndex + 1} onChange={(event) => onSelectPage(Number(event.currentTarget.value))}>
          {result.pages.map((entry, index) => <option key={entry.pageIndex} value={entry.pageIndex + 1}>Página {index + 1} · cartas {entry.startCardIndex + 1}–{entry.endCardIndex}</option>)}
        </select></label>}
      </div>
      <div className="compositor-zoom-controls" role="group" aria-label="Zoom do compositor">
        {([ ["fit-page", "Fit Page"], ["fit-width", "Fit Width"], ["100%", "100%"] ] as const).map(([mode, label]) => <button key={mode} type="button" className={`button ${zoomMode === mode ? "primary" : "secondary"}`} aria-pressed={zoomMode === mode} onClick={() => changeZoom(mode)}>{label}</button>)}
        <button type="button" className="button secondary" aria-label="Reduzir zoom" onClick={() => stepZoom(-1)}>−</button>
        <button type="button" className="button secondary" aria-label="Aumentar zoom" onClick={() => stepZoom(1)}>+</button>
      </div>
      <details className="compositor-layers">
        <summary>Layers</summary>
        <div role="group" aria-label="Layers do preview">
          {COMPOSITOR_LAYERS.map(({ id, label }) => <label key={id}><input type="checkbox" checked={layers[id]} onChange={(event) => { const checked = event.currentTarget.checked; setLayers((current) => ({ ...current, [id]: checked })); }} />{label}</label>)}
        </div>
      </details>
    </div>
    <p className="compositor-side-context">{previewSide === "front"
      ? "Frente física · artwork da face selecionada"
      : `Verso físico · ${pagePair.flipMode} · grade duplex pareada em coordenadas físicas`} · registration {settings.registration.type}/{settings.registration.orientation}</p>
    <p className="compositor-selected-card" aria-live="polite" data-testid="selected-physical-card" data-selected-physical-card-index={selectedInstance?.physicalCardIndex ?? "none"} data-selected-physical-instance-id={selectedInstance?.id ?? "none"}>
      {selectedInstance
        ? `Carta física ${selectedInstance.physicalCardIndex + 1} · ${selectedCardName} · cópia ${selectedInstance.copyNumber}/${selectedInstance.totalCopies}${isDoubleFacedIdentity(selectedInstance.card.identity) ? " · DFC" : ""}`
        : "Selecione uma carta física no compositor"}
      {selectedInstance && onSelectArtwork && <button
        type="button"
        className="button secondary compositor-select-artwork"
        data-testid="compositor-select-artwork"
        onClick={(event) => onSelectArtwork(selectedInstance.workingCardId, selectedInstance.id, selectedInstance.physicalCardIndex, previewSide, event.currentTarget, selectedInstance.copyNumber, selectedInstance.totalCopies)}
      >Selecionar arte</button>}
      {selectedInstance && onPhysicalAction && <button type="button" className="button secondary compositor-hud-open" aria-label={`Mais ações para ${selectedCardName}, cópia ${selectedInstance.copyNumber}`} aria-expanded={hudInstance?.id === selectedInstance.id && hudInstance.workingCardId === selectedInstance.workingCardId} onClick={() => setHudTarget((current) => current?.instanceId === selectedInstance.id && current.workingCardId === selectedInstance.workingCardId ? null : { instanceId: selectedInstance.id, workingCardId: selectedInstance.workingCardId })}>…</button>}
      {selectedPageSlot && slotsCanBeSkipped && previewSide === "front" && <button type="button" className="link-button" onClick={() => toggle(selectedPageSlot.index)}>Desativar slot da carta selecionada</button>}
    </p>
    {dropFeedback && <p role="status" className="compositor-drop-feedback">{dropFeedback}</p>}
    {hudInstance && onPhysicalAction && <section className="compositor-instance-hud" aria-label={`Ações para ${hudInstance.card.identity?.name ?? hudInstance.card.identityHints.name ?? "Carta"}, cópia ${hudInstance.copyNumber}`} data-testid="compositor-instance-hud">
      <div><strong>{hudInstance.card.identity?.name ?? hudInstance.card.identityHints.name ?? "Carta custom"}</strong><span>Cópia {hudInstance.copyNumber}/{hudInstance.totalCopies} · Carta física {hudInstance.physicalCardIndex + 1} · {previewSide === "front" ? "Front" : "Back"}{isDoubleFacedIdentity(hudInstance.card.identity) ? " · DFC" : ""}</span></div>
      <div className="compositor-hud-actions">
        <button type="button" disabled={interactionBusy} onClick={(event) => onSelectArtwork?.(hudInstance.workingCardId, hudInstance.id, hudInstance.physicalCardIndex, previewSide, event.currentTarget, hudInstance.copyNumber, hudInstance.totalCopies)}>Selecionar arte</button>
        <button type="button" disabled={interactionBusy} onClick={(event) => onSelectArtwork?.(hudInstance.workingCardId, hudInstance.id, hudInstance.physicalCardIndex, "back", event.currentTarget, hudInstance.copyNumber, hudInstance.totalCopies)}>Configurar verso / face · Back</button>
        <button type="button" disabled={interactionBusy} onClick={() => onPhysicalAction("increase", hudInstance.id, hudInstance.workingCardId)}>Aumentar quantidade</button>
        <button type="button" disabled={interactionBusy} onClick={() => onPhysicalAction("remove-copy", hudInstance.id, hudInstance.workingCardId)}>Remover uma cópia</button>
        <button type="button" disabled={interactionBusy} onClick={() => onPhysicalAction("duplicate-copy", hudInstance.id, hudInstance.workingCardId)}>Duplicar como entrada independente</button>
        <button type="button" disabled={interactionBusy} onClick={() => onPhysicalAction("delete-entry", hudInstance.id, hudInstance.workingCardId)}>Remover carta inteira ({hudInstance.totalCopies} cópia(s))</button>
        <button type="button" disabled={interactionBusy} onClick={() => onPhysicalAction("open-settings", hudInstance.id, hudInstance.workingCardId)}>Configurações completas</button>
        <button type="button" disabled={interactionBusy || hudInstance.physicalCardIndex === 0} onClick={() => moveInstanceRelative(hudInstance, "before")}>Mover antes</button>
        <button type="button" disabled={interactionBusy || hudInstance.physicalCardIndex >= physicalCards.length - 1} onClick={() => moveInstanceRelative(hudInstance, "after")}>Mover depois</button>
        <button type="button" onClick={() => setHudTarget(null)}>Fechar ações</button>
      </div>
    </section>}
    <p className="muted compositor-calibration-context" data-calibration-profile-version={settings.printerProfileSelection?.version ?? "none"}>
      {settings.printerProfileSelection
        ? <>Perfil {settings.printerProfileSelection.name} v{settings.printerProfileSelection.version} · {settings.printerDuplexMode} · {previewSide === "front" ? "frente" : "verso"}: ΔX {settings.printerProfileSelection[previewSide].offsetXUm} µm, ΔY {settings.printerProfileSelection[previewSide].offsetYUm} µm, rotação {settings.printerProfileSelection[previewSide].rotationDeg}°, escala {settings.printerProfileSelection[previewSide].scaleX}/{settings.printerProfileSelection[previewSide].scaleY}, skew {settings.printerProfileSelection[previewSide].skewXDeg ?? 0}°/{settings.printerProfileSelection[previewSide].skewYDeg ?? 0}° · {calibrationTransform ? layers.calibration ? "transformação calibrada visível" : "geometria nominal visível" : "transformação identidade"}.</>
        : <>Sem perfil de calibração selecionado; geometria nominal visível.</>} Conteúdo impresso segue a calibração; paths SVG/DXF de Silhouette permanecem nominais.
    </p>
    <div className="compositor-sheet-scroll" ref={sheetViewportRef}>
      <svg className="registration-sheet-preview compositor-sheet" style={{ width: `${page.widthMm * COMPOSITOR_CSS_PX_PER_MM * zoomScale}px`, height: `${page.heightMm * COMPOSITOR_CSS_PX_PER_MM * zoomScale}px`, maxWidth: "none", maxHeight: "none" }} viewBox={`0 0 ${page.widthMm} ${page.heightMm}`} role="group" aria-label={`Compositor live ${previewSide === "front" ? "frente" : "verso"} ${settings.paperFormat.name} ${settings.pageOrientation}, página ${activePageIndex + 1} de ${pageCount}`} data-compositor-page={activePageIndex + 1} data-selected-physical-card-index={visibleSelectedPhysicalCardIndex ?? "none"} data-compositor-bleed-mm={settings.bleedMm} data-compositor-calibration-matrix={visibleCalibrationMatrix ?? "identity"} data-compositor-profile-version={settings.printerProfileSelection?.version ?? "none"} data-compositor-printer-mode={settings.printerDuplexMode} data-compositor-zoom-mode={zoomMode} data-compositor-zoom-scale={zoomScale}>
        <defs>
          {placement.gridSlots.filter(({ cardIndex }) => cardIndex !== undefined).map((slot) => {
            const centerX = slot.trim.xMm + slot.trim.widthMm / 2;
            const centerY = slot.trim.yMm + slot.trim.heightMm / 2;
            const radius = settings.roundedCorners ? settings.cardFormat.cornerRadiusMm ?? 3.175 : 0;
            const previewBleed = layers.bleed ? settings.bleedMm : 0;
            const sourceWidth = card.widthMm + 2 * previewBleed;
            const sourceHeight = card.heightMm + 2 * previewBleed;
            const clipId = `compositor-${activePageIndex}-${previewSide}-${slot.index}`;
            return <clipPath key={`clip-${clipId}`} id={clipId} clipPathUnits="userSpaceOnUse">
              <rect
                x={artworkRotationDegrees ? centerX - sourceWidth / 2 : layers.bleed ? slot.slotXmm : slot.trim.xMm}
                y={artworkRotationDegrees ? centerY - sourceHeight / 2 : layers.bleed ? slot.slotYmm : slot.trim.yMm}
                width={artworkRotationDegrees ? sourceWidth : layers.bleed ? slot.slotWidthMm : slot.trim.widthMm}
                height={artworkRotationDegrees ? sourceHeight : layers.bleed ? slot.slotHeightMm : slot.trim.heightMm}
                rx={radius}
                ry={radius}
              />
            </clipPath>;
          })}
        </defs>
        <rect x="0" y="0" width={page.widthMm} height={page.heightMm} fill="#fff" stroke="#64748b" strokeWidth="0.5" />
        {layers.margins && <g data-compositor-layer="margins" transform={cutOverlayTransform}><rect x={settings.marginsMm.left} y={settings.marginsMm.top} width={page.widthMm - settings.marginsMm.left - settings.marginsMm.right} height={page.heightMm - settings.marginsMm.top - settings.marginsMm.bottom} fill="#f8fafc" fillOpacity="0.18" stroke="#64748b" strokeWidth="0.35" strokeDasharray="2 1.2" /></g>}
        {layers.reserved && <g data-compositor-layer="reserved" transform={visibleCalibrationMatrix}>{registrationForPage.reservedZones.map((zone, index) => <rect key={`reserved-${index}`} x={zone.xMm} y={zone.yMm} width={zone.widthMm} height={zone.heightMm} fill="#fecaca" fillOpacity="0.75" stroke="#dc2626" strokeWidth="0.7" strokeDasharray="2 1" />)}</g>}
        {layers.silhouette && <g data-compositor-layer="silhouette" data-duplex-silhouette={previewSide} transform={cutOverlayTransform}>{(cutPreviewPage?.geometry ?? cutPreview?.geometry)?.paths.map((path) => {
          const state = (cutPreviewPage?.slotPaths ?? cutPreview?.slotPaths ?? []).find(({ pathId }) => pathId === path.id)?.state ?? "empty";
          const active = state === "active";
          const skippedPath = state === "skipped";
          return <path key={`source-cut-${path.id}`} d={cutPathToSvgD(path)} fill="none" stroke={active ? "#dc2626" : skippedPath ? "#7e22ce" : state === "reserved" ? "#ea5800" : "#64748b"} strokeWidth={active ? "0.65" : "0.4"} strokeDasharray={active ? undefined : "1.5 1"} opacity={active ? "0.95" : "0.75"} data-cut-slot-state={state} aria-label={`Cut path ${path.id}: ${state}`} />;
        })}</g>}
        <g transform={visibleCalibrationMatrix} data-calibrated-print-content={layers.calibration ? "true" : "false"}>
          {placement.gridSlots.map((slot) => {
            const physicalCardIndex = slot.cardIndex === undefined ? undefined : pagePlacement.startCardIndex + slot.cardIndex;
            const physicalInstance = physicalCardIndex === undefined ? undefined : physicalCards[physicalCardIndex];
            const isSelected = physicalInstance?.id === selectedInstanceId;
            const cardName = physicalInstance
              ? physicalInstance.card.identity?.name ?? physicalInstance.card.identityHints.name ?? physicalInstance.card.importSource.filename ?? "Carta custom"
              : undefined;
            const canToggleSkippedSlot = slotsCanBeSkipped
              && previewSide === "front"
              && !physicalInstance
              && !reserved.has(slot.index);
            const canDropAtEnd = !physicalInstance && activePageIndex === pageCount - 1 && !skipped.has(slot.index)
              && !reserved.has(slot.index) && slot.index > lastAssignedGridSlot;
            const invalidDropReason = skipped.has(slot.index)
              ? "Drop rejeitado: slot ignorado não recebe cartas."
              : reserved.has(slot.index)
                ? "Drop rejeitado: slot reservado permanece vazio."
                : !physicalInstance && !canDropAtEnd ? "Drop rejeitado: somente um slot elegível vazio após a última carta pode receber a cópia." : undefined;
            const invalidDropTargetId = `invalid:${activePageIndex}:${slot.index}`;
            const canSelectCard = Boolean(physicalInstance);
            const role = canSelectCard || canToggleSkippedSlot ? "button" : undefined;
            const label = physicalInstance
              ? `Slot ${slot.index + 1} · carta física ${physicalCardIndex! + 1} · ${cardName} · cópia ${physicalInstance.copyNumber} de ${physicalInstance.totalCopies}`
              : `Slot ${slot.index + 1}${skipped.has(slot.index) ? " desativado" : reserved.has(slot.index) ? " reservado" : " vazio"}`;
            const activate = () => {
              if (physicalInstance) selectInstance(physicalInstance);
              else if (canToggleSkippedSlot) toggle(slot.index);
            };
            return <g
              key={`slot-${slot.index}`}
              {...(role ? { role, tabIndex: 0 } : {})}
              aria-label={label}
              {...(role ? { "aria-pressed": physicalInstance ? isSelected : skipped.has(slot.index) } : {})}
              data-physical-card-index={physicalCardIndex}
              data-physical-instance-id={physicalInstance?.id}
              data-working-card-id={physicalInstance?.workingCardId}
              data-copy-number={physicalInstance?.copyNumber}
              data-copy-count={physicalInstance?.totalCopies}
              data-slot-x-mm={slot.trim.xMm}
              data-slot-y-mm={slot.trim.yMm}
              {...(role ? {
                onClick: activate,
                onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activate();
                  }
                },
              } : {})}
              {...({ draggable: Boolean(physicalInstance && onReorderPhysicalInstance && !interactionBusy) } as Record<string, boolean>)}
              onDragStart={physicalInstance ? (event) => beginSlotDrag(event, physicalInstance) : undefined}
              onDragEnd={() => { setDragSourceId(null); setDropTargetId(null); }}
              onDragOver={(event) => {
                if (!dragSourceId || interactionBusy) return;
                event.preventDefault();
                setDropTargetId(invalidDropReason ? invalidDropTargetId : physicalInstance?.id ?? "end");
                setDropFeedback(invalidDropReason ?? (physicalInstance ? "Solte para inserir esta cópia depois da carta de destino." : "Solte para mover esta cópia para o final."));
              }}
              onDrop={(event) => dropOnSlot(event, physicalInstance, canDropAtEnd, invalidDropReason, invalidDropTargetId)}
              onContextMenu={(event) => {
                if (!physicalInstance || !onPhysicalAction) return;
                event.preventDefault();
                selectInstance(physicalInstance);
                setHudTarget({ instanceId: physicalInstance.id, workingCardId: physicalInstance.workingCardId });
              }}
              className={`registration-preview-slot ${previewSide === "back" ? "is-back" : ""} ${isSelected ? "is-selected" : ""} ${dropTargetId === physicalInstance?.id || dropTargetId === "end" && canDropAtEnd ? "is-drop-target" : ""} ${dropTargetId === invalidDropTargetId ? "is-invalid-drop" : ""} ${dragSourceId === physicalInstance?.id ? "is-drag-source" : ""}`}
            >
            {layers.bleed && <rect x={slot.slotXmm} y={slot.slotYmm} width={slot.slotWidthMm} height={slot.slotHeightMm} fill="#dbeafe" fillOpacity="0.72" stroke="#2563eb" strokeWidth="0.25" strokeDasharray="1.2 0.8" data-compositor-layer="bleed" />}
            {skipped.has(slot.index) && <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill="#f3e8ff" stroke="#7e22ce" strokeWidth={layers.trim ? "0.6" : "0"} />}
            {assigned.has(slot.index) && (() => {
              const physicalCard = physicalInstance?.card;
              const centerX = slot.trim.xMm + slot.trim.widthMm / 2;
              const centerY = slot.trim.yMm + slot.trim.heightMm / 2;
              const artwork = previewArtwork(physicalCard);
              const name = physicalCard?.identity?.name ?? physicalCard?.identityHints.name ?? physicalCard?.importSource.filename ?? "Custom card";
              const dfcLabel = physicalCard && isDoubleFacedIdentity(physicalCard.identity) ? " · DFC" : "";
              const clipId = `compositor-${activePageIndex}-${previewSide}-${slot.index}`;
              const duplexRotationDegrees = previewSide === "back" ? pagePair.backPageTransform.artworkOrientation.rotationDegrees : 0;
              const rotateArtwork = [
                ...(artworkRotationDegrees ? [`rotate(${artworkRotationDegrees} ${centerX} ${centerY})`] : []),
                ...(duplexRotationDegrees ? [`rotate(${duplexRotationDegrees} ${centerX} ${centerY})`] : []),
              ].join(" ") || undefined;
              const previewBleed = layers.bleed ? settings.bleedMm : 0;
              const sourceWidth = card.widthMm + 2 * previewBleed;
              const sourceHeight = card.heightMm + 2 * previewBleed;
              return <>
                <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill={artwork.available ? "#e2e8f0" : "#f1f5f9"} />
                {!layers.artwork || !artwork.available ? <g>
                  <text x={centerX} y={slot.trim.yMm + slot.trim.heightMm * 0.42} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize * 0.82} fill="#1e3a8a">{name.slice(0, 20)}{dfcLabel}</text>
                  {!artwork.available && <text x={centerX} y={slot.trim.yMm + slot.trim.heightMm * 0.58} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize * 0.62} fill="#475569">{artwork.label}</text>}
                </g> : artwork.url && <image
                  href={artwork.url}
                  x={artworkRotationDegrees ? centerX - sourceWidth / 2 : layers.bleed ? slot.slotXmm : slot.trim.xMm}
                  y={artworkRotationDegrees ? centerY - sourceHeight / 2 : layers.bleed ? slot.slotYmm : slot.trim.yMm}
                  width={artworkRotationDegrees ? sourceWidth : layers.bleed ? slot.slotWidthMm : slot.trim.widthMm}
                  height={artworkRotationDegrees ? sourceHeight : layers.bleed ? slot.slotHeightMm : slot.trim.heightMm}
                  preserveAspectRatio="none"
                  clipPath={`url(#${clipId})`}
                  transform={rotateArtwork}
                  role="img"
                  aria-label={artwork.label}
                  data-compositor-artwork={previewSide === "front" ? physicalCard?.selectedArtworkByFace.front?.candidateId ?? artwork.url : physicalCard?.selectedArtworkByFace.back?.candidateId ?? physicalCard?.manualBackArtwork?.candidateId ?? artwork.url}
                  data-compositor-source="preview-thumbnail"
                />}
                {!artwork.available && previewSide === "back" && <text x={centerX} y={slot.trim.yMm + slot.trim.heightMm * 0.76} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize * 0.62} fill="#475569">VERSO INDISPONÍVEL</text>}
              </>;
            })()}
            {layers.trim && assigned.has(slot.index) && <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill="none" stroke="#1d4ed8" strokeWidth="0.45" data-compositor-layer="trim" />}
            {isSelected && <rect
              className="compositor-selection-outline"
              x={slot.trim.xMm}
              y={slot.trim.yMm}
              width={slot.trim.widthMm}
              height={slot.trim.heightMm}
              rx={settings.roundedCorners ? settings.cardFormat.cornerRadiusMm ?? 3.175 : 0}
              ry={settings.roundedCorners ? settings.cardFormat.cornerRadiusMm ?? 3.175 : 0}
              fill="none"
              stroke="#7e22ce"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
              data-compositor-selection-outline={physicalCardIndex}
            />}
            {skipped.has(slot.index) && <>
              <line x1={slot.trim.xMm} y1={slot.trim.yMm} x2={slot.trim.xMm + slot.trim.widthMm} y2={slot.trim.yMm + slot.trim.heightMm} stroke="#7e22ce" strokeWidth="1" />
              <line x1={slot.trim.xMm + slot.trim.widthMm} y1={slot.trim.yMm} x2={slot.trim.xMm} y2={slot.trim.yMm + slot.trim.heightMm} stroke="#7e22ce" strokeWidth="1" />
            </>}
            {!assigned.has(slot.index) && !skipped.has(slot.index) && <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill="#f8fafc" stroke="#cbd5e1" strokeWidth="0.35" strokeDasharray="1 1" data-compositor-empty-slot="true" />}
            </g>;
          })}
          {layers.cut && <g data-compositor-layer="cut" data-duplex-cut-overlay={previewSide} transform={cutOverlayTransform}>
            {cutGeometry.trimSegments.map((segment, index) => <line key={`cut-${index}`} x1={segment.x1Mm} y1={segment.y1Mm} x2={segment.x2Mm} y2={segment.y2Mm} stroke="#2563eb" strokeWidth="0.2" />)}
            {cutGeometry.externalSegments.map((segment, index) => <line key={`external-cut-${index}`} x1={segment.x1Mm} y1={segment.y1Mm} x2={segment.x2Mm} y2={segment.y2Mm} stroke="#111827" strokeWidth="0.2" />)}
          </g>}
          {layers.registration && <g data-compositor-layer="registration">{registrationForPage.marks.flatMap((mark) => mark.primitives.map((primitive, index) => primitiveElement(primitive, `${mark.id}-${index}`)))}</g>}
        </g>
      </svg>
    </div>
    {!slotsCanBeSkipped && <p className="muted">Defina linhas e colunas antes de desativar slots.</p>}
    {previewSide === "back" && <p className="muted">O verso mantém a mesma página física e o pareamento duplex. Registration, cut paths e calibration acompanham a geometria refletida da folha; a orientação da artwork segue o modo {pagePair.flipMode}.</p>}
    <div className="registration-preview-legend"><span><i className="legend-bleed" /> Bleed</span><span><i className="legend-trim" /> Trim/card</span><span><i className="legend-cut-source" /> Cut path</span><span><i className="legend-skipped" /> Skipped slot/path</span><span><i className="legend-reserved" /> Reserved zone</span><span><i className="legend-mark" /> Registration mark</span></div>
  </section>;
}
