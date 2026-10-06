"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { CutGuideEngine } from "../../core/geometry";
import type { CardSlotMm } from "../../core/geometry/placement";
import { buildCanonicalPrintPlan, getDuplexPreviewOverlayMatrix } from "../../core/duplex";
import { createPrintCalibrationTransform } from "../../core/calibration";
import type { WorkingCard } from "../../core/cards/types";
import { createPhysicalOrder, movePhysicalInstance, type PhysicalOrder } from "../../core/cards/physical-instance-order";
import { isDoubleFacedIdentity } from "../../core/cards/back-selection";
import { resolveBackForMissingPolicy } from "./back-validation";
import type { ProjectSettingsV2 } from "../../persistence/projects/serializer";
import { cutPathToSvgD } from "../../core/cut";
import type { CutPreviewDto } from "../../services/cut-api";
import { transformRegistrationGeometry, type RegistrationPrimitive } from "../../core/registration";
import { calculateCompositorScale, COMPOSITOR_CSS_PX_PER_MM, type CompositorViewportSize } from "./compositor-zoom";
import { deriveCompositorInsertionAxis, resolveCompositorInsertionPlacement, type CompositorInsertionAxis } from "./compositor-pointer-drag";
import type { FocusableElement } from "./artwork-picker-dialog";
import { selectCompositorDisplayBucket } from "./compositor-display-bucket";
import type { ArtworkDisplayWidthBucket } from "../../artwork/display-buckets";

