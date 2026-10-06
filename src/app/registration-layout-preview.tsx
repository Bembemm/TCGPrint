"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
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
import type { FocusableElement } from "./artwork-picker-dialog";

interface RegistrationLayoutPreviewProps {
  readonly settings: ProjectSettingsV2;
  readonly cardCount: number;
  readonly cards: readonly WorkingCard[];
  readonly physicalOrder?: PhysicalOrder;
  readonly activePhysicalInstanceId?: string | null;
  readonly selectedPhysicalInstanceIds?: ReadonlySet<string>;
  readonly face?: "front" | "back";
  readonly interactionBusy?: boolean;
  readonly documentRevision?: number;
  readonly cutPreview?: CutPreviewDto | null;
  readonly selectedPageNumber: number;
  readonly onSelectPage: (pageNumber: number) => void;
  readonly onToggleSkippedSlot: (index: number) => void;
  readonly onActivatePhysicalInstance?: (instanceId: string, cardId: string, side: "front" | "back") => void;
  readonly onTogglePhysicalInstanceSelection?: (instanceId: string) => void;
  readonly onSelectAllPhysicalInstances?: (instanceIds: readonly string[]) => void;
  readonly onClearPhysicalInstanceSelection?: () => void;
  readonly onFaceChange?: (side: "front" | "back") => void;
  readonly onSelectArtwork?: (cardId: string, instanceId: string, physicalCardIndex: number, side: "front" | "back", opener: FocusableElement, copyNumber: number, totalCopies: number) => void;
  readonly onPhysicalAction?: (action: "increase" | "remove-copy" | "duplicate-copy" | "delete-entry" | "open-settings", instanceId: string, cardId: string) => void;
  readonly onReorderPhysicalInstance?: (instanceId: string, targetInstanceId: string | null, placement: "before" | "after") => void;
}

const EMPTY_PHYSICAL_INSTANCE_IDS: ReadonlySet<string> = new Set();

type CompositorLayer = "artwork" | "bleed" | "trim" | "cut" | "silhouette" | "registration" | "reserved" | "margins" | "calibration";
interface PhysicalCardInstance {
  readonly id: string;
  readonly physicalCardIndex: number;
  readonly workingCardId: string;
  readonly copyNumber: number;
  readonly totalCopies: number;
  readonly card: WorkingCard;
}

interface ContextMenuTarget {
  readonly instanceId: string;
  readonly workingCardId: string;
  readonly documentRevision: number;
  readonly x: number;
  readonly y: number;
  readonly opener: FocusableElement;
  readonly token: number;
}

interface LocalFaceOverrideState {
  readonly documentRevision: number;
  readonly byInstanceId: Readonly<Record<string, "front" | "back">>;
}

const EMPTY_LOCAL_FACE_OVERRIDES: Readonly<Record<string, "front" | "back">> = {};