interface RegistrationLayoutPreviewProps {
  readonly settings: ProjectSettingsV2;
  readonly cardCount: number;
  readonly cards: readonly WorkingCard[];
  readonly physicalOrder?: PhysicalOrder;
  readonly activePhysicalInstanceId?: string | null;
  readonly onActiveOccupiedSlotChange?: (slotIndex: number | null) => void;
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

type PointerDropTarget =
  | { readonly kind: "instance"; readonly physicalInstanceId: string; readonly placement: "before" | "after"; readonly pageNumber: number; readonly slotIndex: number }
  | { readonly kind: "end"; readonly pageNumber: number; readonly slotIndex: number }
  | { readonly kind: "invalid"; readonly pageNumber: number; readonly slotIndex: number; readonly reason: string }
  | { readonly kind: "self"; readonly pageNumber: number; readonly slotIndex: number }
  | null;

interface PointerDragState {
  readonly pointerId: number;
  readonly documentRevision: number;
  readonly sourcePhysicalInstanceId: string;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly currentClientX: number;
  readonly currentClientY: number;
  readonly phase: "pending" | "dragging";
  readonly insertionAxis: CompositorInsertionAxis;
  readonly grabOffsetX: number;
  readonly grabOffsetY: number;
  readonly ghostWidth: number;
  readonly ghostHeight: number;
  readonly ghostRotationDegrees: number;
  readonly ghostUrl?: string;
  readonly ghostLabel: string;
  readonly displayedSide: "front" | "back";
  readonly target: PointerDropTarget;
}

interface PointerHandlers {
  readonly move: (event: PointerEvent) => void;
  readonly up: (event: PointerEvent) => void;
  readonly cancel: (event?: PointerEvent) => void;
}

const POINTER_DRAG_THRESHOLD_PX = 6;

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

function artworkDisplayUrl(candidateId: string, bucket: ArtworkDisplayWidthBucket, trimWidthMm: number, trimHeightMm: number, bleedMm: number, roundedCorners: boolean, cornerRadiusMm: number): string {
  return `/api/cards/artworks/${encodeURIComponent(candidateId)}/display?width=${bucket}&${previewGeometryQuery(trimWidthMm, trimHeightMm, bleedMm, roundedCorners, cornerRadiusMm).slice(1)}`;
}

function backDisplayUrl(assetId: string, bucket: ArtworkDisplayWidthBucket, trimWidthMm: number, trimHeightMm: number, bleedMm: number, roundedCorners: boolean, cornerRadiusMm: number): string {
  return `/api/back-library/${encodeURIComponent(assetId)}/display?width=${bucket}&${previewGeometryQuery(trimWidthMm, trimHeightMm, bleedMm, roundedCorners, cornerRadiusMm).slice(1)}`;
}

function calibrationSvgMatrix(matrix: { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number }): string {
  return `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
}

interface CompositorArtworkImageProps {
  readonly previewUrl: string;
  readonly displayUrl: string;
  readonly assetKey: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly clipPath: string;
  readonly transform?: string;
  readonly label: string;
  readonly candidateId: string;
  readonly face: "front" | "back";
}

function CompositorArtworkImage({ previewUrl, displayUrl, assetKey, x, y, width, height, clipPath, transform, label, candidateId, face }: CompositorArtworkImageProps) {
  const [loadedDisplay, setLoadedDisplay] = useState<{ readonly url: string; readonly assetKey: string } | null>(null);
  const currentDisplayRef = useRef({ url: displayUrl, assetKey });
  currentDisplayRef.current = { url: displayUrl, assetKey };
  const currentLoaded = loadedDisplay?.url === displayUrl && loadedDisplay.assetKey === assetKey;
  const previousLoaded = !currentLoaded && loadedDisplay?.assetKey === assetKey ? loadedDisplay : null;
  const visibleLayer = currentLoaded ? "display" : previousLoaded ? "previous" : "preview";
  const common = {
    x,
    y,
    width,
    height,
    preserveAspectRatio: "none" as const,
    clipPath,
    ...(transform ? { transform } : {}),
    role: "img" as const,
    "aria-label": label,
    "data-compositor-artwork": candidateId,
    "data-compositor-face": face,
  };
  const markLoaded = (event: SyntheticEvent<SVGImageElement>) => {
    if (currentDisplayRef.current.url !== displayUrl
      || currentDisplayRef.current.assetKey !== assetKey
      || event.currentTarget.getAttribute("href") !== displayUrl) return;
    setLoadedDisplay({ url: displayUrl, assetKey });
  };
  return <>
    <image
      {...common}
      href={previewUrl}
      opacity={visibleLayer === "preview" ? 1 : 0}
      aria-hidden={visibleLayer !== "preview"}
      data-compositor-source="preview-thumbnail"
    />
    {previousLoaded && <image
      {...common}
      key={`previous-${previousLoaded.url}`}
      href={previousLoaded.url}
      opacity={visibleLayer === "previous" ? 1 : 0}
      aria-hidden={visibleLayer !== "previous"}
      data-compositor-source="display-high-fidelity"
      data-compositor-display-url={previousLoaded.url}
    />}
    <image
      {...common}
      key={displayUrl}
      href={displayUrl}
      opacity={currentLoaded ? 1 : 0}
      aria-hidden={!currentLoaded}
      data-compositor-source={currentLoaded ? "display-high-fidelity" : "display-high-fidelity-pending"}
      data-compositor-display-url={displayUrl}
      onLoad={markLoaded}
    />
  </>;
}

export default function RegistrationLayoutPreview({ settings, cardCount, cards, physicalOrder: suppliedPhysicalOrder, activePhysicalInstanceId = null, onActiveOccupiedSlotChange, selectedPhysicalInstanceIds = EMPTY_PHYSICAL_INSTANCE_IDS, face, interactionBusy = false, documentRevision = 0, cutPreview = null, selectedPageNumber, onSelectPage, onToggleSkippedSlot, onActivatePhysicalInstance, onTogglePhysicalInstanceSelection, onSelectAllPhysicalInstances, onClearPhysicalInstanceSelection, onFaceChange, onSelectArtwork, onPhysicalAction, onReorderPhysicalInstance }: RegistrationLayoutPreviewProps) {
  const physicalOrder = suppliedPhysicalOrder ?? createPhysicalOrder(cards);
  const [uncontrolledSide, setUncontrolledSide] = useState<"front" | "back">("front");
  const previewSide = face ?? uncontrolledSide;
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);
  const [contextMenuPlacement, setContextMenuPlacement] = useState<ContextMenuPlacement | null>(null);
  const [localFaceOverrideState, setLocalFaceOverrideState] = useState<LocalFaceOverrideState>(() => ({ documentRevision, byInstanceId: {} }));
  const localFaceOverrideByInstanceId = localFaceOverrideState.documentRevision === documentRevision
    ? localFaceOverrideState.byInstanceId
    : EMPTY_LOCAL_FACE_OVERRIDES;
  const [pointerDrag, setPointerDrag] = useState<PointerDragState | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const pointerHandlersRef = useRef<PointerHandlers>({ move: () => undefined, up: () => undefined, cancel: () => undefined });
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const pendingKeyboardReorderFocusRef = useRef<{
    readonly physicalInstanceId: string;
    readonly documentRevision: number;
    readonly expectedOrderSignature: string;
  } | null>(null);
  const [keyboardReorderFocusAttempt, setKeyboardReorderFocusAttempt] = useState(0);
  const pageNavigationHoverRef = useRef<string | null>(null);
  const suppressNextClickAfterDragRef = useRef(false);
  const clickSuppressionTimeoutRef = useRef<number | null>(null);
  const contextMenuTokenRef = useRef(0);
  const contextMenuElementRef = useRef<HTMLDivElement | null>(null);
  const [dropFeedback, setDropFeedback] = useState<string | null>(null);
  const sheetViewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<CompositorViewportSize>({ widthPx: 0, heightPx: 0 });
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
  const slotsCanBeSkipped = Boolean(settings.layout.templateGeometry
    || cutPreview?.derivedTemplateGeometry
    || (settings.layout.rows !== undefined && settings.layout.columns !== undefined));
  const activeOccupiedSlotIndex = (() => {
    if (!slotsCanBeSkipped || previewSide !== "front" || activePhysicalCardIndex === null) return null;
    const page = result.pages?.[activePageIndex];
    const frontPlacement = result.pairing?.pagePairs[activePageIndex]?.frontPlacement;
    if (!page || !frontPlacement
      || activePhysicalCardIndex < page.startCardIndex
      || activePhysicalCardIndex >= page.endCardIndex) return null;
    return frontPlacement.placement.slots.find(({ cardIndex }) => cardIndex !== undefined
      && frontPlacement.startCardIndex + cardIndex === activePhysicalCardIndex)?.index ?? null;
  })();
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
    const drag = pointerDragRef.current;
    if (drag && (interactionBusy
      || drag.documentRevision !== documentRevision
      || !physicalCards.some(({ id }) => id === drag.sourcePhysicalInstanceId))) {
      pointerHandlersRef.current.cancel();
    }
  }, [interactionBusy, documentRevision, physicalInstanceIdsSignature]);
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
    const closeOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && contextMenuElementRef.current?.contains(target)) return;
      setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu?.token]);
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => pointerHandlersRef.current.move(event);
    const handlePointerUp = (event: PointerEvent) => pointerHandlersRef.current.up(event);
    const handlePointerCancel = (event: PointerEvent) => pointerHandlersRef.current.cancel(event);
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) pointerHandlersRef.current.cancel(event);
    };
    const handleWindowBlur = () => pointerHandlersRef.current.cancel();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") pointerHandlersRef.current.cancel();
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("pointerout", handlePointerOut);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("pointerout", handlePointerOut);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (clickSuppressionTimeoutRef.current !== null) window.clearTimeout(clickSuppressionTimeoutRef.current);
      pointerDragRef.current = null;
      pageNavigationHoverRef.current = null;
    };
  }, []);
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
    const pending = pendingKeyboardReorderFocusRef.current;
    if (!pending) return;
    if (interactionBusy
      || pending.documentRevision !== documentRevision
      || !physicalCards.some(({ id }) => id === pending.physicalInstanceId)
      || physicalOrderSignature !== pending.expectedOrderSignature) {
      pendingKeyboardReorderFocusRef.current = null;
      return;
    }
    const targetBody = Array.from(sheetViewportRef.current?.querySelectorAll<SVGRectElement>("[data-compositor-card-body='true']") ?? [])
      .find((body) => body.dataset.physicalInstanceId === pending.physicalInstanceId);
    if (!targetBody) return;
    targetBody.focus();
    if (document.activeElement === targetBody) pendingKeyboardReorderFocusRef.current = null;
  }, [interactionBusy, documentRevision, physicalInstanceIdsSignature, physicalOrderSignature, activePageIndex, keyboardReorderFocusAttempt]);

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

  useEffect(() => {
    onActiveOccupiedSlotChange?.(activeOccupiedSlotIndex);
  }, [activeOccupiedSlotIndex, onActiveOccupiedSlotChange]);

  if (!result.pages || !result.geometry) {
    return <section className="registration-preview canonical-compositor" role="region" aria-label="Compositor live">
      <p className="error-message" role="alert">Layout inválido: {result.error}</p>
    </section>;
  }
  const { geometry } = result;
  const pagePair = result.pairing!.pagePairs[activePageIndex]!;
  const pagePlacement = previewSide === "front" ? pagePair.frontPlacement : pagePair.backPlacement;
  const registrationForPage = previewSide === "front"
    ? geometry
    : transformRegistrationGeometry(geometry, pagePair.backPlacement.placement.pageSizeMm, pagePair.backPageTransform.registrationReflectionAxis);
  const { placement } = pagePlacement;
  const compositorInsertionAxis = deriveCompositorInsertionAxis(
    placement.gridSlots.map(({ trim }) => ({ left: trim.xMm, top: trim.yMm, width: trim.widthMm, height: trim.heightMm })),
    settings.layout.columns === 1 ? "vertical" : "horizontal",
  );
  const physicalSheet = pagePair.frontPlacement.placement;
  const cutGeometry = new CutGuideEngine().generate({
    cards: physicalSheet.slots.map((slot) => ({ trim: slot.trim, bleedMm: settings.bleedMm })),
    pageSizeMm: physicalSheet.pageSizeMm,
    config: settings.cutGuides,
  });
  const cutOverlayMatrix = getDuplexPreviewOverlayMatrix(previewSide, pagePair.backPageTransform.registrationReflectionAxis, placement.pageSizeMm);
  const cutOverlayTransform = `matrix(${cutOverlayMatrix.a} ${cutOverlayMatrix.b} ${cutOverlayMatrix.c} ${cutOverlayMatrix.d} ${cutOverlayMatrix.e} ${cutOverlayMatrix.f})`;
  const cutPreviewPage = cutPreview?.pages.find(({ pageNumber: sourcePage }) => sourcePage === activePageIndex + 1);
  const silhouetteGeometry = cutPreviewPage?.geometry ?? cutPreview?.geometry;
  const page = placement.pageSizeMm;
  const zoomScale = calculateCompositorScale(viewportSize, page);
  const displayCssWidth = (card.widthMm + 2 * settings.bleedMm) * COMPOSITOR_CSS_PX_PER_MM * zoomScale;
  const displayBucket = selectCompositorDisplayBucket(displayCssWidth, typeof window === "undefined" ? 1 : window.devicePixelRatio);
  const fontSize = Math.min(7, page.widthMm / 35);
  const skipped = new Set(placement.gridSlots.filter(({ skippedByUser }) => skippedByUser).map(({ index }) => index));
  const assigned = new Set(placement.slots.map(({ index }) => index));
  const reserved = new Set(placement.gridSlots.filter(({ reserved: isReserved }) => isReserved).map(({ index }) => index));
  const toggle = (index: number) => onToggleSkippedSlot(index);
  const hasConfiguredMargins = Object.values(settings.marginsMm).some((margin) => margin > 0);
  const sideCalibration = settings.printerProfileSelection?.[previewSide];
  const calibrationTransform = sideCalibration ? createPrintCalibrationTransform(page, sideCalibration, previewSide) : null;
  const calibrationMatrix = calibrationTransform && !calibrationTransform.isIdentity
    ? calibrationSvgMatrix(calibrationTransform.svgMatrix)
    : undefined;
  const sourceCardIsLandscape = card.widthMm > card.heightMm;
  const requestedCardIsLandscape = settings.cardOrientation === undefined ? sourceCardIsLandscape : settings.cardOrientation === "landscape";
  const artworkRotationDegrees = sourceCardIsLandscape === requestedCardIsLandscape ? 0 : sourceCardIsLandscape ? -90 : 90;

  function previewArtwork(cardEntry: WorkingCard | undefined, side: "front" | "back" = previewSide) {
    const bleedMm = settings.bleedMm;
    const roundedCorners = settings.roundedCorners;
    const cornerRadiusMm = settings.cardFormat.cornerRadiusMm ?? 3.175;
    const sourceTrimWidthMm = settings.cardFormat.widthMm;
    const sourceTrimHeightMm = settings.cardFormat.heightMm;
    if (!cardEntry) return { url: undefined, displayUrl: undefined, assetKey: "", label: "Carta sem arte selecionada", available: false, referenceId: undefined };
    if (side === "front") {
      const artwork = cardEntry.selectedArtworkByFace.front;
      return artwork
        ? {
          url: artworkPreviewUrl(artwork.candidateId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm),
          displayUrl: artworkDisplayUrl(artwork.candidateId, displayBucket, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm),
          assetKey: [artwork.candidateId, side, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm].join("\0"),
          label: `${cardEntry.identity?.name ?? cardEntry.identityHints.name ?? "Carta"} · frente`,
          available: true,
          referenceId: artwork.candidateId,
        }
        : { url: undefined, displayUrl: undefined, assetKey: "", label: "Frente sem artwork selecionada", available: false, referenceId: undefined };
    }
    const back = resolveBackForMissingPolicy(cardEntry, settings.projectDefaultBack, settings.missingBackPolicy);
    if (back.status !== "available") return { url: undefined, label: back.status === "intentional-none" ? "Verso intencionalmente em branco" : "Verso sem artwork disponível", available: false, referenceId: undefined };
    if (back.artwork) return {
      url: artworkPreviewUrl(back.artwork.candidateId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm),
      displayUrl: artworkDisplayUrl(back.artwork.candidateId, displayBucket, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm),
      assetKey: [back.artwork.candidateId, side, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm].join("\0"),
      label: `${cardEntry.identity?.name ?? cardEntry.identityHints.name ?? "Carta"} · verso`,
      available: true,
      referenceId: back.artwork.candidateId,
    };
    if (back.asset) {
      const previewUrl = backPreviewUrl(back.asset.assetId, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm);
      return {
        url: previewUrl,
        displayUrl: backDisplayUrl(back.asset.assetId, displayBucket, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm),
        assetKey: [back.asset.assetId, side, sourceTrimWidthMm, sourceTrimHeightMm, bleedMm, roundedCorners, cornerRadiusMm].join("\0"),
        label: back.mode === "project-default" ? "Verso padrão do Project" : "Verso da Back Library",
        available: true,
        referenceId: previewUrl,
      };
    }
    return { url: undefined, displayUrl: undefined, assetKey: "", label: "Verso sem artwork disponível", available: false, referenceId: undefined };
  }

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

  function samePointerDropTarget(left: PointerDropTarget, right: PointerDropTarget): boolean {
    if (left === right) return true;
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === "instance" && right.kind === "instance") {
      return left.physicalInstanceId === right.physicalInstanceId
        && left.placement === right.placement && left.pageNumber === right.pageNumber && left.slotIndex === right.slotIndex;
    }
    if (left.kind === "invalid" && right.kind === "invalid") {
      return left.reason === right.reason && left.pageNumber === right.pageNumber && left.slotIndex === right.slotIndex;
    }
    return left.pageNumber === right.pageNumber && left.slotIndex === right.slotIndex;
  }

  function clearClickSuppression() {
    suppressNextClickAfterDragRef.current = false;
    if (clickSuppressionTimeoutRef.current !== null) {
      window.clearTimeout(clickSuppressionTimeoutRef.current);
      clickSuppressionTimeoutRef.current = null;
    }
  }

  function armClickSuppression() {
    clearClickSuppression();
    suppressNextClickAfterDragRef.current = true;
    clickSuppressionTimeoutRef.current = window.setTimeout(() => {
      suppressNextClickAfterDragRef.current = false;
      clickSuppressionTimeoutRef.current = null;
    }, 0);
  }

  function consumeClickSuppression(): boolean {
    if (!suppressNextClickAfterDragRef.current) return false;
    clearClickSuppression();
    return true;
  }

  function clearPointerDrag() {
    pointerDragRef.current = null;
    pageNavigationHoverRef.current = null;
    if (dragGhostRef.current) dragGhostRef.current.style.transform = "";
    setPointerDrag(null);
  }

  function cancelPointerDrag(event?: PointerEvent) {
    const current = pointerDragRef.current;
    if (!current || event && current.pointerId !== event.pointerId) return;
    clearPointerDrag();
    clearClickSuppression();
    setDropFeedback(null);
  }

  function pointerEventElement(event: PointerEvent): Element | null {
    const documentElement = (document as Document & { elementFromPoint?: (x: number, y: number) => Element | null })
      .elementFromPoint?.(event.clientX, event.clientY);
    if (documentElement) return documentElement;
    return event.target instanceof Element ? event.target : null;
  }

  function promotePointerDrag(current: PointerDragState): PointerDragState | null {
    if (current.phase === "dragging") return current;
    const source = physicalCards.find(({ id }) => id === current.sourcePhysicalInstanceId);
    if (!source || interactionBusy || !onReorderPhysicalInstance) {
      cancelPointerDrag();
      return null;
    }
    activateInstance(source);
    setDropFeedback(null);
    const promoted = { ...current, phase: "dragging" as const };
    pointerDragRef.current = promoted;
    setPointerDrag(promoted);
    return promoted;
  }

  function moveDragGhost(current: PointerDragState) {
    const ghost = dragGhostRef.current;
    if (!ghost) return;
    ghost.style.transform = `translate3d(${current.currentClientX - current.grabOffsetX}px, ${current.currentClientY - current.grabOffsetY}px, 0)`;
  }

  function pointerDropTarget(element: Element | null, clientX: number, clientY: number, current: PointerDragState): PointerDropTarget {
    const slot = element?.closest<SVGGElement>("[data-compositor-slot='true']");
    if (!slot) return null;
    const pageNumber = Number(slot.dataset.compositorPageNumber);
    const slotIndex = Number(slot.dataset.compositorSlotIndex);
    const invalidReason = slot.dataset.dropInvalidReason;
    if (invalidReason) return { kind: "invalid", pageNumber, slotIndex, reason: invalidReason };
    const targetPhysicalInstanceId = slot.dataset.physicalInstanceId;
    if (targetPhysicalInstanceId) {
      if (targetPhysicalInstanceId === current.sourcePhysicalInstanceId) return { kind: "self", pageNumber, slotIndex };
      const body = slot.querySelector<SVGRectElement>("[data-compositor-card-body='true']");
      if (!body) return { kind: "invalid", pageNumber, slotIndex, reason: "Esta carta não é um destino elegível." };
      const targetRect = body.getBoundingClientRect();
      const placement = resolveCompositorInsertionPlacement(targetRect, clientX, clientY, current.insertionAxis);
      return { kind: "instance", physicalInstanceId: targetPhysicalInstanceId, placement, pageNumber, slotIndex };
    }
    if (slot.dataset.dropCanEnd === "true") return { kind: "end", pageNumber, slotIndex };
    return {
      kind: "invalid",
      pageNumber,
      slotIndex,
      reason: "Este slot não é um destino elegível.",
    };
  }

  function updatePointerDrag(event: PointerEvent) {
    let current = pointerDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (interactionBusy || current.documentRevision !== documentRevision
      || !physicalCards.some(({ id }) => id === current!.sourcePhysicalInstanceId)) {
      cancelPointerDrag(event);
      return;
    }
    const distance = Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY);
    if (current.phase === "pending" && distance >= POINTER_DRAG_THRESHOLD_PX) {
      const promoted = promotePointerDrag({ ...current, currentClientX: event.clientX, currentClientY: event.clientY });
      if (!promoted) return;
      current = promoted;
    }
    if (current.phase !== "dragging") {
      pointerDragRef.current = { ...current, currentClientX: event.clientX, currentClientY: event.clientY };
      return;
    }

    event.preventDefault();
    const element = pointerEventElement(event);
    const pageControl = element?.closest<HTMLElement>("[data-compositor-page-nav]");
    let target: PointerDropTarget = null;
    if (pageControl && !pageControl.hasAttribute("disabled")) {
      const direction = pageControl.dataset.compositorPageNav ?? "";
      if (pageNavigationHoverRef.current !== direction) {
        pageNavigationHoverRef.current = direction;
        const targetPage = Number(pageControl.dataset.compositorPageTarget);
        if (Number.isSafeInteger(targetPage) && targetPage >= 1 && targetPage <= pageCount) onSelectPage(targetPage);
      }
    } else {
      pageNavigationHoverRef.current = null;
      target = pointerDropTarget(element, event.clientX, event.clientY, current);
    }

    const next: PointerDragState = {
      ...current,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      target,
    };
    pointerDragRef.current = next;
    moveDragGhost(next);
    if (current.phase !== next.phase || !samePointerDropTarget(current.target, next.target)) setPointerDrag(next);
  }

  function physicalMoveIsNoop(instanceId: string, targetInstanceId: string | null, placement: "before" | "after"): boolean {
    const sourceIndex = physicalOrder.instances.findIndex(({ id }) => id === instanceId);
    if (sourceIndex < 0) return true;
    if (targetInstanceId === null) return sourceIndex === physicalOrder.instances.length - 1;
    const targetIndex = physicalOrder.instances.findIndex(({ id }) => id === targetInstanceId);
    if (targetIndex < 0) return true;
    return placement === "before" ? sourceIndex === targetIndex - 1 : sourceIndex === targetIndex + 1;
  }

  function finishPointerDrag(event: PointerEvent) {
    let current = pointerDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (interactionBusy || current.documentRevision !== documentRevision
      || !physicalCards.some(({ id }) => id === current!.sourcePhysicalInstanceId)) {
      cancelPointerDrag(event);
      return;
    }
    const distance = Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY);
    if (current.phase === "pending" && distance >= POINTER_DRAG_THRESHOLD_PX) {
      const promoted = promotePointerDrag({ ...current, currentClientX: event.clientX, currentClientY: event.clientY });
      if (!promoted) return;
      current = promoted;
    }
    if (current.phase !== "dragging") {
      clearPointerDrag();
      return;
    }

    event.preventDefault();
    const element = pointerEventElement(event);
    const pageControl = element?.closest<HTMLElement>("[data-compositor-page-nav]");
    const target = pageControl ? null : pointerDropTarget(element, event.clientX, event.clientY, current);
    armClickSuppression();
    if (target?.kind === "instance" && !physicalMoveIsNoop(current.sourcePhysicalInstanceId, target.physicalInstanceId, target.placement)) {
      onReorderPhysicalInstance?.(current.sourcePhysicalInstanceId, target.physicalInstanceId, target.placement);
      setDropFeedback(null);
    } else if (target?.kind === "end" && !physicalMoveIsNoop(current.sourcePhysicalInstanceId, null, "after")) {
      onReorderPhysicalInstance?.(current.sourcePhysicalInstanceId, null, "after");
      setDropFeedback(null);
    } else if (target?.kind === "invalid") {
      setDropFeedback(target.reason);
    } else {
      setDropFeedback(null);
    }
    clearPointerDrag();
  }

  function beginBodyPointerDrag(event: ReactPointerEvent<SVGRectElement>, instance: PhysicalCardInstance) {
    pendingKeyboardReorderFocusRef.current = null;
    if (event.button !== 0 || event.isPrimary === false || interactionBusy || !onReorderPhysicalInstance || pointerDragRef.current) return;
    clearClickSuppression();
    const bounds = event.currentTarget.getBoundingClientRect();
    const displayedSide = localFaceOverrideByInstanceId[instance.id] ?? previewSide;
    const artwork = previewArtwork(instance.card, displayedSide);
    const sourceSlot = placement.gridSlots.find(({ cardIndex }) => cardIndex !== undefined
      && pagePlacement.startCardIndex + cardIndex === instance.physicalCardIndex);
    const duplexRotationDegrees = displayedSide === "back" ? pagePair.backPageTransform.artworkOrientation.rotationDegrees : 0;
    const session: PointerDragState = {
      pointerId: event.pointerId,
      documentRevision,
      sourcePhysicalInstanceId: instance.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      phase: "pending",
      insertionAxis: compositorInsertionAxis,
      grabOffsetX: event.clientX - bounds.left,
      grabOffsetY: event.clientY - bounds.top,
      ghostWidth: bounds.width || (sourceSlot?.trim.widthMm ?? settings.cardFormat.widthMm) * COMPOSITOR_CSS_PX_PER_MM * zoomScale,
      ghostHeight: bounds.height || (sourceSlot?.trim.heightMm ?? settings.cardFormat.heightMm) * COMPOSITOR_CSS_PX_PER_MM * zoomScale,
      ghostRotationDegrees: (artworkRotationDegrees + duplexRotationDegrees) % 360,
      ...(artwork.url ? { ghostUrl: artwork.url } : {}),
      ghostLabel: artwork.available ? artwork.label : `${instance.card.identity?.name ?? instance.card.identityHints.name ?? "Carta"} · ${artwork.label}`,
      displayedSide,
      target: null,
    };
    pointerDragRef.current = session;
    setPointerDrag(session);
    setDropFeedback(null);
  }

  function handleBodyKeyDown(event: KeyboardEvent<SVGRectElement>, instance: PhysicalCardInstance) {
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      event.stopPropagation();
      if (interactionBusy || !onReorderPhysicalInstance) return;
      const index = physicalOrder.instances.findIndex(({ id }) => id === instance.id);
      const targetIndex = event.key === "ArrowLeft" ? index - 1 : index + 1;
      const target = physicalOrder.instances[targetIndex];
      if (index < 0 || !target) return;
      const placement = event.key === "ArrowLeft" ? "before" : "after";
      if (physicalMoveIsNoop(instance.id, target.id, placement)) return;
      const expectedOrderSignature = movePhysicalInstance(physicalOrder, instance.id, target.id, placement)
        .instances.map(({ id }) => id).join("\u0000");
      pendingKeyboardReorderFocusRef.current = {
        physicalInstanceId: instance.id,
        documentRevision,
        expectedOrderSignature,
      };
      setKeyboardReorderFocusAttempt((attempt) => attempt + 1);
      activateInstance(instance);
      onReorderPhysicalInstance(instance.id, target.id, placement);
      setDropFeedback(`${instance.card.identity?.name ?? instance.card.identityHints.name ?? "Carta"} movida para a posição ${targetIndex + 1} da ordem física.`);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      activateInstance(instance);
      const displayedSide = localFaceOverrideByInstanceId[instance.id] ?? previewSide;
      openPickerForInstance(instance, displayedSide, event.currentTarget);
    }
  }

  pointerHandlersRef.current = {
    move: updatePointerDrag,
    up: finishPointerDrag,
    cancel: cancelPointerDrag,
  };

  const liveDropFeedback = pointerDrag?.phase === "dragging" && pointerDrag.target?.kind === "invalid"
    ? pointerDrag.target.reason
    : dropFeedback;

  return <section
    className="registration-preview canonical-compositor"
    role="region"
    aria-label="Compositor live"
    onClickCapture={(event) => {
      if (!consumeClickSuppression()) return;
      event.preventDefault();
      event.stopPropagation();
    }}
  >
    <div className="compositor-toolbar" role="toolbar" aria-label="Controles do compositor">
      <div className="duplex-preview-controls" role="group" aria-label="Face do compositor">
        <button type="button" className={`button ${previewSide === "front" ? "primary" : "secondary"}`} aria-pressed={previewSide === "front"} onClick={() => { setUncontrolledSide("front"); onFaceChange?.("front"); }}>Frente</button>
        <button type="button" className={`button ${previewSide === "back" ? "primary" : "secondary"}`} aria-pressed={previewSide === "back"} onClick={() => { setUncontrolledSide("back"); onFaceChange?.("back"); }}>Verso</button>
      </div>
      <div className="compositor-page-controls" role="group" aria-label="Navegação de páginas">
        <button type="button" className="button secondary" aria-label="Página anterior" data-compositor-page-nav="previous" data-compositor-page-target={activePageIndex} disabled={activePageIndex === 0} onClick={() => onSelectPage(activePageIndex)}>Anterior</button>
        <span aria-live="polite">Página {activePageIndex + 1} de {pageCount}</span>
        <button type="button" className="button secondary" aria-label="Próxima página" data-compositor-page-nav="next" data-compositor-page-target={activePageIndex + 2} disabled={activePageIndex >= pageCount - 1} onClick={() => onSelectPage(activePageIndex + 2)}>Próxima</button>
        {pageCount > 1 && <label className="registration-page-picker">Ir para<select aria-label="Página do compositor" value={activePageIndex + 1} onChange={(event) => onSelectPage(Number(event.currentTarget.value))}>
          {result.pages.map((entry, index) => <option key={entry.pageIndex} value={entry.pageIndex + 1}>Página {index + 1} · cartas {entry.startCardIndex + 1}–{entry.endCardIndex}</option>)}
        </select></label>}
      </div>
    </div>
    {liveDropFeedback && <p role="status" className="compositor-drop-feedback">{liveDropFeedback}</p>}
    <div className="compositor-sheet-frame">
    <div className="compositor-sheet-scroll" ref={sheetViewportRef} tabIndex={-1}>
      <svg className="registration-sheet-preview compositor-sheet" style={{ width: `${page.widthMm * COMPOSITOR_CSS_PX_PER_MM * zoomScale}px`, height: `${page.heightMm * COMPOSITOR_CSS_PX_PER_MM * zoomScale}px`, maxWidth: "none", maxHeight: "none" }} viewBox={`0 0 ${page.widthMm} ${page.heightMm}`} role="group" aria-label={`Compositor live ${previewSide === "front" ? "frente" : "verso"} ${settings.paperFormat.name} ${settings.pageOrientation}, página ${activePageIndex + 1} de ${pageCount}`} data-compositor-page={activePageIndex + 1} data-active-physical-card-index={visibleActivePhysicalCardIndex ?? "none"} data-compositor-bleed-mm={settings.bleedMm} data-compositor-calibration-matrix={calibrationMatrix ?? "identity"} data-compositor-zoom-mode="fit-page" data-compositor-zoom-scale={zoomScale}>
        <defs>
          {placement.gridSlots.filter(({ cardIndex }) => cardIndex !== undefined).map((slot) => {
            const centerX = slot.trim.xMm + slot.trim.widthMm / 2;
            const centerY = slot.trim.yMm + slot.trim.heightMm / 2;
            const radius = settings.roundedCorners ? settings.cardFormat.cornerRadiusMm ?? 3.175 : 0;
              const previewBleed = settings.bleedMm;
            const sourceWidth = card.widthMm + 2 * previewBleed;
            const sourceHeight = card.heightMm + 2 * previewBleed;
            const clipId = `compositor-${activePageIndex}-${previewSide}-${slot.index}`;
            return <clipPath key={`clip-${clipId}`} id={clipId} clipPathUnits="userSpaceOnUse">
              <rect
                x={artworkRotationDegrees ? centerX - sourceWidth / 2 : settings.bleedMm > 0 ? slot.slotXmm : slot.trim.xMm}
                y={artworkRotationDegrees ? centerY - sourceHeight / 2 : settings.bleedMm > 0 ? slot.slotYmm : slot.trim.yMm}
                width={artworkRotationDegrees ? sourceWidth : settings.bleedMm > 0 ? slot.slotWidthMm : slot.trim.widthMm}
                height={artworkRotationDegrees ? sourceHeight : settings.bleedMm > 0 ? slot.slotHeightMm : slot.trim.heightMm}
                rx={radius}
                ry={radius}
              />
            </clipPath>;
          })}
        </defs>
        <rect x="0" y="0" width={page.widthMm} height={page.heightMm} fill="#fff" stroke="#64748b" strokeWidth="0.5" />
        {hasConfiguredMargins && <g data-compositor-layer="margins" transform={cutOverlayTransform}><rect x={settings.marginsMm.left} y={settings.marginsMm.top} width={page.widthMm - settings.marginsMm.left - settings.marginsMm.right} height={page.heightMm - settings.marginsMm.top - settings.marginsMm.bottom} fill="#f8fafc" fillOpacity="0.18" stroke="#64748b" strokeWidth="0.35" strokeDasharray="2 1.2" /></g>}
        {registrationForPage.reservedZones.length > 0 && <g data-compositor-layer="reserved" transform={calibrationMatrix}>{registrationForPage.reservedZones.map((zone, index) => <rect key={`reserved-${index}`} x={zone.xMm} y={zone.yMm} width={zone.widthMm} height={zone.heightMm} fill="#fecaca" fillOpacity="0.75" stroke="#dc2626" strokeWidth="0.7" strokeDasharray="2 1" />)}</g>}
        {settings.cutSourceSelection && silhouetteGeometry?.paths.length ? <g data-compositor-layer="silhouette" data-duplex-silhouette={previewSide} transform={cutOverlayTransform}>{silhouetteGeometry.paths.map((path) => {
          const state = (cutPreviewPage?.slotPaths ?? cutPreview?.slotPaths ?? []).find(({ pathId }) => pathId === path.id)?.state ?? "empty";
          const active = state === "active";
          const skippedPath = state === "skipped";
          return <path key={`source-cut-${path.id}`} d={cutPathToSvgD(path)} fill="none" stroke={active ? "#dc2626" : skippedPath ? "#7e22ce" : state === "reserved" ? "#ea5800" : "#64748b"} strokeWidth={active ? "0.65" : "0.4"} strokeDasharray={active ? undefined : "1.5 1"} opacity={active ? "0.95" : "0.75"} data-cut-slot-state={state} aria-label={`Cut path ${path.id}: ${state}`} />;
        })}</g> : null}
        <g transform={calibrationMatrix} data-calibrated-print-content="true">
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
            const dragTarget = pointerDrag?.phase === "dragging" ? pointerDrag.target : null;
            const isDragSource = pointerDrag?.phase === "dragging" && pointerDrag.sourcePhysicalInstanceId === physicalInstance?.id;
            const isEndDropTarget = dragTarget?.kind === "end"
              && dragTarget.pageNumber === activePageIndex + 1 && dragTarget.slotIndex === slot.index;
            const isInvalidDropTarget = dragTarget?.kind === "invalid"
              && dragTarget.pageNumber === activePageIndex + 1 && dragTarget.slotIndex === slot.index;
            const insertionPlacement = dragTarget?.kind === "instance"
              && dragTarget.physicalInstanceId === physicalInstance?.id
              ? dragTarget.placement
              : undefined;
            const showEndInsertion = isEndDropTarget;
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
              data-compositor-slot="true"
              data-compositor-page-number={activePageIndex + 1}
              data-compositor-slot-index={slot.index}
              data-drop-can-end={canDropAtEnd ? "true" : undefined}
              data-drop-invalid-reason={invalidDropReason}
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
              onContextMenu={(event) => {
                if (!physicalInstance) return;
                event.preventDefault();
                const opener = event.currentTarget.querySelector<SVGRectElement>("[data-compositor-card-body='true']");
                if (opener) openContextMenu(physicalInstance, event.clientX, event.clientY, opener);
              }}
              className={`registration-preview-slot ${previewSide === "back" ? "is-back" : ""} ${isActive ? "is-active" : ""} ${isInvalidDropTarget ? "is-invalid-drop" : ""} ${isDragSource ? "is-drag-source" : ""}`}
            >
            {settings.bleedMm > 0 && <rect x={slot.slotXmm} y={slot.slotYmm} width={slot.slotWidthMm} height={slot.slotHeightMm} fill="#dbeafe" fillOpacity="0.72" stroke="#2563eb" strokeWidth="0.25" strokeDasharray="1.2 0.8" data-compositor-layer="bleed" />}
            {skipped.has(slot.index) && <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill="#f3e8ff" stroke="#7e22ce" strokeWidth="0.6" />}
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
            const previewBleed = settings.bleedMm;
              const sourceWidth = card.widthMm + 2 * previewBleed;
              const sourceHeight = card.heightMm + 2 * previewBleed;
              return <>
                <rect x={slot.trim.xMm} y={slot.trim.yMm} width={slot.trim.widthMm} height={slot.trim.heightMm} fill={artwork.available ? "#e2e8f0" : "#f1f5f9"} />
                {!artwork.available ? <g>
                  <text x={centerX} y={slot.trim.yMm + slot.trim.heightMm * 0.42} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize * 0.82} fill="#1e3a8a">{name.slice(0, 20)}{dfcLabel}</text>
                  {!artwork.available && <text x={centerX} y={slot.trim.yMm + slot.trim.heightMm * 0.58} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize * 0.62} fill="#475569">{artwork.label}</text>}
                </g> : artwork.url && artwork.displayUrl && artwork.referenceId && <CompositorArtworkImage
                  previewUrl={artwork.url}
                  displayUrl={artwork.displayUrl}
                  assetKey={artwork.assetKey}
                  x={artworkRotationDegrees ? centerX - sourceWidth / 2 : settings.bleedMm > 0 ? slot.slotXmm : slot.trim.xMm}
                  y={artworkRotationDegrees ? centerY - sourceHeight / 2 : settings.bleedMm > 0 ? slot.slotYmm : slot.trim.yMm}
                  width={artworkRotationDegrees ? sourceWidth : settings.bleedMm > 0 ? slot.slotWidthMm : slot.trim.widthMm}
                  height={artworkRotationDegrees ? sourceHeight : settings.bleedMm > 0 ? slot.slotHeightMm : slot.trim.heightMm}
                  clipPath={`url(#${clipId})`}
                  transform={rotateArtwork}
                  label={artwork.label}
                  candidateId={artwork.referenceId}
                  face={displayedSide}
                />}
                {!artwork.available && displayedSide === "back" && <text x={centerX} y={slot.trim.yMm + slot.trim.heightMm * 0.76} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize * 0.62} fill="#475569">VERSO INDISPONÍVEL</text>}
                {localInspection && <g className="compositor-local-inspection-indicator" pointerEvents="none" aria-hidden="true">
                  <rect x={slot.trim.xMm + 1} y={slot.trim.yMm + slot.trim.heightMm - 5.5} width="24" height="4.2" rx="0.8" />
                  <text x={slot.trim.xMm + 2.2} y={slot.trim.yMm + slot.trim.heightMm - 2.7}>INSPEÇÃO · {displayedSide === "front" ? "FRENTE" : "VERSO"}</text>
                </g>}
              </>;
            })()}
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
              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
              style={{ touchAction: compositorInsertionAxis === "horizontal" ? "pan-y" : "pan-x" }}
              aria-label={`Slot ${slot.index + 1} · carta física ${physicalCardIndex! + 1} · ${cardName} · cópia ${physicalInstance.copyNumber} de ${physicalInstance.totalCopies}`}
              aria-current={isActive ? "true" : undefined}
              onPointerDown={(event) => beginBodyPointerDrag(event, physicalInstance)}
              onClick={(event) => activateBody(physicalInstance, event.currentTarget)}
              onKeyDown={(event: KeyboardEvent<SVGRectElement>) => handleBodyKeyDown(event, physicalInstance)}
            />}
            {physicalInstance && onTogglePhysicalInstanceSelection && <g
              className="compositor-selection-checkbox"
              role="checkbox"
              aria-checked={isMultiSelected}
              aria-label={`Selecionar ${cardName}, cópia ${physicalInstance.copyNumber} de ${physicalInstance.totalCopies}`}
              tabIndex={0}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePhysicalInstanceSelection(physicalInstance.id);
              }}
              onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
                event.stopPropagation();
                if (event.key === " ") {
                  event.preventDefault();
                  onTogglePhysicalInstanceSelection(physicalInstance.id);
                }
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
                    aria-label={`Ver ${nextSide === "front" ? "frente" : "verso"} de ${localName}, cópia ${physicalInstance.copyNumber}`}
                    aria-pressed={localFaceOverrideByInstanceId[physicalInstance.id] !== undefined}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggleLocalFace(physicalInstance); }}
                    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
                  >↻</button>}
                  <button
                    type="button"
                    className="compositor-card-control-button compositor-context-trigger"
                    data-compositor-context-trigger="true"
                    aria-label={`Mais ações para ${localName}, cópia ${physicalInstance.copyNumber} de ${physicalInstance.totalCopies}`}
                    aria-haspopup="menu"
                    aria-expanded={isMenuOpen}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (isMenuOpen) closeContextMenu(true);
                      else {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        openContextMenu(physicalInstance, bounds.left, bounds.bottom + 4, event.currentTarget);
                      }
                    }}
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
            {insertionPlacement && <rect
              className="compositor-insertion-indicator"
              data-compositor-insertion-indicator={insertionPlacement}
              x={compositorInsertionAxis === "horizontal"
                ? slot.trim.xMm + (insertionPlacement === "after" ? slot.trim.widthMm : 0) - 0.48
                : slot.trim.xMm - 0.48}
              y={compositorInsertionAxis === "horizontal"
                ? slot.trim.yMm - 0.8
                : slot.trim.yMm + (insertionPlacement === "after" ? slot.trim.heightMm : 0) - 0.48}
              width={compositorInsertionAxis === "horizontal" ? 0.96 : slot.trim.widthMm + 0.96}
              height={compositorInsertionAxis === "horizontal" ? slot.trim.heightMm + 1.6 : 0.96}
              rx="0.45"
              pointerEvents="none"
              aria-hidden="true"
            />}
            {showEndInsertion && <rect
              className="compositor-insertion-indicator"
              data-compositor-insertion-indicator="end"
              x={compositorInsertionAxis === "horizontal" ? slot.trim.xMm - 0.48 : slot.trim.xMm - 0.48}
              y={compositorInsertionAxis === "horizontal" ? slot.trim.yMm - 0.8 : slot.trim.yMm - 0.48}
              width={compositorInsertionAxis === "horizontal" ? 0.96 : slot.trim.widthMm + 0.96}
              height={compositorInsertionAxis === "horizontal" ? slot.trim.heightMm + 1.6 : 0.96}
              rx="0.45"
              pointerEvents="none"
              aria-hidden="true"
            />}
            </g>;
          })}
          {(cutGeometry.trimSegments.length > 0 || cutGeometry.externalSegments.length > 0) && <g data-compositor-layer="cut" data-duplex-cut-overlay={previewSide} transform={cutOverlayTransform}>
            {cutGeometry.trimSegments.map((segment, index) => <line key={`cut-${index}`} x1={segment.x1Mm} y1={segment.y1Mm} x2={segment.x2Mm} y2={segment.y2Mm} stroke="#2563eb" strokeWidth="0.2" />)}
            {cutGeometry.externalSegments.map((segment, index) => <line key={`external-cut-${index}`} x1={segment.x1Mm} y1={segment.y1Mm} x2={segment.x2Mm} y2={segment.y2Mm} stroke="#111827" strokeWidth="0.2" />)}
          </g>}
          {settings.registration.type !== "none" && <g data-compositor-layer="registration">{registrationForPage.marks.flatMap((mark) => mark.primitives.map((primitive, index) => primitiveElement(primitive, `${mark.id}-${index}`)))}</g>}
        </g>
      </svg>
    </div>
    {selectedPhysicalInstanceIds.size > 0 && onSelectAllPhysicalInstances && onClearPhysicalInstanceSelection && <div className="compositor-selection-bar" role="group" aria-label="Ações de seleção">
      <button type="button" className="button secondary" onClick={() => onSelectAllPhysicalInstances(physicalOrder.instances.map(({ id }) => id))}>Selecionar tudo</button>
      <button type="button" className="button secondary" onClick={onClearPhysicalInstanceSelection}>Desmarcar</button>
    </div>}
    </div>
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
    {pointerDrag?.phase === "dragging" && typeof document !== "undefined" && createPortal(<div
      ref={dragGhostRef}
      className="compositor-drag-ghost"
      data-testid="compositor-drag-ghost"
      data-displayed-side={pointerDrag.displayedSide}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: pointerDrag.ghostWidth,
        height: pointerDrag.ghostHeight,
        pointerEvents: "none",
        transform: `translate3d(${pointerDrag.currentClientX - pointerDrag.grabOffsetX}px, ${pointerDrag.currentClientY - pointerDrag.grabOffsetY}px, 0)`,
      }}
    >
      {pointerDrag.ghostUrl
        ? <img
          src={pointerDrag.ghostUrl}
          alt=""
          draggable={false}
          style={Math.abs(pointerDrag.ghostRotationDegrees) % 180 === 90 ? {
            position: "absolute",
            left: "50%",
            top: "50%",
            width: pointerDrag.ghostHeight,
            height: pointerDrag.ghostWidth,
            maxWidth: "none",
            transform: `translate(-50%, -50%) rotate(${pointerDrag.ghostRotationDegrees}deg)`,
          } : { width: "100%", height: "100%" }}
        />
        : <span>{pointerDrag.ghostLabel}</span>}
    </div>, document.body)}
  </section>;
}