interface ContextMenuPlacement {
  readonly instanceId: string;
  readonly left: number;
  readonly top: number;
  readonly ready: boolean;
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

export default function RegistrationLayoutPreview({ settings, cardCount, cards, physicalOrder: suppliedPhysicalOrder, activePhysicalInstanceId = null, selectedPhysicalInstanceIds = EMPTY_PHYSICAL_INSTANCE_IDS, face, interactionBusy = false, documentRevision = 0, cutPreview = null, selectedPageNumber, onSelectPage, onToggleSkippedSlot, onActivatePhysicalInstance, onTogglePhysicalInstanceSelection, onSelectAllPhysicalInstances, onClearPhysicalInstanceSelection, onFaceChange, onSelectArtwork, onPhysicalAction, onReorderPhysicalInstance }: RegistrationLayoutPreviewProps) {
  const physicalOrder = suppliedPhysicalOrder ?? createPhysicalOrder(cards);
  const [uncontrolledSide, setUncontrolledSide] = useState<"front" | "back">("front");
  const previewSide = face ?? uncontrolledSide;
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);
  const [contextMenuPlacement, setContextMenuPlacement] = useState<ContextMenuPlacement | null>(null);
  const [localFaceOverrideState, setLocalFaceOverrideState] = useState<LocalFaceOverrideState>(() => ({ documentRevision, byInstanceId: {} }));
  const localFaceOverrideByInstanceId = localFaceOverrideState.documentRevision === documentRevision
    ? localFaceOverrideState.byInstanceId
    : EMPTY_LOCAL_FACE_OVERRIDES;
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const interactionControlPointerDownRef = useRef(false);
  const suppressNextBodyActivationRef = useRef(false);
  const contextMenuTokenRef = useRef(0);
  const contextMenuElementRef = useRef<HTMLDivElement | null>(null);
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
  const physicalInstanceIdsSignature = physicalCards.map(({ id }) => id).join("\u0000");
  const contextMenuInstance = contextMenu === null || contextMenu.documentRevision !== documentRevision
    ? undefined
    : physicalCards.find(({ id, workingCardId }) => id === contextMenu.instanceId && workingCardId === contextMenu.workingCardId);
  const activeInstance = activePhysicalInstanceId === null
    ? undefined
    : physicalCards.find(({ id }) => id === activePhysicalInstanceId);
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
  const activePhysicalCardIndex = activePhysicalInstanceId === null
    ? null
    : physicalCards.find(({ id }) => id === activePhysicalInstanceId)?.physicalCardIndex ?? null;
  const physicalOrderSignature = physicalOrder.instances.map(({ id }) => id).join("\u0000");
  const pageLayoutSignature = result.pages?.map(({ startCardIndex, endCardIndex }) => `${startCardIndex}:${endCardIndex}`).join("|") ?? "";
  const previousPreviewSideRef = useRef(previewSide);
  const previousPageIndexRef = useRef(activePageIndex);
  const previousDocumentRevisionRef = useRef(documentRevision);
  useEffect(() => {
    const existingIds = new Set(physicalCards.map(({ id }) => id));
    setLocalFaceOverrideState((current) => {
      const overrides = current.documentRevision === documentRevision ? current.byInstanceId : EMPTY_LOCAL_FACE_OVERRIDES;
      const next = Object.fromEntries(Object.entries(overrides).filter(([instanceId]) => existingIds.has(instanceId)));
      return current.documentRevision === documentRevision && Object.keys(next).length === Object.keys(overrides).length
        ? current
        : { documentRevision, byInstanceId: next };
    });
  }, [physicalInstanceIdsSignature, documentRevision]);
  useEffect(() => {
    if (previousPreviewSideRef.current !== previewSide) {
      previousPreviewSideRef.current = previewSide;
      setLocalFaceOverrideState({ documentRevision, byInstanceId: {} });
      setContextMenu(null);
    }
  }, [previewSide]);
  useEffect(() => {
    if (previousPageIndexRef.current !== activePageIndex) {
      previousPageIndexRef.current = activePageIndex;
      setContextMenu(null);
    }
  }, [activePageIndex]);
  useEffect(() => {
    if (previousDocumentRevisionRef.current !== documentRevision) {
      previousDocumentRevisionRef.current = documentRevision;
      setLocalFaceOverrideState({ documentRevision, byInstanceId: {} });
      setContextMenu(null);
    }
  }, [documentRevision]);
  useEffect(() => {
    if (contextMenu !== null && !contextMenuInstance) setContextMenu(null);
  }, [contextMenu, contextMenuInstance]);
  useEffect(() => {
    if (!contextMenu) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && contextMenuElementRef.current?.contains(target)) return;
      setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu?.token]);
  useEffect(() => {
    if (!contextMenu || !contextMenuInstance) return;
    const menu = contextMenuElementRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const edge = 8;
    const left = Math.min(Math.max(edge, contextMenu.x), Math.max(edge, window.innerWidth - width - edge));
    const top = Math.min(Math.max(edge, contextMenu.y), Math.max(edge, window.innerHeight - height - edge));
    setContextMenuPlacement((current) => current?.instanceId === contextMenu.instanceId
      && current.left === left && current.top === top && current.ready
      ? current
      : { instanceId: contextMenu.instanceId, left, top, ready: true });
    const firstItem = menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    firstItem?.focus();
  }, [contextMenu?.token, contextMenu?.x, contextMenu?.y, contextMenuInstance?.copyNumber, contextMenuInstance?.totalCopies]);
  const previousSelectionLocation = useRef({
    instanceId: activePhysicalInstanceId,
    physicalIndex: activePhysicalCardIndex,
    physicalOrderSignature,
    pageLayoutSignature,
  });
  const visibleActivePhysicalCardIndex = activePage
    && activePhysicalCardIndex !== null
    && activePhysicalCardIndex >= activePage.startCardIndex
    && activePhysicalCardIndex < activePage.endCardIndex
    ? activePhysicalCardIndex
    : null;
  useEffect(() => {
    const previous = previousSelectionLocation.current;
    const selectionMoved = activePhysicalInstanceId !== previous.instanceId
      || physicalOrderSignature !== previous.physicalOrderSignature
      || pageLayoutSignature !== previous.pageLayoutSignature;
    if (selectionMoved && activePhysicalCardIndex !== null && result.pages) {
      const activePage = result.pages.find(({ startCardIndex, endCardIndex }) => activePhysicalCardIndex >= startCardIndex && activePhysicalCardIndex < endCardIndex);
      if (activePage && activePage.pageIndex + 1 !== selectedPageNumber) onSelectPage(activePage.pageIndex + 1);
    }
    previousSelectionLocation.current = {
      instanceId: activePhysicalInstanceId,
      physicalIndex: activePhysicalCardIndex,
      physicalOrderSignature,
      pageLayoutSignature,
    };
  }, [activePhysicalInstanceId, activePhysicalCardIndex, physicalOrderSignature, pageLayoutSignature, result.pages, selectedPageNumber, onSelectPage]);

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

  function previewArtwork(cardEntry: WorkingCard | undefined, side: "front" | "back" = previewSide) {
    const bleedMm = layers.bleed ? settings.bleedMm : 0;
    const roundedCorners = settings.roundedCorners;
    const cornerRadiusMm = settings.cardFormat.cornerRadiusMm ?? 3.175;
    const sourceTrimWidthMm = settings.cardFormat.widthMm;
    const sourceTrimHeightMm = settings.cardFormat.heightMm;
    if (!cardEntry) return { url: undefined, label: "Carta sem arte selecionada", available: false, referenceId: undefined };
    if (side === "front") {
      const artwork = cardEntry.selectedArtworkByFace.front;
      return artwork
        ? { url: artworkPreviewUrl(artwork.candidateId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm), label: `${cardEntry.identity?.name ?? cardEntry.identityHints.name ?? "Carta"} · frente`, available: true, referenceId: artwork.candidateId }
        : { url: undefined, label: "Frente sem artwork selecionada", available: false, referenceId: undefined };
    }
    const back = resolveBackForMissingPolicy(cardEntry, settings.projectDefaultBack, settings.missingBackPolicy);
    if (back.status !== "available") return { url: undefined, label: back.status === "intentional-none" ? "Verso intencionalmente em branco" : "Verso sem artwork disponível", available: false, referenceId: undefined };
    if (back.artwork) return { url: artworkPreviewUrl(back.artwork.candidateId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm), label: `${cardEntry.identity?.name ?? cardEntry.identityHints.name ?? "Carta"} · verso`, available: true, referenceId: back.artwork.candidateId };
    if (back.asset) return {
      url: backPreviewUrl(back.asset.assetId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm),
      label: back.mode === "project-default" ? "Verso padrão do Project" : "Verso da Back Library",
      available: true,
      referenceId: backPreviewUrl(back.asset.assetId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm),
    };
    return { url: undefined, label: "Verso sem artwork disponível", available: false, referenceId: undefined };
  }

  const activePageSlot = visibleActivePhysicalCardIndex === null
    ? undefined
    : placement.slots.find((slot) => pagePlacement.startCardIndex + slot.cardIndex! === visibleActivePhysicalCardIndex);
  const activeCardName = activeInstance
    ? activeInstance.card.identity?.name ?? activeInstance.card.identityHints.name ?? activeInstance.card.importSource.filename ?? "Carta custom"
    : undefined;
  const lastAssignedGridSlot = placement.gridSlots.reduce((last, slot) => assigned.has(slot.index) ? Math.max(last, slot.index) : last, -1);

  function activateInstance(instance: PhysicalCardInstance) {
    setContextMenu(null);
    onActivatePhysicalInstance?.(instance.id, instance.workingCardId, previewSide);
  }

  function openContextMenu(instance: PhysicalCardInstance, x: number, y: number, opener: FocusableElement) {
    activateInstance(instance);
    const token = ++contextMenuTokenRef.current;
    setContextMenuPlacement({ instanceId: instance.id, left: x, top: y, ready: false });
    setContextMenu({ instanceId: instance.id, workingCardId: instance.workingCardId, documentRevision, x, y, opener, token });
  }

  function closeContextMenu(restoreFocus = false) {
    const opener = contextMenu?.opener;
    setContextMenu(null);
    if (!restoreFocus) return;
    window.setTimeout(() => {
      const target = opener?.isConnected ? opener : sheetViewportRef.current;
      target?.focus();
    }, 0);
  }

  function openPickerForInstance(instance: PhysicalCardInstance, side: "front" | "back", opener: FocusableElement) {
    closeContextMenu(false);
    if (!interactionBusy) onSelectArtwork?.(instance.workingCardId, instance.id, instance.physicalCardIndex, side, opener, instance.copyNumber, instance.totalCopies);
  }

  function activateBody(instance: PhysicalCardInstance, opener: SVGRectElement) {
    if (suppressNextBodyActivationRef.current) {
      suppressNextBodyActivationRef.current = false;
      return;
    }
    activateInstance(instance);
    const displayedSide = localFaceOverrideByInstanceId[instance.id] ?? previewSide;
    openPickerForInstance(instance, displayedSide, opener);
  }

  function toggleLocalFace(instance: PhysicalCardInstance) {
    const currentSide = localFaceOverrideByInstanceId[instance.id] ?? previewSide;
    const nextSide = currentSide === "front" ? "back" : "front";
    if (!previewArtwork(instance.card, nextSide).available) return;
    setLocalFaceOverrideState((current) => {
      const overrides = current.documentRevision === documentRevision ? current.byInstanceId : EMPTY_LOCAL_FACE_OVERRIDES;
      const next = { ...overrides };
      if (nextSide === previewSide) delete next[instance.id];
      else next[instance.id] = nextSide;
      return { documentRevision, byInstanceId: next };
    });
  }

  function handleContextMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu(true);
      return;
    }
    const items = Array.from(contextMenuElementRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      items[nextIndex]?.focus();
    }
  }

  function runPhysicalMenuAction(action: "increase" | "remove-copy" | "duplicate-copy" | "delete-entry" | "open-settings") {
    if (!contextMenuInstance || !onPhysicalAction || interactionBusy) return;
    closeContextMenu(action !== "open-settings");
    onPhysicalAction(action, contextMenuInstance.id, contextMenuInstance.workingCardId);
  }

  function beginSlotDrag(event: DragEvent<SVGGElement>, instance: PhysicalCardInstance) {
    if (interactionBusy || !onReorderPhysicalInstance) {
      event.preventDefault();
      return;
    }
    suppressNextBodyActivationRef.current = true;
    activateInstance(instance);
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
    <p className="compositor-active-card" aria-live="polite" data-testid="active-physical-card" data-active-physical-card-index={activeInstance?.physicalCardIndex ?? "none"} data-active-physical-instance-id={activeInstance?.id ?? "none"}>
      {activeInstance
        ? `Carta física ${activeInstance.physicalCardIndex + 1} · ${activeCardName} · cópia ${activeInstance.copyNumber}/${activeInstance.totalCopies}${isDoubleFacedIdentity(activeInstance.card.identity) ? " · DFC" : ""}`
        : "Selecione uma carta física no compositor"}
      {activePageSlot && slotsCanBeSkipped && previewSide === "front" && <button type="button" className="link-button" onClick={() => toggle(activePageSlot.index)}>Desativar slot da carta ativa</button>}
    </p>
    {dropFeedback && <p role="status" className="compositor-drop-feedback">{dropFeedback}</p>}
    <p className="muted compositor-calibration-context" data-calibration-profile-version={settings.printerProfileSelection?.version ?? "none"}>
      {settings.printerProfileSelection
        ? <>Perfil {settings.printerProfileSelection.name} v{settings.printerProfileSelection.version} · {settings.printerDuplexMode} · {previewSide === "front" ? "frente" : "verso"}: ΔX {settings.printerProfileSelection[previewSide].offsetXUm} µm, ΔY {settings.printerProfileSelection[previewSide].offsetYUm} µm, rotação {settings.printerProfileSelection[previewSide].rotationDeg}°, escala {settings.printerProfileSelection[previewSide].scaleX}/{settings.printerProfileSelection[previewSide].scaleY}, skew {settings.printerProfileSelection[previewSide].skewXDeg ?? 0}°/{settings.printerProfileSelection[previewSide].skewYDeg ?? 0}° · {calibrationTransform ? layers.calibration ? "transformação calibrada visível" : "geometria nominal visível" : "transformação identidade"}.</>
        : <>Sem perfil de calibração selecionado; geometria nominal visível.</>} Conteúdo impresso segue a calibração; paths SVG/DXF de Silhouette permanecem nominais.
    </p>
    <div className="compositor-sheet-frame">
    <div className="compositor-sheet-scroll" ref={sheetViewportRef} tabIndex={-1}>
      <svg className="registration-sheet-preview compositor-sheet" style={{ width: `${page.widthMm * COMPOSITOR_CSS_PX_PER_MM * zoomScale}px`, height: `${page.heightMm * COMPOSITOR_CSS_PX_PER_MM * zoomScale}px`, maxWidth: "none", maxHeight: "none" }} viewBox={`0 0 ${page.widthMm} ${page.heightMm}`} role="group" aria-label={`Compositor live ${previewSide === "front" ? "frente" : "verso"} ${settings.paperFormat.name} ${settings.pageOrientation}, página ${activePageIndex + 1} de ${pageCount}`} data-compositor-page={activePageIndex + 1} data-active-physical-card-index={visibleActivePhysicalCardIndex ?? "none"} data-compositor-bleed-mm={settings.bleedMm} data-compositor-calibration-matrix={visibleCalibrationMatrix ?? "identity"} data-compositor-profile-version={settings.printerProfileSelection?.version ?? "none"} data-compositor-printer-mode={settings.printerDuplexMode} data-compositor-zoom-mode={zoomMode} data-compositor-zoom-scale={zoomScale}>
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
            const isActive = physicalInstance?.id === activePhysicalInstanceId;
            const isMultiSelected = physicalInstance ? selectedPhysicalInstanceIds.has(physicalInstance.id) : false;
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
            const role = canToggleSkippedSlot ? "button" : undefined;
            const label = physicalInstance
              ? `Slot ${slot.index + 1} · carta física ${physicalCardIndex! + 1} · ${cardName} · cópia ${physicalInstance.copyNumber} de ${physicalInstance.totalCopies}`
              : `Slot ${slot.index + 1}${skipped.has(slot.index) ? " desativado" : reserved.has(slot.index) ? " reservado" : " vazio"}`;
            const activateSkippedSlot = () => { if (canToggleSkippedSlot) toggle(slot.index); };
            return <g
              key={`slot-${slot.index}`}
              {...(role ? { role, tabIndex: 0 } : {})}
              aria-label={label}
              {...(role ? { "aria-pressed": skipped.has(slot.index) } : {})}
              data-physical-card-index={physicalCardIndex}
              data-physical-instance-id={physicalInstance?.id}
              data-local-inspection-side={physicalInstance && localFaceOverrideByInstanceId[physicalInstance.id] !== previewSide ? localFaceOverrideByInstanceId[physicalInstance.id] : undefined}
              data-active-physical-instance={isActive ? "true" : "false"}
              data-multi-selected={isMultiSelected ? "true" : "false"}
              data-working-card-id={physicalInstance?.workingCardId}
              data-copy-number={physicalInstance?.copyNumber}
              data-copy-count={physicalInstance?.totalCopies}
              data-slot-x-mm={slot.trim.xMm}
              data-slot-y-mm={slot.trim.yMm}
              {...(role ? {
                onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activateSkippedSlot();
                  }
                },
              } : {})}
              onClick={(event) => {
                if (physicalInstance) {
                  if (event.target === event.currentTarget) activateInstance(physicalInstance);
                } else activateSkippedSlot();
              }}
              {...({ draggable: Boolean(physicalInstance && onReorderPhysicalInstance && !interactionBusy) } as Record<string, boolean>)}
              onDragStart={physicalInstance ? (event) => {
                if (interactionControlPointerDownRef.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  interactionControlPointerDownRef.current = false;
                  return;
                }
                beginSlotDrag(event, physicalInstance);
              } : undefined}
              onDragEnd={() => { interactionControlPointerDownRef.current = false; setDragSourceId(null); setDropTargetId(null); }}
              onDragOver={(event) => {
                if (!dragSourceId || interactionBusy) return;
                event.preventDefault();
                setDropTargetId(invalidDropReason ? invalidDropTargetId : physicalInstance?.id ?? "end");
                setDropFeedback(invalidDropReason ?? (physicalInstance ? "Solte para inserir esta cópia depois da carta de destino." : "Solte para mover esta cópia para o final."));
              }}
              onDrop={(event) => dropOnSlot(event, physicalInstance, canDropAtEnd, invalidDropReason, invalidDropTargetId)}
              onContextMenu={(event) => {
                if (!physicalInstance) return;
                event.preventDefault();
                const opener = event.currentTarget.querySelector<SVGRectElement>("[data-compositor-card-body='true']");
                if (opener) openContextMenu(physicalInstance, event.clientX, event.clientY, opener);
              }}
              className={`registration-preview-slot ${previewSide === "back" ? "is-back" : ""} ${isActive ? "is-active" : ""} ${dropTargetId === physicalInstance?.id || dropTargetId === "end" && canDropAtEnd ? "is-drop-target" : ""} ${dropTargetId === invalidDropTargetId ? "is-invalid-drop" : ""} ${dragSourceId === physicalInstance?.id ? "is-drag-source" : ""}`}
            >
            {layers.bleed && <rect x={slot.slotXmm} y={slot.slotYmm} width={slot.slotWidthMm} height={slot.slotHeightMm} fill="#dbeafe" fillOpacity="0.72" stroke="#2563eb" strokeWidth="0.25" strokeDasharray="1.2 0.8" data-compositor-layer="bleed" />}
            {skipped.has(slot.index) && <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill="#f3e8ff" stroke="#7e22ce" strokeWidth={layers.trim ? "0.6" : "0"} />}
            {assigned.has(slot.index) && (() => {
              const physicalCard = physicalInstance?.card;
              const displayedSide = physicalInstance ? localFaceOverrideByInstanceId[physicalInstance.id] ?? previewSide : previewSide;
              const localInspection = displayedSide !== previewSide;
              const centerX = slot.trim.xMm + slot.trim.widthMm / 2;
              const centerY = slot.trim.yMm + slot.trim.heightMm / 2;
              const artwork = previewArtwork(physicalCard, displayedSide);
              const name = physicalCard?.identity?.name ?? physicalCard?.identityHints.name ?? physicalCard?.importSource.filename ?? "Custom card";
              const dfcLabel = physicalCard && isDoubleFacedIdentity(physicalCard.identity) ? " · DFC" : "";
              const clipId = `compositor-${activePageIndex}-${previewSide}-${slot.index}`;
              const duplexRotationDegrees = displayedSide === "back" ? pagePair.backPageTransform.artworkOrientation.rotationDegrees : 0;
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
                  data-compositor-artwork={artwork.referenceId}
                  data-compositor-face={displayedSide}
                  data-compositor-source="preview-thumbnail"
                />}
                {!artwork.available && displayedSide === "back" && <text x={centerX} y={slot.trim.yMm + slot.trim.heightMm * 0.76} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize * 0.62} fill="#475569">VERSO INDISPONÍVEL</text>}
                {localInspection && <g className="compositor-local-inspection-indicator" pointerEvents="none" aria-hidden="true">
                  <rect x={slot.trim.xMm + 1} y={slot.trim.yMm + slot.trim.heightMm - 5.5} width="24" height="4.2" rx="0.8" />
                  <text x={slot.trim.xMm + 2.2} y={slot.trim.yMm + slot.trim.heightMm - 2.7}>INSPEÇÃO · {displayedSide === "front" ? "FRENTE" : "VERSO"}</text>
                </g>}
              </>;
            })()}
            {layers.trim && assigned.has(slot.index) && <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill="none" stroke="#1d4ed8" strokeWidth="0.45" data-compositor-layer="trim" />}
            {physicalInstance && <rect
              className="compositor-card-body"
              data-compositor-card-body="true"
              data-physical-card-index={physicalCardIndex}
              data-physical-instance-id={physicalInstance.id}
              x={slot.trim.xMm}
              y={slot.trim.yMm}
              width={slot.trim.widthMm}
              height={slot.trim.heightMm}
              fill="transparent"
              pointerEvents="all"
              role="button"
              tabIndex={0}
              aria-label={`Slot ${slot.index + 1} · carta física ${physicalCardIndex! + 1} · ${cardName} · cópia ${physicalInstance.copyNumber} de ${physicalInstance.totalCopies}`}
              aria-current={isActive ? "true" : undefined}
              onPointerDown={() => {
                if (suppressNextBodyActivationRef.current && !dragSourceId) suppressNextBodyActivationRef.current = false;
              }}
              onClick={(event) => activateBody(physicalInstance, event.currentTarget)}
              onKeyDown={(event: KeyboardEvent<SVGRectElement>) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  activateInstance(physicalInstance);
                  const displayedSide = localFaceOverrideByInstanceId[physicalInstance.id] ?? previewSide;
                  openPickerForInstance(physicalInstance, displayedSide, event.currentTarget);
                }
              }}
            />}
            {physicalInstance && onTogglePhysicalInstanceSelection && <g
              className="compositor-selection-checkbox"
              role="checkbox"
              aria-checked={isMultiSelected}
              aria-label={`Selecionar ${cardName}, cópia ${physicalInstance.copyNumber} de ${physicalInstance.totalCopies}`}
              tabIndex={0}
              onPointerDown={(event) => { interactionControlPointerDownRef.current = true; event.stopPropagation(); }}
              onPointerUp={() => { interactionControlPointerDownRef.current = false; }}
              onPointerCancel={() => { interactionControlPointerDownRef.current = false; }}
              onMouseDown={(event) => { interactionControlPointerDownRef.current = true; event.stopPropagation(); }}
              onMouseUp={() => { interactionControlPointerDownRef.current = false; }}
              onClick={(event) => {
                event.stopPropagation();
                interactionControlPointerDownRef.current = false;
                onTogglePhysicalInstanceSelection(physicalInstance.id);
              }}
              onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
                event.stopPropagation();
                if (event.key === " ") {
                  event.preventDefault();
                  onTogglePhysicalInstanceSelection(physicalInstance.id);
                }
              }}
              onDragStart={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
            >
              <rect x={slot.trim.xMm + 0.25} y={slot.trim.yMm + 0.25} width="8" height="8" fill="transparent" pointerEvents="all" />
              <rect className="compositor-selection-checkbox-box" x={slot.trim.xMm + 1.5} y={slot.trim.yMm + 1.5} width="5.5" height="5.5" rx="0.8" />
              <path className="compositor-selection-checkbox-mark" d={`M ${slot.trim.xMm + 2.65} ${slot.trim.yMm + 4.15} l 1.05 1.05 l 2.25 -2.55`} />
            </g>}
            {physicalInstance && (() => {
              const displayedSide = localFaceOverrideByInstanceId[physicalInstance.id] ?? previewSide;
              const nextSide = displayedSide === "front" ? "back" : "front";
              const canFlip = previewArtwork(physicalInstance.card, nextSide).available;
              const isMenuOpen = contextMenu?.instanceId === physicalInstance.id && contextMenu.workingCardId === physicalInstance.workingCardId;
              const localName = cardName ?? "Carta";
              return <foreignObject
                className="compositor-card-control-overlay"
                x={slot.trim.xMm + slot.trim.widthMm - 12.4}
                y={slot.trim.yMm + 0.7}
                width="12"
                height={canFlip ? "24" : "12"}
                pointerEvents="none"
                data-compositor-controls-for={physicalInstance.id}
              >
                <div className="compositor-card-controls">
                  {canFlip && <button
                    type="button"
                    className="compositor-card-control-button compositor-local-flip"
                    data-compositor-local-flip="true"
                    draggable={false}
                    aria-label={`Ver ${nextSide === "front" ? "frente" : "verso"} de ${localName}, cópia ${physicalInstance.copyNumber}`}
                    aria-pressed={localFaceOverrideByInstanceId[physicalInstance.id] !== undefined}
                    onPointerDown={(event) => { interactionControlPointerDownRef.current = true; event.stopPropagation(); }}
                    onPointerUp={() => { interactionControlPointerDownRef.current = false; }}
                    onPointerCancel={() => { interactionControlPointerDownRef.current = false; }}
                    onMouseDown={(event) => { interactionControlPointerDownRef.current = true; event.stopPropagation(); }}
                    onMouseUp={() => { interactionControlPointerDownRef.current = false; }}
                    onClick={(event) => { event.preventDefault(); event.stopPropagation(); interactionControlPointerDownRef.current = false; toggleLocalFace(physicalInstance); }}
                    onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
                  >↻</button>}
                  <button
                    type="button"
                    className="compositor-card-control-button compositor-context-trigger"
                    data-compositor-context-trigger="true"
                    draggable={false}
                    aria-label={`Mais ações para ${localName}, cópia ${physicalInstance.copyNumber} de ${physicalInstance.totalCopies}`}
                    aria-haspopup="menu"
                    aria-expanded={isMenuOpen}
                    onPointerDown={(event) => { interactionControlPointerDownRef.current = true; event.stopPropagation(); }}
                    onPointerUp={() => { interactionControlPointerDownRef.current = false; }}
                    onPointerCancel={() => { interactionControlPointerDownRef.current = false; }}
                    onMouseDown={(event) => { interactionControlPointerDownRef.current = true; event.stopPropagation(); }}
                    onMouseUp={() => { interactionControlPointerDownRef.current = false; }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      interactionControlPointerDownRef.current = false;
                      if (isMenuOpen) closeContextMenu(true);
                      else {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        openContextMenu(physicalInstance, bounds.left, bounds.bottom + 4, event.currentTarget);
                      }
                    }}
                    onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
                  >⋯</button>
                </div>
              </foreignObject>;
            })()}
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
    {selectedPhysicalInstanceIds.size > 0 && onSelectAllPhysicalInstances && onClearPhysicalInstanceSelection && <div className="compositor-selection-bar" role="group" aria-label="Ações de seleção">
      <button type="button" className="button secondary" onClick={() => onSelectAllPhysicalInstances(physicalOrder.instances.map(({ id }) => id))}>Selecionar tudo</button>
      <button type="button" className="button secondary" onClick={onClearPhysicalInstanceSelection}>Desmarcar</button>
    </div>}
    </div>
    {!slotsCanBeSkipped && <p className="muted">Defina linhas e colunas antes de desativar slots.</p>}
    {previewSide === "back" && <p className="muted">O verso mantém a mesma página física e o pareamento duplex. Registration, cut paths e calibration acompanham a geometria refletida da folha; a orientação da artwork segue o modo {pagePair.flipMode}.</p>}
    <div className="registration-preview-legend"><span><i className="legend-bleed" /> Bleed</span><span><i className="legend-trim" /> Trim/card</span><span><i className="legend-cut-source" /> Cut path</span><span><i className="legend-skipped" /> Skipped slot/path</span><span><i className="legend-reserved" /> Reserved zone</span><span><i className="legend-mark" /> Registration mark</span></div>
    {contextMenu && contextMenuInstance && typeof document !== "undefined" && createPortal(<div
      ref={contextMenuElementRef}
      className="compositor-context-menu"
      role="menu"
      aria-label={`Ações para ${contextMenuInstance.card.identity?.name ?? contextMenuInstance.card.identityHints.name ?? "Carta"}, cópia ${contextMenuInstance.copyNumber} de ${contextMenuInstance.totalCopies}`}
      data-testid="compositor-context-menu"
      data-physical-instance-id={contextMenuInstance.id}
      data-working-card-id={contextMenuInstance.workingCardId}
      onKeyDown={handleContextMenuKeyDown}
      style={{
        position: "fixed",
        left: `${contextMenuPlacement?.instanceId === contextMenuInstance.id ? contextMenuPlacement.left : contextMenu.x}px`,
        top: `${contextMenuPlacement?.instanceId === contextMenuInstance.id ? contextMenuPlacement.top : contextMenu.y}px`,
        visibility: contextMenuPlacement?.instanceId === contextMenuInstance.id && contextMenuPlacement.ready ? "visible" : "hidden",
      }}
    >
      <div className="compositor-context-menu-heading">
        <strong>{contextMenuInstance.card.identity?.name ?? contextMenuInstance.card.identityHints.name ?? "Carta custom"}</strong>
        <span>Cópia {contextMenuInstance.copyNumber}/{contextMenuInstance.totalCopies} · Carta física {contextMenuInstance.physicalCardIndex + 1}</span>
      </div>
      {(() => {
        const displayedSide = localFaceOverrideByInstanceId[contextMenuInstance.id] ?? previewSide;
        const opener = contextMenu.opener;
        return <>
          <button type="button" role="menuitem" disabled={interactionBusy || !onSelectArtwork} onClick={(event) => {
            event.stopPropagation();
            closeContextMenu(false);
            if (!interactionBusy) onSelectArtwork?.(contextMenuInstance.workingCardId, contextMenuInstance.id, contextMenuInstance.physicalCardIndex, displayedSide, opener, contextMenuInstance.copyNumber, contextMenuInstance.totalCopies);
          }}>Trocar artwork</button>
          <button type="button" role="menuitem" disabled={interactionBusy || !onSelectArtwork} onClick={(event) => {
            event.stopPropagation();
            closeContextMenu(false);
            if (!interactionBusy) onSelectArtwork?.(contextMenuInstance.workingCardId, contextMenuInstance.id, contextMenuInstance.physicalCardIndex, "back", opener, contextMenuInstance.copyNumber, contextMenuInstance.totalCopies);
          }}>Configurar verso/face</button>
        </>;
      })()}
      <button type="button" role="menuitem" disabled={interactionBusy || !onPhysicalAction} onClick={(event) => { event.stopPropagation(); runPhysicalMenuAction("increase"); }}>Aumentar quantidade</button>
      {contextMenuInstance.totalCopies > 1 && <button type="button" role="menuitem" disabled={interactionBusy || !onPhysicalAction} onClick={(event) => { event.stopPropagation(); runPhysicalMenuAction("remove-copy"); }}>Remover uma cópia</button>}
      <button type="button" role="menuitem" disabled={interactionBusy || !onPhysicalAction} onClick={(event) => { event.stopPropagation(); runPhysicalMenuAction("duplicate-copy"); }}>Duplicar como entrada independente</button>
      <button type="button" role="menuitem" disabled={interactionBusy || !onPhysicalAction} onClick={(event) => { event.stopPropagation(); runPhysicalMenuAction("open-settings"); }}>Configurações completas</button>
      <div className="compositor-context-menu-separator" role="separator" />
      <button type="button" role="menuitem" className="is-destructive" disabled={interactionBusy || !onPhysicalAction} onClick={(event) => { event.stopPropagation(); runPhysicalMenuAction("delete-entry"); }}>Remover carta inteira</button>
    </div>, document.body)}
  </section>;
}
