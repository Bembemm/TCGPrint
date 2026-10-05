"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ImportKind } from "../../import-engine/types";
import type { ArtworkCandidate, CardFaceSide, CardIdentity, WorkingCard, WorkingCardBackMode } from "../../core/cards/types";
import type { MpcArtworkFilterInput, MpcFilterCatalogs } from "../../artwork/mpc-contract";
import type { MpcArtworkProviderDiagnostic } from "../../artwork/mpc-provider";
import { isDoubleFacedIdentity, isEligibleGenericPhysicalBack, restoreAutomaticBackSelection, selectManualBackLibraryAsset, setWorkingCardBackMode } from "../../core/cards/back-selection";

import { formatResolutionSummary } from "../../core/cards/resolution-summary";
import {
  createWorkingCardEditorState,
  deleteWorkingCard,
  duplicateWorkingCard,
  moveWorkingCard,
  replaceWorkingCard,
  replaceWorkingCards,
  removeWorkingCardPhysicalInstance,
  reorderWorkingCardPhysicalInstance,
  duplicatePhysicalInstanceAsEntry,
  setWorkingCardQuantity,
  WorkingCardEditorError,
  type WorkingCardEditorState,
} from "../../core/cards/working-card-editor";
import {
  commitEditorHistory,
  createEditorHistoryState,
  editorHistoryShortcut,
  isEditorTextEditingTarget,
  redoEditorHistory,
  resetEditorHistory,
  undoEditorHistory,
  updateEditorHistoryPresent,
  type EditorHistoryState,
  type EditorSnapshot,
} from "../../core/cards/editor-history";
import { MAX_PHYSICAL_CARDS_PER_EXPORT } from "../../core/cards/limits";
import { createPhysicalOrder, type PhysicalOrder } from "../../core/cards/physical-instance-order";
import { clearRequestCache, createRequestCache, getOrCreateCachedRequest, updateResolvedRequestCache } from "./request-cache";
import { buildBleedExportOptions, buildCutGuideConfig, decodeBleedDiagnostics, type BleedDiagnosticsReport } from "./bleed-export-options";
import ProjectSettingsControls from "./project-settings-controls";
import { runIfProjectInteractionUnlocked } from "./project-interaction-lock";
import type { GuideColor, PageMarginsMm, PageOrientation } from "../../core/geometry";
import type { CardFormat, PaperFormat, TemplateLayoutGeometryMm } from "../../core/geometry";
import type { CutSourceSelection } from "../../core/cut";
import type { CutPreviewDto } from "../../services/cut-api";
import { createDefaultRegistrationConfig, type RegistrationConfig } from "../../core/registration";
import type { ProjectDto } from "../../services/project-api";
import { DEFAULT_PROJECT_SETTINGS, type ExportContentMode, type MissingBackPolicy, type ProjectSettingsV2 } from "../../persistence/projects/serializer";
import type { BackLibraryAssetReference } from "../../core/cards/types";
import type { DuplexFlipMode } from "../../core/duplex";
import type { PrinterDuplexMode, PrinterProfileSnapshot } from "../../core/calibration";
import ProjectsPanel from "./projects-panel";
import PrinterCalibrationPanel from "./printer-calibration-panel";
import type { TemplateRegistrationDefaults } from "./template-library-panel";
import {
  applyProjectRegistrationOverride,
  templateRegistrationRequiresUserChoice,
  type TemplateRegistrationStatus,
} from "./template-registration-compat";
import RegistrationLayoutPreview from "./registration-layout-preview";
import WorkspaceShell, { type WorkspaceSection } from "./workspace-shell";
import BackLibraryControls, { type BackLibraryAssetDto } from "./back-library-controls";
import { createBackValidationSummary, exportModeRequiresFrontArtwork } from "./back-validation";
import { applyTemplateLayoutDefaults } from "./template-layout-defaults";
import { createProjectRestoreLookupGate, runProjectRestoreProviderLookup } from "./project-restore-provider-gate";
import { ARTWORK_WINDOW_SIZE, ArtworkCandidateGrid, filterAndSortArtworkCandidates, sliceArtworkPage, type ArtworkCandidateView, type ArtworkSortMode } from "./artwork-candidate-grid";
import ArtworkPickerDialog from "./artwork-picker-dialog";
import { artworkCatalogForRequest, ArtworkQualityHydrator, updateArtworkCatalogCandidate, type KeyedArtworkCatalogResult } from "./artwork-quality-hydration";
import type { ResolveWorkingCardsResult, SafeImportReport, WorkingSetImportResult } from "../../services/card-workbench";

type ArtworkFilter = "all" | "scryfall" | "mpc" | "upload";
type ArtworkSort = ArtworkSortMode;
type PickerScope = "entry" | "physical-copy" | "same-identity" | "all-simple-project";
type CandidateDto = ArtworkCandidateView;

interface ArtworkPickerContext {
  readonly cardId: string;
  readonly physicalInstanceId?: string;
  readonly physicalCardIndex?: number;
  readonly physicalCopyNumber?: number;
  readonly physicalTotalCopies?: number;
}

interface Props {
  readonly files: readonly File[];
  readonly text: string;
  readonly choices: Readonly<Record<string, ImportKind>>;
  readonly inputContent?: ReactNode;
  readonly diagnosticsContent?: ReactNode;
}

interface ApiErrorBody { readonly code?: string; readonly message?: string; }
interface IdentityDetails extends CardIdentity { readonly layout?: string; readonly relatedCards: readonly { readonly id: string; readonly component: string; readonly name: string; readonly typeLine?: string }[]; }
type ProviderHealth = Record<string, { available: boolean; degraded: boolean; message?: string }>;
interface ArtworkCatalogResponse { readonly candidates: CandidateDto[]; readonly catalogTotal: number; readonly catalogTotalComplete?: boolean; readonly providerHealth: ProviderHealth; readonly mpcDiagnostic?: MpcArtworkProviderDiagnostic; }
interface MpcFilterCatalogResult { readonly catalogs: MpcFilterCatalogs; readonly diagnostic?: MpcArtworkProviderDiagnostic; }
interface FinalPdfProof {
  readonly frontUrl: string;
  readonly backUrl?: string;
  readonly separated: boolean;
  readonly contentMode: ExportContentMode;
  readonly fingerprint: string;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(`Server response was not JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error((body as ApiErrorBody)?.message ?? `Request failed (${response.status}).`);
  return body as T;
}

export type AddCardsFlowPhase = "import" | "resolve";

export interface AddCardsFlowResult extends ResolveWorkingCardsResult {
  readonly report: SafeImportReport;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("A adição de cartas foi cancelada.");
  error.name = "AbortError";
  throw error;
}

export async function runAddCardsFlow(
  form: FormData,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onPhase: (phase: AddCardsFlowPhase) => void = () => undefined,
): Promise<AddCardsFlowResult> {
  throwIfAborted(signal);
  onPhase("import");
  const importResponse = await fetcher("/api/cards/import", { method: "POST", body: form, signal });
  const imported = await jsonResponse<WorkingSetImportResult>(importResponse);
  throwIfAborted(signal);

  onPhase("resolve");
  const resolveResponse = await fetcher("/api/cards/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resolve", cards: imported.workingCards }),
    signal,
  });
  const resolved = await jsonResponse<ResolveWorkingCardsResult>(resolveResponse);
  throwIfAborted(signal);

  return { ...resolved, report: imported.report };
}

export function tryAcquireAddCardsOperation(inFlight: { current: boolean }): boolean {
  if (inFlight.current) return false;
  inFlight.current = true;
  return true;
}

function labelSource(source: string): string {
  return source === "scryfall" ? "Scryfall" : source === "mpc" ? "MPC Autofill" : source === "upload" ? "Meus uploads" : source;
}

function displayCard(card: WorkingCard): string {
  return card.identity?.name ?? card.identityHints.name ?? card.importSource.filename ?? "Carta custom";
}

interface CalibrationBoundsWarningDto {
  readonly side: "front" | "back";
  readonly pageNumber: number;
  readonly content: string;
  readonly nearestEdgeClearanceMm: number;
}

function decodeCalibrationBoundsWarnings(header: string | null): readonly CalibrationBoundsWarningDto[] {
  if (!header || header.length > 12_000) return [];
  try {
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(header.length / 4) * 4, "=");
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)))) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is CalibrationBoundsWarningDto => Boolean(item && typeof item === "object"
      && ((item as CalibrationBoundsWarningDto).side === "front" || (item as CalibrationBoundsWarningDto).side === "back")
      && Number.isSafeInteger((item as CalibrationBoundsWarningDto).pageNumber)
      && typeof (item as CalibrationBoundsWarningDto).content === "string"
      && Number.isFinite((item as CalibrationBoundsWarningDto).nearestEdgeClearanceMm)));
  } catch { return []; }
}

function statusLabel(card: WorkingCard): string {
  if (card.identityResolution.confirmed) return card.identityResolution.status === "custom" ? "Custom confirmado" : "Identidade confirmada";
  if (card.identityResolution.status === "resolved") return "Resolvida automaticamente";
  if (card.identityResolution.status === "suggested") return "Sugestão";
  if (card.identityResolution.status === "ambiguous") return "Ambígua";
  if (card.identityResolution.status === "custom") return "Custom";
  return "Não resolvida";
}

function selectedFor(card: WorkingCard, side: CardFaceSide) {
  return card.selectedArtworkByFace[side];
}

function relatedCardNames(card: WorkingCard): readonly { name: string; component?: string }[] {
  const related = card.identity?.metadata?.relatedCards;
  if (!Array.isArray(related)) return [];
  return related.flatMap((item) => item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
    ? [{ name: (item as { name: string }).name, component: typeof (item as { component?: unknown }).component === "string" ? (item as { component: string }).component : undefined }]
    : []);
}

type DetailField = readonly [label: string, value: string | undefined];

function DetailFields({ fields }: { readonly fields: readonly DetailField[] }) {
  const available = fields.filter(([, value]) => value !== undefined && value !== "");
  if (!available.length) return <p className="muted">Nenhum dado informado.</p>;
  return <dl className="card-detail-fields">{available.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function artworkPolicyLabel(selection: NonNullable<WorkingCard["selectedArtworkByFace"][CardFaceSide]>): string {
  if (selection.selectionPolicy === "user-selected") return "Manual · user-selected";
  return selection.selectionPolicy ? `Automática/default · ${selection.selectionPolicy}` : "Política não registrada";
}

export function WorkingCardDetailsSummary({ card, identityLayout, artworkCandidates = [] }: {
  readonly card: WorkingCard;
  readonly identityLayout?: string;
  readonly artworkCandidates?: readonly ArtworkCandidate[];
}) {
  const identity = card.identity;
  const method = card.identityResolution.method ?? identity?.resolutionMethod;
  const confidence = card.identityResolution.confidence ?? identity?.confidence;
  const artworkFaces = [...new Set(card.faces.map((face) => face.side))];

  return <section className="card-details-summary" aria-label="Card Details">
    <h3>Card Details</h3>
    <div className="identity-summary">
      <span className={`resolution-status status-${card.identityResolution.status}`}>{statusLabel(card)}</span>
    </div>
    <div className="card-details-grid">
      <section className="card-details-section" aria-label="Origem e hints importados">
        <h4>Origem</h4>
        <DetailFields fields={[
          ["Arquivo/origem", card.importSource.filename ?? card.importSource.sourceId],
          ["Tipo de import", card.importSource.importKind],
          ["Seção", card.section],
        ]} />
        <h4>Hints importados</h4>
        <DetailFields fields={[
          ["Nome", card.identityHints.name],
          ["Set", card.identityHints.setCode?.toUpperCase()],
          ["Collector", card.identityHints.collectorNumber],
          ["Idioma", card.identityHints.language?.toUpperCase()],
          ["Scryfall ID", card.identityHints.scryfallId],
        ]} />
      </section>
      <section className="card-details-section" aria-label="Identidade atual">
        <h4>Identidade atual</h4>
        {isDoubleFacedIdentity(identity) && <span className="multiface-label" aria-label="Carta dupla-face">Carta dupla-face</span>}
        {!identity && <p className="muted">Nenhuma identidade aplicada.</p>}
        <DetailFields fields={[
          ["Nome", identity?.name],
          ["Set", identity?.setCode?.toUpperCase()],
          ["Collector", identity?.collectorNumber],
          ["Idioma", identity?.lang?.toUpperCase()],
          ["Provider", identity?.provider],
          ["Método de resolução", method],
          ["Status", statusLabel(card)],
          ["Confirmada", card.identityResolution.confirmed ? "sim" : "não"],
          ["Query", card.identityResolution.query],
          ["Confiança", confidence === undefined ? undefined : `${Math.round(confidence * 100)}%`],
          ["Layout", identityLayout],
        ]} />
      </section>
      <section className="card-details-section artwork-details" aria-label="Artwork selecionada por face">
        <h4>Artwork</h4>
        {artworkFaces.map((side) => {
          const selection = card.selectedArtworkByFace[side];
          const candidate = selection && artworkCandidates.find((item) => item.id === selection.candidateId && item.faceId === side);
          const mismatch = Boolean(selection?.selectionPolicy === "user-selected" && selection.identityId && identity && selection.identityId !== identity.id);
          return <article className="card-artwork-detail" key={side}>
            <h5>{side === "front" ? "Front" : "Back"}{card.faces.find((face) => face.side === side)?.name ? ` · ${card.faces.find((face) => face.side === side)?.name}` : ""}</h5>
            {selection ? <DetailFields fields={[
              ["Source", labelSource(selection.source)],
              ["Candidate/referência", selection.candidateId],
              ["Provider asset", selection.providerAssetId],
              ["Selection policy", artworkPolicyLabel(selection)],
              ["Set", candidate?.setCode?.toUpperCase()],
              ["Collector", candidate?.collectorNumber],
              ["Idioma", candidate?.language?.toUpperCase()],
              ["Resolução", candidate?.effectiveDpi ? `${candidate.effectiveDpi} DPI` : undefined],
              ["Disponibilidade", candidate?.originalCached ? "Original validado no cache local" : candidate?.originalAvailable ? "Original disponível no provider; cache local não verificado" : undefined],
            ]} /> : <p className="muted">Nenhuma artwork selecionada.</p>}
            {mismatch && <p className="artwork-identity-mismatch" role="note">Artwork escolhida manualmente para outra identidade.</p>}
          </article>;
        })}
        {card.manualBackArtwork && <article className="card-artwork-detail" aria-label="Verso físico manual">
          <h5>Verso físico manual</h5>
          <DetailFields fields={[
            ["Source", labelSource(card.manualBackArtwork.source)],
            ["Candidate/referência", card.manualBackArtwork.candidateId],
            ["Provider asset", card.manualBackArtwork.providerAssetId],
            ["Artwork selecionada", card.manualBackArtwork.selectedArtworkId],
            ["Face de origem da artwork", card.manualBackArtwork.faceId],
            ["Selection policy", artworkPolicyLabel(card.manualBackArtwork)],
          ]} />
          <p className="muted">Esta arte foi atribuída ao verso físico; ela não cria uma face DFC na identidade.</p>
        </article>}
      </section>
    </div>
  </section>;
}

interface WorkingCardListProps {
  readonly cards: readonly WorkingCard[];
  readonly selectedCardId: string | null;
  readonly physicalCardCount: number;
  readonly disabled: boolean;
  readonly onSelect: (cardId: string) => void;
  readonly onQuantityCommit: (cardId: string, value: string) => void;
  readonly onQuantityAdjust: (cardId: string, delta: -1 | 1) => void;
  readonly onMove: (cardId: string, targetIndex: number) => void;
  readonly onDuplicate: (cardId: string) => void;
  readonly onDelete: (cardId: string) => void;
}

export function WorkingCardList({ cards, selectedCardId, physicalCardCount, disabled, onSelect, onQuantityCommit, onQuantityAdjust, onMove, onDuplicate, onDelete }: WorkingCardListProps) {
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});
  const orderedCards = cards.slice().sort((left, right) => left.order - right.order);

  return <div className="working-card-list" aria-label="Working cards da sessão">
    <div className="compact-heading"><strong>{cards.length} {cards.length === 1 ? "entrada" : "entradas"} · {physicalCardCount} {physicalCardCount === 1 ? "carta física" : "cartas físicas"}</strong><span>quantidade compacta</span></div>
    {orderedCards.map((card, index) => {
      const name = displayCard(card);
      const quantityDraft = quantityDrafts[card.id] ?? String(card.quantity);
      const maximumQuantity = Math.max(card.quantity, MAX_PHYSICAL_CARDS_PER_EXPORT - physicalCardCount + card.quantity);
      const artworkStatus = (["front", "back"] as const)
        .filter((side) => card.faces.some((item) => item.side === side))
        .map((side) => `${side === "front" ? "Front" : "Back"}: ${card.selectedArtworkByFace[side] ? labelSource(card.selectedArtworkByFace[side]!.source) : "sem arte"}`)
        .join(" · ");
      const physicalBackStatus = card.manualBackArtwork
        ? `Verso físico manual: ${labelSource(card.manualBackArtwork.source)}`
        : card.manualBackAsset ? "Verso físico manual: Back Library" : "";

      return <article
        key={card.id}
        className={`working-card-row ${card.id === selectedCardId ? "is-active" : ""}`}
        onDragOver={(event) => {
          if (disabled) return;
          if (event.dataTransfer.types.includes("text/plain")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          const draggedCardId = event.dataTransfer.getData("text/plain");
          if (draggedCardId) onMove(draggedCardId, index);
        }}
      >
        <span
          className="working-card-drag"
          draggable={!disabled}
          aria-label={`Arraste ${name} para reordenar`}
          title="Arraste para reordenar"
          onDragStart={(event) => {
            if (disabled) return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", card.id);
          }}
        >⠿</span>
        <button type="button" className="working-card-select" aria-pressed={card.id === selectedCardId} disabled={disabled} onClick={() => onSelect(card.id)}>
          <span className="working-card-name">{index + 1}/{orderedCards.length} · {name}{isDoubleFacedIdentity(card.identity) && <span className="multiface-label" aria-label="Carta dupla-face"> · Carta dupla-face</span>}</span>
          <span className="working-card-meta">×{card.quantity} · {card.section ?? "sem seção"} · {statusLabel(card)}</span>
          <span className="working-card-meta">{[artworkStatus, physicalBackStatus].filter(Boolean).join(" · ")}</span>
        </button>
        <div className="working-card-controls">
          <div className="working-card-quantity" role="group" aria-label={`Quantidade de ${name}`}>
            <button className="button secondary" type="button" aria-label={`Diminuir quantidade de ${name}`} disabled={disabled || card.quantity <= 1} onClick={() => {
              setQuantityDrafts((current) => { const next = { ...current }; delete next[card.id]; return next; });
              onQuantityAdjust(card.id, -1);
            }}>−</button>
            <input
              aria-label={`Quantidade de ${name}`}
              type="number"
              min={1}
              max={maximumQuantity}
              step={1}
              value={quantityDraft}
              disabled={disabled}
              onChange={(event) => setQuantityDrafts((current) => ({ ...current, [card.id]: event.currentTarget.value }))}
              onBlur={() => {
                onQuantityCommit(card.id, quantityDraft);
                setQuantityDrafts((current) => { const next = { ...current }; delete next[card.id]; return next; });
              }}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            />
            <button className="button secondary" type="button" aria-label={`Aumentar quantidade de ${name}`} disabled={disabled || physicalCardCount >= MAX_PHYSICAL_CARDS_PER_EXPORT} onClick={() => {
              setQuantityDrafts((current) => { const next = { ...current }; delete next[card.id]; return next; });
              onQuantityAdjust(card.id, 1);
            }}>+</button>
          </div>
          <button className="button secondary" type="button" aria-label={`Mover ${name} para cima`} disabled={disabled || index === 0} onClick={() => onMove(card.id, index - 1)}>↑</button>
          <button className="button secondary" type="button" aria-label={`Mover ${name} para baixo`} disabled={disabled || index === orderedCards.length - 1} onClick={() => onMove(card.id, index + 1)}>↓</button>
          <button className="button secondary" type="button" aria-label={`Duplicar ${name}`} disabled={disabled || physicalCardCount + card.quantity > MAX_PHYSICAL_CARDS_PER_EXPORT} onClick={() => onDuplicate(card.id)}>Duplicar</button>
          <button className="button secondary" type="button" aria-label={`Excluir ${name}`} disabled={disabled} onClick={() => onDelete(card.id)}>Excluir</button>
        </div>
      </article>;
    })}
  </div>;
}

export interface EditorUiState extends WorkingCardEditorState {
  readonly error?: string;
  readonly face: CardFaceSide;
}

export interface EditorHistoryUiState extends EditorHistoryState {
  readonly error?: string;
}

export type EditorCommandAction =
  | { readonly type: "load-cards"; readonly cards: readonly WorkingCard[] }
  | { readonly type: "load-project"; readonly cards: readonly WorkingCard[]; readonly physicalOrder?: PhysicalOrder }
  | { readonly type: "replace-cards"; readonly cards: readonly WorkingCard[]; readonly physicalOrder?: PhysicalOrder }
  | { readonly type: "replace-card"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-identity-result"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-custom-result"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-artwork-selection"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-artwork-default"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-reresolve-result"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-resolve-all-result"; readonly cards: readonly WorkingCard[]; readonly physicalOrder?: PhysicalOrder }
  | { readonly type: "select-card"; readonly cardId: string }
  | { readonly type: "set-quantity"; readonly cardId: string; readonly quantity: number }
  | { readonly type: "adjust-quantity"; readonly cardId: string; readonly delta: -1 | 1 }
  | { readonly type: "move-card"; readonly cardId: string; readonly targetIndex: number }
  | { readonly type: "duplicate-card"; readonly cardId: string; readonly newCardId: string }
  | { readonly type: "delete-card"; readonly cardId: string }
  | { readonly type: "reorder-physical-instance"; readonly instanceId: string; readonly targetInstanceId: string | null; readonly placement?: "before" | "after" }
  | { readonly type: "remove-physical-instance"; readonly instanceId: string }
  | { readonly type: "duplicate-physical-instance"; readonly instanceId: string; readonly newCardId: string }
  | { readonly type: "set-face"; readonly side: CardFaceSide };

export type EditorAction = EditorCommandAction
  | { readonly type: "undo" }
  | { readonly type: "redo" };

function activeFaceFor(card: WorkingCard | undefined, preferredFace: CardFaceSide): CardFaceSide {
  if (!card) return "front";
  if (card.faces.some((item) => item.side === preferredFace)) return preferredFace;
  if (card.faces.some((item) => item.side === "front")) return "front";
  return card.faces[0]?.side ?? "front";
}

function withActiveFace(state: WorkingCardEditorState, preferredFace: CardFaceSide): EditorUiState {
  const activeCard = state.cards.find((card) => card.id === state.selectedCardId);
  return { ...state, face: activeFaceFor(activeCard, preferredFace) };
}

function preserveActiveFace(state: EditorUiState, next: WorkingCardEditorState): EditorUiState {
  return withActiveFace(next, state.face);
}

export function workingCardEditorReducer(state: EditorUiState, action: EditorCommandAction): EditorUiState {
  try {
    switch (action.type) {
      case "load-cards": return withActiveFace(createWorkingCardEditorState(action.cards), "front");
      case "load-project": return withActiveFace({
        cards: [...action.cards],
        selectedCardId: action.cards[0]?.id ?? null,
        physicalOrder: action.physicalOrder ?? createPhysicalOrder(action.cards),
      }, "front");
      case "replace-cards": return preserveActiveFace(state, replaceWorkingCards(state, action.cards, action.physicalOrder));
      case "replace-card": return preserveActiveFace(state, replaceWorkingCard(state, action.cardId, action.card));
      case "apply-identity-result":
      case "apply-custom-result":
      case "apply-artwork-selection":
      case "apply-artwork-default":
      case "apply-reresolve-result":
        return preserveActiveFace(state, replaceWorkingCard(state, action.cardId, action.card));
      case "apply-resolve-all-result": return preserveActiveFace(state, replaceWorkingCards(state, action.cards, action.physicalOrder));
      case "select-card": {
        if (!state.cards.some((card) => card.id === action.cardId)) {
          throw new WorkingCardEditorError("CARD_NOT_FOUND", `WorkingCard ${action.cardId} was not found.`);
        }
        return withActiveFace({ cards: state.cards, selectedCardId: action.cardId, physicalOrder: state.physicalOrder }, "front");
      }
      case "set-face": return withActiveFace(state, action.side);
      case "set-quantity": return preserveActiveFace(state, setWorkingCardQuantity(state, action.cardId, action.quantity));
      case "adjust-quantity": {
        const card = state.cards.find((item) => item.id === action.cardId);
        return preserveActiveFace(state, setWorkingCardQuantity(state, action.cardId, (card?.quantity ?? 0) + action.delta));
      }
      case "move-card": return preserveActiveFace(state, moveWorkingCard(state, action.cardId, action.targetIndex));
      case "duplicate-card": return preserveActiveFace(state, duplicateWorkingCard(state, action.cardId, action.newCardId));
      case "delete-card": return preserveActiveFace(state, deleteWorkingCard(state, action.cardId));
      case "reorder-physical-instance": return { ...state, ...reorderWorkingCardPhysicalInstance(state, action.instanceId, action.targetInstanceId, action.placement) };
      case "remove-physical-instance": return preserveActiveFace(state, removeWorkingCardPhysicalInstance(state, action.instanceId));
      case "duplicate-physical-instance": return preserveActiveFace(state, duplicatePhysicalInstanceAsEntry(state, action.instanceId, action.newCardId));
    }
  } catch (error) {
    return { ...state, error: error instanceof Error ? error.message : "A operação do Editor falhou." };
  }
}

function snapshotFromEditorState(state: EditorUiState): EditorSnapshot {
  return { cards: state.cards, selectedCardId: state.selectedCardId, face: state.face, physicalOrder: state.physicalOrder };
}

function isEditorialAction(action: EditorCommandAction): boolean {
  switch (action.type) {
    case "replace-cards":
    case "replace-card":
    case "apply-identity-result":
    case "apply-custom-result":
    case "apply-artwork-selection":
    case "apply-artwork-default":
    case "apply-reresolve-result":
    case "apply-resolve-all-result":
    case "set-quantity":
    case "adjust-quantity":
    case "move-card":
    case "duplicate-card":
    case "delete-card":
    case "reorder-physical-instance":
    case "remove-physical-instance":
    case "duplicate-physical-instance":
      return true;
    case "load-cards":
    case "load-project":
    case "select-card":
    case "set-face":
      return false;
  }
}

export function editorHistoryReducer(state: EditorHistoryUiState, action: EditorAction): EditorHistoryUiState {
  if (action.type === "undo") {
    const next = undoEditorHistory(state);
    return next === state ? state : { ...next, error: undefined };
  }
  if (action.type === "redo") {
    const next = redoEditorHistory(state);
    return next === state ? state : { ...next, error: undefined };
  }

  const current: EditorUiState = { ...state.present, error: undefined };
  const next = workingCardEditorReducer(current, action);
  const nextSnapshot = snapshotFromEditorState(next);

  if (next.error) return { ...state, error: next.error };
  if (action.type === "load-cards" || action.type === "load-project") {
    return { ...resetEditorHistory(state, nextSnapshot), error: undefined };
  }

  const nextHistory = isEditorialAction(action)
    ? commitEditorHistory(state, nextSnapshot)
    : updateEditorHistoryPresent(state, nextSnapshot);
  return { ...nextHistory, error: undefined };
}

const initialEditorState: EditorUiState = { ...createWorkingCardEditorState([]), face: "front" };
const initialEditorHistoryState: EditorHistoryUiState = createEditorHistoryState(initialEditorState);

export default function CardIdentityWorkbench({ files, text, choices, inputContent, diagnosticsContent }: Props) {
  const [editorHistory, dispatchEditorAction] = useReducer(editorHistoryReducer, initialEditorHistoryState);
  const projectOpenPendingRef = useRef(false);
  const dispatchEditor = useCallback((action: EditorAction) => {
    if (action.type === "load-project") {
      dispatchEditorAction(action);
      return;
    }
    runIfProjectInteractionUnlocked(projectOpenPendingRef.current, () => dispatchEditorAction(action));
  }, [dispatchEditorAction]);
  const editorState: EditorUiState = { ...editorHistory.present, error: editorHistory.error };
  const workingCards = editorState.cards;
  const physicalOrder = editorState.physicalOrder;
  const selectedCardId = editorState.selectedCardId;
  const [selectedPhysicalInstanceId, setSelectedPhysicalInstanceId] = useState<string | null>(null);
  const [compositorSide, setCompositorSide] = useState<CardFaceSide>(editorState.face);
  const face = editorState.face;
  useEffect(() => { setCompositorSide(face); }, [face]);
  const [artworkCatalogState, setArtworkCatalogState] = useState<KeyedArtworkCatalogResult<CandidateDto> | null>(null);
  const [artworkPageIndex, setArtworkPageIndex] = useState(0);
  const [artworkSearch, setArtworkSearch] = useState("");
  const [artworkSort, setArtworkSort] = useState<ArtworkSort>("recommended");
  const [pendingArtwork, setPendingArtwork] = useState<CandidateDto | null>(null);
  const [pendingBackChoice, setPendingBackChoice] = useState<{ readonly mode: "none" | "project-default" } | { readonly mode: "library"; readonly asset: BackLibraryAssetReference } | null>(null);
  const [pickerScope, setPickerScope] = useState<PickerScope>("entry");
  const [pickerContext, setPickerContext] = useState<ArtworkPickerContext | null>(null);
  const [pickerSide, setPickerSide] = useState<CardFaceSide>("front");
  const pickerOpenerRef = useRef<HTMLElement | null>(null);
  const [qualityChecking, setQualityChecking] = useState<{ requestKey: string; candidateIds: ReadonlySet<string> }>({ requestKey: "", candidateIds: new Set() });
  const [artworkCatalogRevision, setArtworkCatalogRevision] = useState(0);
  const [forcedMpcRefreshRevision, setForcedMpcRefreshRevision] = useState<number | null>(null);
  const [artworkFilter, setArtworkFilter] = useState<ArtworkFilter>("all");
  const [mpcFilters, setMpcFilters] = useState<MpcArtworkFilterInput>({});
  const [mpcCatalogs, setMpcCatalogs] = useState<MpcFilterCatalogs | null>(null);
  const [mpcCatalogProblem, setMpcCatalogProblem] = useState("");
  const [mpcCatalogRetry, setMpcCatalogRetry] = useState(0);
  const [mpcDiagnostic, setMpcDiagnostic] = useState<MpcArtworkProviderDiagnostic | null>(null);
  const [manualQuery, setManualQuery] = useState("");
  const [autocompleteEnabled, setAutocompleteEnabled] = useState(true);
  const [autocompleteResults, setAutocompleteResults] = useState<{ query: string; names: string[] } | null>(null);
  const manualQueryRef = useRef(manualQuery);
  manualQueryRef.current = manualQuery;
  const autocompleteNames = autocompleteEnabled && autocompleteResults?.query === manualQuery.trim()
    ? autocompleteResults.names
    : [];
  const [manualIdentities, setManualIdentities] = useState<CardIdentity[]>([]);
  const [bleedMm, setBleedMm] = useState("0.625");
  const [roundedCorners, setRoundedCorners] = useState(false);
  const [trimGuideEnabled, setTrimGuideEnabled] = useState(false);
  const [trimGuideExtentMm, setTrimGuideExtentMm] = useState("1");
  const [trimGuideColor, setTrimGuideColor] = useState<GuideColor>("blue");
  const [externalGuideEnabled, setExternalGuideEnabled] = useState(false);
  const [externalGuideStrokeWidthPt, setExternalGuideStrokeWidthPt] = useState("0.3");
  const [externalGuideColor, setExternalGuideColor] = useState<GuideColor>("black");
  const [pageOrientation, setPageOrientation] = useState<PageOrientation>("portrait");
  const [cardOrientation, setCardOrientation] = useState<PageOrientation>("portrait");
  const [paperFormat, setPaperFormat] = useState<PaperFormat>(DEFAULT_PROJECT_SETTINGS.paperFormat);
  const [cardFormat, setCardFormat] = useState<CardFormat>(DEFAULT_PROJECT_SETTINGS.cardFormat);
  const [exportContentMode, setExportContentMode] = useState<ExportContentMode>(DEFAULT_PROJECT_SETTINGS.exportContentMode);
  const [missingBackPolicy, setMissingBackPolicy] = useState<MissingBackPolicy>(DEFAULT_PROJECT_SETTINGS.missingBackPolicy);
  const [duplexFlipMode, setDuplexFlipMode] = useState<DuplexFlipMode>(DEFAULT_PROJECT_SETTINGS.duplexFlipMode);
  const [projectDefaultBack, setProjectDefaultBack] = useState<BackLibraryAssetReference | null>(DEFAULT_PROJECT_SETTINGS.projectDefaultBack);
  const [printerProfileSelection, setPrinterProfileSelection] = useState<PrinterProfileSnapshot | null>(DEFAULT_PROJECT_SETTINGS.printerProfileSelection);
  const [printerDuplexMode, setPrinterDuplexMode] = useState<PrinterDuplexMode>(DEFAULT_PROJECT_SETTINGS.printerDuplexMode);
  const [marginsMm, setMarginsMm] = useState<PageMarginsMm>({ top: 0, right: 0, bottom: 0, left: 0 });
  const [horizontalGapMm, setHorizontalGapMm] = useState(0);
  const [verticalGapMm, setVerticalGapMm] = useState(0);
  const [registration, setRegistration] = useState<RegistrationConfig>(() => createDefaultRegistrationConfig("none", "portrait"));
  const [registrationOverride, setRegistrationOverride] = useState(false);
  const [templateRegistrationStatus, setTemplateRegistrationStatus] = useState<TemplateRegistrationStatus>("unselected");
  const [layoutRows, setLayoutRows] = useState("");
  const [layoutColumns, setLayoutColumns] = useState("");
  const [skippedSlotIndices, setSkippedSlotIndices] = useState<readonly number[]>([]);
  const [templateGeometry, setTemplateGeometry] = useState<TemplateLayoutGeometryMm | undefined>();
  const [cutSourceSelection, setCutSourceSelection] = useState<CutSourceSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [abortableOperation, setAbortableOperation] = useState<"add-cards" | "artwork" | "export" | "pdf-proof" | null>(null);
  const [projectOpenPending, setProjectOpenPending] = useState(false);
  const [projectRestoreVersion, setProjectRestoreVersion] = useState(0);
  const [activeProjectSync, setActiveProjectSync] = useState<{ readonly projectId: string; readonly revision: number; readonly saved: boolean } | null>(null);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const [problemCardId, setProblemCardId] = useState<string | null>(null);
  const [artworkProblem, setArtworkProblem] = useState<{ message: string; cardId: string; requestKey: string } | null>(null);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth>({});
  const [identityDetails, setIdentityDetails] = useState<IdentityDetails | null>(null);
  const artworkCatalogRequests = useRef(createRequestCache<ArtworkCatalogResponse>());
  const artworkRequestKeyRef = useRef("");
  const artworkCatalogKeyRef = useRef("");
  const qualityHydratorRef = useRef<ArtworkQualityHydrator<CandidateDto> | null>(null);
  if (!qualityHydratorRef.current) {
    qualityHydratorRef.current = new ArtworkQualityHydrator<CandidateDto>(
      async (candidate, signal) => {
        const response = await fetch(`/api/cards/artworks/${encodeURIComponent(candidate.id)}/prepare`, { method: "POST", signal });
        return (await jsonResponse<{ candidate: CandidateDto }>(response)).candidate;
      },
      (requestKey, candidate) => {
        if (artworkRequestKeyRef.current !== requestKey) return;
        updateResolvedRequestCache(artworkCatalogRequests.current, artworkCatalogKeyRef.current, (cached) => ({
          ...cached,
          candidates: cached.candidates.map((item) => item.id === candidate.id ? candidate : item),
        }));
        setArtworkCatalogState((current) => updateArtworkCatalogCandidate(current, requestKey, candidate));
      },
      (requestKey, candidateIds) => setQualityChecking({ requestKey, candidateIds }),
      3,
    );
  }
  const identityDetailsRequests = useRef(createRequestCache<IdentityDetails>());
  const projectRestoreLookupGate = useRef(createProjectRestoreLookupGate(-1));
  const [pdfUrl, setPdfUrl] = useState("");
  const [exportDownloadName, setExportDownloadName] = useState("tcgprint-cards.pdf");
  const [pdfProof, setPdfProof] = useState<FinalPdfProof | null>(null);
  const [pdfProofSide, setPdfProofSide] = useState<"front" | "back">("front");
  const pdfProofTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pdfProofCloseRef = useRef<HTMLButtonElement | null>(null);
  const liveCompositorRef = useRef<HTMLDivElement | null>(null);
  const proofWasOpenRef = useRef(false);
  const activeOperationAbortController = useRef<AbortController | null>(null);
  const addCardsInFlight = useRef(false);
  const [lastImportReport, setLastImportReport] = useState<SafeImportReport | null>(null);
  const [cutGeometryPreview, setCutGeometryPreview] = useState<CutPreviewDto | null>(null);
  const [cutPageNumber, setCutPageNumber] = useState(1);
  const [bleedDiagnostics, setBleedDiagnostics] = useState<BleedDiagnosticsReport | null>(null);
  const [backLibraryAssets, setBackLibraryAssets] = useState<readonly BackLibraryAssetDto[]>([]);
  const interactionBusy = busy || projectOpenPending;
  function setProjectInteractionLocked(locked: boolean) {
    projectOpenPendingRef.current = locked;
    setProjectOpenPending(locked);
  }
  function updateProjectSetting(update: () => void) {
    runIfProjectInteractionUnlocked(projectOpenPendingRef.current, update);
  }
  const projectSettings = useMemo<ProjectSettingsV2>(() => {
    const rowCount = layoutRows.trim() ? Number(layoutRows) : undefined;
    const columnCount = layoutColumns.trim() ? Number(layoutColumns) : undefined;
    const fixedGrid = rowCount !== undefined && columnCount !== undefined
      && Number.isSafeInteger(rowCount) && Number.isSafeInteger(columnCount)
      && rowCount > 0 && columnCount > 0 && rowCount * columnCount <= 1_128;
    return {
      bleedMm: Number(bleedMm),
      roundedCorners,
      cutGuides: buildCutGuideConfig(
      trimGuideEnabled,
      trimGuideExtentMm,
      externalGuideEnabled,
      externalGuideStrokeWidthPt,
      trimGuideColor,
      externalGuideColor,
      ),
      pageOrientation,
      cardOrientation,
      paperFormat,
      cardFormat,
      exportContentMode,
      missingBackPolicy,
      duplexFlipMode,
      projectDefaultBack,
      printerProfileSelection,
      printerDuplexMode,
      marginsMm,
      horizontalGapMm,
      verticalGapMm,
      registration,
      registrationOverride,
      cutSourceSelection,
      layout: {
        ...(fixedGrid ? { rows: rowCount, columns: columnCount } : {}),
        skippedSlotIndices,
        ...(templateGeometry ? { templateGeometry } : {}),
      },
    };
  }, [bleedMm, roundedCorners, trimGuideEnabled, trimGuideExtentMm, externalGuideEnabled, externalGuideStrokeWidthPt, trimGuideColor, externalGuideColor, pageOrientation, cardOrientation, paperFormat, cardFormat, exportContentMode, missingBackPolicy, duplexFlipMode, projectDefaultBack, printerProfileSelection, printerDuplexMode, marginsMm, horizontalGapMm, verticalGapMm, registration, registrationOverride, cutSourceSelection, layoutRows, layoutColumns, skippedSlotIndices, templateGeometry]);

  const compositorFingerprint = useMemo(() => JSON.stringify({ cards: workingCards, settings: projectSettings, cutPreview: cutGeometryPreview }), [workingCards, projectSettings, cutGeometryPreview]);
  const pdfProofIsStale = Boolean(pdfProof && pdfProof.fingerprint !== compositorFingerprint);

  useEffect(() => () => {
    if (pdfProof) {
      URL.revokeObjectURL(pdfProof.frontUrl);
      if (pdfProof.backUrl) URL.revokeObjectURL(pdfProof.backUrl);
    }
  }, [pdfProof]);

  useEffect(() => {
    if (pdfProof) {
      if (!proofWasOpenRef.current) {
        proofWasOpenRef.current = true;
        pdfProofCloseRef.current?.focus();
      }
      return;
    }
    if (proofWasOpenRef.current) {
      proofWasOpenRef.current = false;
      const trigger = pdfProofTriggerRef.current;
      if (trigger && !trigger.disabled && !trigger.closest("[hidden]")) trigger.focus();
      else liveCompositorRef.current?.focus();
    }
  }, [pdfProof]);

  useEffect(() => {
    if (!pdfProof) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setPdfProof(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [pdfProof]);

  function clearProblem(cardId: string | null = null) {
    setProblem("");
    setProblemCardId(cardId);
  }

  function beginAbortableOperation(operation: "add-cards" | "artwork" | "export" | "pdf-proof"): AbortController {
    const controller = new AbortController();
    activeOperationAbortController.current = controller;
    setAbortableOperation(operation);
    return controller;
  }

  function finishAbortableOperation(controller: AbortController): void {
    if (activeOperationAbortController.current !== controller) return;
    activeOperationAbortController.current = null;
    setAbortableOperation(null);
  }

  const closeArtworkPicker = useCallback(() => {
    setPickerContext(null);
    setPendingArtwork(null);
    setPendingBackChoice(null);
  }, []);

  function openArtworkPicker(cardId: string, side: CardFaceSide, opener: HTMLElement, physical?: { readonly instanceId: string; readonly index: number; readonly copyNumber: number; readonly totalCopies: number }) {
    const target = workingCards.find((card) => card.id === cardId);
    if (!target) return;
    pickerOpenerRef.current = opener;
    if (physical) setSelectedPhysicalInstanceId(physical.instanceId);
    if (selectedCardId !== target.id) dispatchEditor({ type: "select-card", cardId: target.id });
    if (isDoubleFacedIdentity(target.identity) && target.faces.some((item) => item.side === side)) dispatchEditor({ type: "set-face", side });
    setPickerSide(side);
    setArtworkFilter(side === "back" && !isDoubleFacedIdentity(target.identity) ? "mpc" : "all");
    setArtworkPageIndex(0);
    setArtworkSearch("");
    setArtworkSort("recommended");
    setPendingArtwork(null);
    setPendingBackChoice(null);
    setPickerScope(physical ? "physical-copy" : "entry");
    setPickerContext({
      cardId: target.id,
      ...(physical ? { physicalInstanceId: physical.instanceId, physicalCardIndex: physical.index, physicalCopyNumber: physical.copyNumber, physicalTotalCopies: physical.totalCopies } : {}),
    });
    setArtworkProblem(null);
  }

  function changeArtworkPickerSide(side: CardFaceSide) {
    if (!artworkTargetCard) return;
    if (isDoubleFacedIdentity(artworkTargetCard.identity)) {
      if (!artworkTargetCard.faces.some((item) => item.side === side)) return;
      dispatchEditor({ type: "set-face", side });
    }
    setPickerSide(side);
    setArtworkFilter(side === "back" && !isDoubleFacedIdentity(artworkTargetCard.identity) ? "mpc" : "all");
    setArtworkPageIndex(0);
    setPendingArtwork(null);
    setPendingBackChoice(null);
    setPickerScope(pickerContext?.physicalCardIndex === undefined ? "entry" : "physical-copy");
  }

  const activeCard = useMemo(() => workingCards.find((card) => card.id === selectedCardId), [workingCards, selectedCardId]);
  const artworkTargetCard = pickerContext ? workingCards.find((card) => card.id === pickerContext.cardId) ?? activeCard : activeCard;
  const pickerIsOpen = Boolean(pickerContext && artworkTargetCard);
  const effectivePickerSide = pickerIsOpen ? pickerSide : face;
  const manualPhysicalBackPicker = Boolean(pickerIsOpen && effectivePickerSide === "back" && artworkTargetCard && !isDoubleFacedIdentity(artworkTargetCard.identity));
  const physicalCardCount = useMemo(() => workingCards.reduce((sum, card) => sum + card.quantity, 0), [workingCards]);
  const physicalInstances = useMemo(() => {
    const byId = new Map(workingCards.map((card) => [card.id, card]));
    const totals = new Map<string, number>();
    for (const instance of physicalOrder.instances) totals.set(instance.workingCardId, (totals.get(instance.workingCardId) ?? 0) + 1);
    const seen = new Map<string, number>();
    return physicalOrder.instances.flatMap((instance, index) => {
      const card = byId.get(instance.workingCardId);
      if (!card) return [];
      const copyNumber = (seen.get(card.id) ?? 0) + 1;
      seen.set(card.id, copyNumber);
      return [{ ...instance, physicalCardIndex: index, copyNumber, totalCopies: totals.get(card.id) ?? card.quantity, card }];
    });
  }, [workingCards, physicalOrder]);
  useEffect(() => {
    if (selectedPhysicalInstanceId && !physicalOrder.instances.some(({ id }) => id === selectedPhysicalInstanceId)) {
      setSelectedPhysicalInstanceId(physicalOrder.instances[0]?.id ?? null);
    }
  }, [selectedPhysicalInstanceId, physicalOrder]);
  const backValidation = useMemo(() => createBackValidationSummary(workingCards, projectDefaultBack, missingBackPolicy), [workingCards, projectDefaultBack, missingBackPolicy]);
  const activeFaceExists = Boolean(manualPhysicalBackPicker || artworkTargetCard?.faces.some((item) => item.side === effectivePickerSide));
  const activeIdentityId = artworkTargetCard?.identity?.id ?? null;
  const artworkRequest = pickerIsOpen && artworkTargetCard && activeFaceExists
    ? {
      identityId: activeIdentityId ?? "custom:artwork-picker",
      faceId: manualPhysicalBackPicker ? "front" as const : effectivePickerSide,
      source: manualPhysicalBackPicker ? "mpc" : artworkFilter,
      mpcReferences: artworkTargetCard.mpcReferences,
      mpcFilters: manualPhysicalBackPicker || artworkFilter === "mpc" ? mpcFilters : undefined,
      forceMpcRefresh: (manualPhysicalBackPicker || artworkFilter === "mpc") && forcedMpcRefreshRevision === artworkCatalogRevision,
      cacheKey: JSON.stringify([activeIdentityId, manualPhysicalBackPicker ? "physical-back" : effectivePickerSide, manualPhysicalBackPicker, manualPhysicalBackPicker ? "mpc-cardbacks" : artworkFilter, artworkTargetCard.mpcReferences, manualPhysicalBackPicker || artworkFilter === "mpc" ? mpcFilters : undefined, artworkCatalogRevision]),
    }
    : null;
  const currentArtworkCatalogKey = artworkRequest?.cacheKey ?? "";
  const currentArtworkRequestKey = artworkRequest ? JSON.stringify([artworkTargetCard?.id, artworkRequest.cacheKey]) : "";
  const currentArtworkCatalog = artworkCatalogForRequest(artworkCatalogState, currentArtworkRequestKey);
  const artworkCandidates = currentArtworkCatalog.candidates;
  const artworkCatalogTotal = currentArtworkCatalog.catalogTotal;
  const filterCards = useMemo(() => manualPhysicalBackPicker && artworkTargetCard
    ? artworkCandidates.filter((candidate) => isEligibleGenericPhysicalBack(artworkTargetCard, candidate))
    : artworkCandidates.filter((candidate) => artworkFilter === "all" || candidate.source === artworkFilter), [artworkTargetCard, artworkCandidates, artworkFilter, manualPhysicalBackPicker]);
  const filteredArtworkCandidates = useMemo(
    () => filterAndSortArtworkCandidates(filterCards, artworkSearch, artworkSort),
    [filterCards, artworkSearch, artworkSort],
  );
  const visibleArtworkCandidates = sliceArtworkPage(filteredArtworkCandidates, artworkPageIndex, ARTWORK_WINDOW_SIZE);
  const windowedArtworkCandidates = visibleArtworkCandidates;
  const windowedCandidateKey = windowedArtworkCandidates.map(({ id }) => id).join("\n");
  const qualityCheckingIds = qualityChecking.requestKey === currentArtworkRequestKey ? qualityChecking.candidateIds : new Set<string>();
  artworkRequestKeyRef.current = currentArtworkRequestKey;
  artworkCatalogKeyRef.current = currentArtworkCatalogKey;
  const visibleProblem = problem && (problemCardId === null || problemCardId === selectedCardId) ? problem : "";
  const visibleArtworkProblem = artworkProblem
    && artworkProblem.cardId === artworkTargetCard?.id
    && artworkProblem.requestKey === artworkRequest?.cacheKey
    ? artworkProblem.message
    : "";

  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);
  useEffect(() => () => { activeOperationAbortController.current?.abort(); }, []);

  useEffect(() => {
    let current = true;
    void fetch("/api/back-library", { cache: "no-store" })
      .then((response) => jsonResponse<{ assets: BackLibraryAssetDto[] }>(response))
      .then(({ assets }) => { if (current) setBackLibraryAssets(assets); })
      .catch(() => { if (current) setBackLibraryAssets([]); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || interactionBusy) return;
      const target = event.target;
      const textEditingFocused = target instanceof HTMLElement && isEditorTextEditingTarget(target);
      const command = editorHistoryShortcut(event, textEditingFocused);
      if (!command) return;
      event.preventDefault();
      dispatchEditor({ type: command });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [interactionBusy]);

  useEffect(() => {
    const query = manualQuery.trim();
    if (!autocompleteEnabled || query.length < 2) { setAutocompleteResults(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/cards/autocomplete?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        const result = await jsonResponse<{ names: string[] }>(response);
        if (controller.signal.aborted || manualQueryRef.current.trim() !== query) return;
        setAutocompleteResults({ query, names: result.names.slice(0, 8) });
      } catch (error) {
        if (!controller.signal.aborted && manualQueryRef.current.trim() === query) setAutocompleteResults(null);
      }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [manualQuery, autocompleteEnabled]);

  useEffect(() => {
    if (!pickerIsOpen || artworkFilter !== "mpc" || mpcCatalogs) return;
    const controller = new AbortController();
    void fetch("/api/cards/artworks/mpc-catalogs", { signal: controller.signal, cache: "no-store" })
      .then((response) => jsonResponse<MpcFilterCatalogResult>(response))
      .then((result) => {
        if (controller.signal.aborted) return;
        setMpcCatalogs(result.catalogs);
        setMpcDiagnostic(result.diagnostic ?? null);
        setMpcCatalogProblem("");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setMpcCatalogProblem(error instanceof Error ? error.message : "Catálogos avançados MPC indisponíveis.");
      });
    return () => controller.abort();
  }, [artworkFilter, mpcCatalogs, mpcCatalogRetry, pickerIsOpen]);

  useEffect(() => {
    let current = true;
    const requestKey = currentArtworkRequestKey;
    const request = runProjectRestoreProviderLookup(
      projectRestoreLookupGate.current,
      projectRestoreVersion,
      "artwork",
      async () => {
        if (!artworkRequest || !artworkTargetCard) return null;
        const forceMpcRefresh = artworkRequest.forceMpcRefresh;
        if (forceMpcRefresh) setForcedMpcRefreshRevision(null);
        return getOrCreateCachedRequest(artworkCatalogRequests.current, artworkRequest.cacheKey, async () => {
          const response = await fetch(`/api/cards/${encodeURIComponent(artworkRequest.identityId)}/artworks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ faceId: artworkRequest.faceId, source: artworkRequest.source, physicalBackArtwork: manualPhysicalBackPicker, mpcReferences: artworkRequest.mpcReferences, ...(artworkRequest.mpcFilters ? { mpcFilters: artworkRequest.mpcFilters } : {}), ...(forceMpcRefresh ? { forceMpcRefresh: true } : {}) }),
          });
          return jsonResponse<ArtworkCatalogResponse>(response);
        });
      });
    void request
      .then((outcome) => {
        if (!current || artworkRequestKeyRef.current !== requestKey) return;
        if (outcome.skipped || outcome.value === null) {
          setArtworkCatalogState({ requestKey, candidates: [], catalogTotal: 0, catalogTotalComplete: false });
          setArtworkProblem(null);
          return;
        }
        const result = outcome.value;
        setArtworkProblem(null);
        setArtworkCatalogState({ requestKey, candidates: result.candidates, catalogTotal: result.catalogTotal, catalogTotalComplete: result.catalogTotalComplete });
        setProviderHealth((current) => ({ ...current, ...result.providerHealth }));
        setMpcDiagnostic(result.mpcDiagnostic ?? null);
      })
      .catch((error: unknown) => {
        if (current && artworkRequestKeyRef.current === requestKey && artworkTargetCard && artworkRequest) {
          setArtworkCatalogState((existing) => existing?.requestKey === requestKey
            ? existing
            : { requestKey, candidates: [], catalogTotal: 0, catalogTotalComplete: false });
          setArtworkProblem({
            message: error instanceof Error ? error.message : "Não foi possível abrir o catálogo de artes.",
            cardId: artworkTargetCard.id,
            requestKey: artworkRequest.cacheKey,
          });
        }
      });
    return () => { current = false; };
  }, [artworkRequest?.cacheKey, artworkTargetCard?.id, projectRestoreVersion]);

  useEffect(() => {
    qualityHydratorRef.current?.reset(currentArtworkRequestKey);
    setArtworkPageIndex(0);
    return () => qualityHydratorRef.current?.cancel(currentArtworkRequestKey);
  }, [currentArtworkRequestKey]);

  useEffect(() => { setArtworkPageIndex(0); }, [artworkSearch, artworkSort, artworkFilter]);

  useEffect(() => {
    if (!pickerContext?.physicalInstanceId) return;
    const selected = physicalInstances.find(({ id }) => id === pickerContext.physicalInstanceId);
    if (selected && (selected.card.id !== pickerContext.cardId || selected.physicalCardIndex !== pickerContext.physicalCardIndex)) {
      setPickerContext((current) => current && current.physicalInstanceId === pickerContext.physicalInstanceId
        ? { ...current, cardId: selected.card.id, physicalCardIndex: selected.physicalCardIndex, physicalCopyNumber: selected.copyNumber, physicalTotalCopies: selected.totalCopies }
        : current);
      if (selectedCardId !== selected.card.id) dispatchEditor({ type: "select-card", cardId: selected.card.id });
    } else if (selected && selected.card.id !== pickerContext.cardId) {
      setPickerContext((current) => current && current.physicalInstanceId === pickerContext.physicalInstanceId ? { ...current, cardId: selected.card.id } : current);
    }
  }, [physicalInstances, pickerContext, selectedCardId]);

  useEffect(() => {
    qualityHydratorRef.current?.schedule(currentArtworkRequestKey, windowedArtworkCandidates);
  }, [currentArtworkRequestKey, windowedCandidateKey]);

  useEffect(() => {
    let current = true;
    const request = runProjectRestoreProviderLookup(
      projectRestoreLookupGate.current,
      projectRestoreVersion,
      "identity",
      async () => {
        if (!activeIdentityId) return null;
        return getOrCreateCachedRequest(identityDetailsRequests.current, activeIdentityId, async () => {
          const response = await fetch(`/api/cards/${encodeURIComponent(activeIdentityId)}`);
          const result = await jsonResponse<{ identity: IdentityDetails }>(response);
          return result.identity;
        });
      });
    void request
      .then((outcome) => {
        if (!current) return;
        setIdentityDetails(outcome.skipped ? null : outcome.value);
      })
      .catch(() => { if (current) setIdentityDetails(null); });
    return () => { current = false; };
  }, [activeIdentityId, projectRestoreVersion]);

  async function addCards() {
    if (projectOpenPendingRef.current) return;
    if (!files.length && !text.trim()) { clearProblem(); setProblem("Adicione arquivos ou cole uma decklist antes de adicionar."); return; }
    if (!tryAcquireAddCardsOperation(addCardsInFlight)) return;
    const controller = beginAbortableOperation("add-cards");
    setBusy(true); clearProblem(); setStatus("Lendo entradas / preparando cartas…"); setPdfUrl("");
    try {
      const form = new FormData();
      files.forEach((file) => form.append("files", file, file.name));
      form.set("filePaths", JSON.stringify(files.map((file) => file.webkitRelativePath || "")));
      if (text.trim()) form.set("text", text);
      form.set("selections", JSON.stringify(choices));
      const result = await runAddCardsFlow(form, controller.signal, fetch, (phase) => {
        setStatus(phase === "import" ? "Lendo entradas / preparando cartas…" : "Resolvendo identidades…");
      });
      throwIfAborted(controller.signal);
      if (projectOpenPendingRef.current) throw new Error("O Project está sendo aberto. Tente adicionar as cartas novamente.");
      clearRequestCache(artworkCatalogRequests.current);
      setArtworkCatalogRevision((revision) => revision + 1);
      setArtworkCatalogState(null);
      setArtworkProblem(null);
      dispatchEditor({ type: "load-cards", cards: result.workingCards });
      setArtworkFilter("all"); setManualIdentities([]);
      setProviderHealth(result.providerHealth);
      setLastImportReport(result.report);
      const attentionCount = result.workingCards.filter((card) => ["suggested", "ambiguous", "unresolved"].includes(card.identityResolution.status)).length;
      const attentionSummary = attentionCount === 1 ? "1 entrada precisa de atenção." : `${attentionCount} entradas precisam de atenção.`;
      const resolutionSummary = formatResolutionSummary(result.workingCards, result.providerHealth).replace(/^Resolução: /, "");
      setStatus(`Pronto · ${resolutionSummary} · ${attentionSummary}`);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        setProblem(""); setStatus("Adição cancelada.");
      } else {
        setProblem(error instanceof Error ? error.message : "Não foi possível adicionar as cartas."); setStatus("");
      }
    } finally {
      finishAbortableOperation(controller);
      addCardsInFlight.current = false;
      setBusy(false);
    }
  }

  async function reresolveCard(card: WorkingCard) {
    setBusy(true); clearProblem(card.id); setStatus("Re-resolvendo esta entrada pelos hints e origem importados…");
    try {
      const response = await fetch("/api/cards/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reresolve", card }) });
      const result = await jsonResponse<{ workingCards: WorkingCard[]; providerHealth: typeof providerHealth }>(response);
      dispatchEditor({ type: "apply-reresolve-result", cardId: card.id, card: result.workingCards[0] });
      setProviderHealth(result.providerHealth);
      setStatus(`${displayCard(result.workingCards[0])} re-resolvida.`);
    } catch (error) { setProblem(error instanceof Error ? error.message : "Não foi possível re-resolver esta carta."); setStatus(""); }
    finally { setBusy(false); }
  }

  async function confirmIdentity(card: WorkingCard, identity: CardIdentity) {
    if (!identity.scryfallId) { clearProblem(card.id); setProblem("A identidade escolhida não tem Scryfall ID."); return; }
    setBusy(true); clearProblem(card.id);
    try {
      const response = await fetch("/api/cards/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm", card, scryfallId: identity.scryfallId }) });
      const result = await jsonResponse<{ workingCards: WorkingCard[]; providerHealth: typeof providerHealth }>(response);
      dispatchEditor({ type: "apply-identity-result", cardId: card.id, card: result.workingCards[0] }); setProviderHealth(result.providerHealth);
      setManualIdentities([]); setStatus(`${identity.name} confirmada.`);
    } catch (error) { setProblem(error instanceof Error ? error.message : "Não foi possível confirmar a identidade."); }
    finally { setBusy(false); }
  }

  async function keepCustom(card: WorkingCard) {
    setBusy(true); clearProblem(card.id);
    try {
      const response = await fetch("/api/cards/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "custom", cards: [card] }) });
      const result = await jsonResponse<{ workingCards: WorkingCard[] }>(response);
      dispatchEditor({ type: "apply-custom-result", cardId: card.id, card: result.workingCards[0] }); setStatus(`${displayCard(card)} mantida como custom.`);
    } catch (error) { setProblem(error instanceof Error ? error.message : "Não foi possível manter como custom."); }
    finally { setBusy(false); }
  }

  async function searchIdentities(query = manualQuery) {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    const problemCardId = selectedCardId;
    setAutocompleteEnabled(false);
    setAutocompleteResults(null);
    setBusy(true); clearProblem(problemCardId);
    try {
      const response = await fetch(`/api/cards/search?q=${encodeURIComponent(trimmed)}`);
      const result = await jsonResponse<{ identities: CardIdentity[] }>(response);
      setManualIdentities(result.identities);
      if (!result.identities.length) setProblem("Nenhuma carta encontrada para essa busca.");
    } catch (error) { setProblem(error instanceof Error ? error.message : "Busca manual falhou."); }
    finally { setBusy(false); }
  }

  function chooseArtwork(candidate: CandidateDto) {
    setPendingArtwork(candidate);
    setPendingBackChoice(null);
    setPickerScope(pickerContext?.physicalCardIndex === undefined ? "entry" : "physical-copy");
  }

  function chooseSemanticBack(choice: { readonly mode: "none" | "project-default" } | { readonly mode: "library"; readonly asset: BackLibraryAssetReference }) {
    setPendingArtwork(null);
    setPendingBackChoice(choice);
    setPickerScope(pickerContext?.physicalCardIndex === undefined ? "entry" : "physical-copy");
  }

  async function confirmArtworkSelection() {
    if (!artworkTargetCard || !artworkRequest || (!pendingArtwork && !pendingBackChoice)) return;
    const controller = beginAbortableOperation("artwork");
    const problemCardId = artworkTargetCard.id;
    const problemRequestKey = artworkRequest.cacheKey;
    setBusy(true); setArtworkProblem(null); clearProblem(problemCardId);
    try {
      const candidate = pendingArtwork;
      if (candidate?.originalAvailable) {
        const prepareResponse = await fetch(`/api/cards/artworks/${encodeURIComponent(candidate.id)}/prepare`, { method: "POST", signal: controller.signal });
        const prepared = await jsonResponse<{ candidate: CandidateDto }>(prepareResponse);
        updateResolvedRequestCache(artworkCatalogRequests.current, problemRequestKey, (cached) => ({
          ...cached,
          candidates: cached.candidates.map((item) => item.id === prepared.candidate.id ? prepared.candidate : item),
        }));
        setArtworkCatalogState((current) => updateArtworkCatalogCandidate(current, currentArtworkRequestKey, prepared.candidate));
      }
      const scope = manualPhysicalBackPicker
        ? pickerScope
        : pickerScope === "all-simple-project" ? "same-identity" : pickerScope;
      const response = await fetch("/api/cards/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(pendingBackChoice
          ? {
            action: "apply-generic-back-scope", cards: workingCards, physicalOrder, targetCardId: artworkTargetCard.id,
            scope, choiceMode: pendingBackChoice.mode,
            ...(pendingBackChoice.mode === "library" ? { asset: pendingBackChoice.asset } : {}),
            ...(pickerContext?.physicalCardIndex === undefined ? {} : { physicalCardIndex: pickerContext.physicalCardIndex }),
            ...(pickerContext?.physicalInstanceId ? { physicalInstanceId: pickerContext.physicalInstanceId } : {}),
          }
          : manualPhysicalBackPicker
            ? {
              action: "apply-generic-back-scope", cards: workingCards, physicalOrder, targetCardId: artworkTargetCard.id,
              scope, choiceMode: "mpc", candidateId: candidate!.id,
              ...(pickerContext?.physicalCardIndex === undefined ? {} : { physicalCardIndex: pickerContext.physicalCardIndex }),
              ...(pickerContext?.physicalInstanceId ? { physicalInstanceId: pickerContext.physicalInstanceId } : {}),
            }
            : {
              action: "apply-artwork-scope", cards: workingCards, physicalOrder, targetCardId: artworkTargetCard.id,
              faceId: effectivePickerSide, scope, candidateId: candidate!.id,
              ...(pickerContext?.physicalCardIndex === undefined ? {} : { physicalCardIndex: pickerContext.physicalCardIndex }),
              ...(pickerContext?.physicalInstanceId ? { physicalInstanceId: pickerContext.physicalInstanceId } : {}),
            }),
      });
      const result = await jsonResponse<{ workingCards: WorkingCard[]; physicalOrder?: PhysicalOrder; selectedCardId?: string; providerHealth?: ProviderHealth; impact?: { affectedPhysicalCards: number; preservedDfcPhysicalCards: number } }>(response);
      dispatchEditor({ type: "apply-resolve-all-result", cards: result.workingCards, ...(result.physicalOrder ? { physicalOrder: result.physicalOrder } : {}) });
      if (pickerContext?.physicalInstanceId && result.physicalOrder) {
        const updatedInstance = result.physicalOrder.instances.find(({ id }) => id === pickerContext.physicalInstanceId);
        const selectedId = updatedInstance?.workingCardId ?? result.selectedCardId;
        if (selectedId) {
          setPickerContext((current) => current ? { ...current, cardId: selectedId } : current);
          setSelectedPhysicalInstanceId(pickerContext.physicalInstanceId);
          dispatchEditor({ type: "select-card", cardId: selectedId });
        }
      } else if (result.selectedCardId) {
        setPickerContext((current) => current ? { ...current, cardId: result.selectedCardId! } : current);
        dispatchEditor({ type: "select-card", cardId: result.selectedCardId });
      }
      if (result.providerHealth) setProviderHealth((current) => ({ ...current, ...result.providerHealth }));
      if (result.impact) {
        setStatus(`Verso aplicado a ${result.impact.affectedPhysicalCards} carta(s) simples; ${result.impact.preservedDfcPhysicalCards} cartas dupla-face preservadas.`);
      } else if (manualPhysicalBackPicker || pendingBackChoice) {
        setStatus(candidate?.originalAvailable ? "Verso aplicado; original validado e armazenado no cache." : "Verso aplicado pela referência MPC validada.");
      } else {
        setStatus(candidate?.originalAvailable ? "Artwork selecionado; original validado e armazenado no cache." : "Referência MPC selecionada; nenhum original local está disponível.");
      }
      setPendingArtwork(null);
      setPendingBackChoice(null);
    } catch (error) {
      if (controller.signal.aborted) {
        setArtworkProblem(null);
        setStatus("Download/seleção da arte cancelado.");
      } else {
        setArtworkProblem({
          message: error instanceof Error ? error.message : "Não foi possível selecionar essa arte.",
          cardId: problemCardId,
          requestKey: problemRequestKey,
        });
      }
    }
    finally { finishAbortableOperation(controller); setBusy(false); }
  }

  async function refreshMpcMetadata(candidate: CandidateDto) {
    if (candidate.source !== "mpc" || !artworkRequest || !artworkTargetCard) return;
    const requestKey = artworkRequest.cacheKey;
    setBusy(true); setArtworkProblem(null);
    try {
      const response = await fetch(`/api/cards/artworks/${encodeURIComponent(candidate.id)}/refresh`, { method: "POST" });
      const result = await jsonResponse<{ candidate: CandidateDto }>(response);
      setArtworkCatalogState((current) => updateArtworkCatalogCandidate(current, currentArtworkRequestKey, result.candidate));
      updateResolvedRequestCache(artworkCatalogRequests.current, requestKey, (cached) => ({
        ...cached,
        candidates: cached.candidates.map((item) => item.id === candidate.id ? result.candidate : item),
      }));
    } catch (error) {
      setArtworkProblem({ message: error instanceof Error ? error.message : "Não foi possível revalidar os metadados MPC.", cardId: artworkTargetCard.id, requestKey });
    } finally { setBusy(false); }
  }

  async function restoreArtworkDefault(card: WorkingCard, side: CardFaceSide) {
    if (!artworkRequest) return;
    const problemRequestKey = artworkRequest.cacheKey;
    setBusy(true); setArtworkProblem(null); clearProblem(card.id);
    try {
      const response = await fetch("/api/cards/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore-default-artwork", card, faceId: side }),
      });
      const result = await jsonResponse<{ workingCards: WorkingCard[]; providerHealth: typeof providerHealth }>(response);
      dispatchEditor({ type: "apply-artwork-default", cardId: card.id, card: result.workingCards[0] });
      setProviderHealth(result.providerHealth);
      setStatus(`Artwork padrão restaurada em ${side === "front" ? "Front" : "Back"}.`);
    } catch (error) {
      setArtworkProblem({
        message: error instanceof Error ? error.message : "Não foi possível restaurar a artwork padrão desta face.",
        cardId: card.id,
        requestKey: problemRequestKey,
      });
    }
    finally { setBusy(false); }
  }

  function updateCardBackMode(card: WorkingCard, mode: WorkingCardBackMode) {
    const next = mode === "auto" ? restoreAutomaticBackSelection(card) : setWorkingCardBackMode(card, mode);
    dispatchEditor({ type: "replace-card", cardId: card.id, card: next });
  }

  function exportIsReady(): boolean {
    if (!workingCards.length) return false;
    if (!projectCutSyncReady) {
      setProblem("Aguarde o autosave e a validação da geometria de corte do Project antes de gerar o PDF.");
      return false;
    }
    if (templateRegistrationRequiresUserChoice(templateRegistrationStatus)) {
      setProblem(templateRegistrationStatus === "legacy-custom-unconfigured"
        ? "O template custom legado não tem geometria de registration. Escolha uma configuração física no Project antes de exportar."
        : templateRegistrationStatus === "legacy-physical-format-unconfigured"
          ? "O template legado não tem dimensões físicas de papel/carta. Selecione uma versão com geometria física explícita antes de exportar."
          : "A versão selecionada ainda não foi verificada. Revise ou desassocie o template antes de exportar.");
      return false;
    }
    return true;
  }

  function exportRequestBody(contentMode: ExportContentMode) {
    return JSON.stringify({ cards: workingCards, options: {
      physicalOrder,
      ...buildBleedExportOptions(
        bleedMm,
        buildCutGuideConfig(trimGuideEnabled, trimGuideExtentMm, externalGuideEnabled, externalGuideStrokeWidthPt, trimGuideColor, externalGuideColor),
        roundedCorners,
      ),
      pageOrientation,
      cardOrientation,
      paperFormat,
      cardFormat,
      marginsMm,
      horizontalGapMm,
      verticalGapMm,
      registration,
      exportContentMode: contentMode,
      missingBackPolicy,
      duplexFlipMode,
      projectDefaultBack,
      printerProfileSelection,
      printerDuplexMode,
      ...(templateGeometry ? { templateGeometry } : {}),
      ...(projectSettings.layout.rows !== undefined ? { layoutRows: projectSettings.layout.rows, layoutColumns: projectSettings.layout.columns } : {}),
      skippedSlotIndices,
      ...(activeProjectSync?.saved ? { projectId: activeProjectSync.projectId, expectedProjectRevision: activeProjectSync.revision } : {}),
    } });
  }

  async function requestFinalExport(contentMode: ExportContentMode, signal: AbortSignal, proof: boolean): Promise<Response> {
    const query = proof ? "?proof=final" : "";
    return fetch(`/api/cards/export${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: exportRequestBody(contentMode),
    });
  }

  function pdfUrlFromBase64(value: string): string {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  }

  async function readExportFailure(response: Response): Promise<Error> {
    try {
      const body = await response.json() as ApiErrorBody;
      return new Error(body.message ?? `Export retornou HTTP ${response.status}.`);
    } catch { return new Error(`Export retornou HTTP ${response.status}.`); }
  }

  async function exportPdf() {
    if (!exportIsReady()) return;
    const controller = beginAbortableOperation("export");
    setBleedDiagnostics(null);
    setBusy(true); clearProblem(); setStatus(`Validando ${physicalCardCount} cartas físicas e compondo ${exportContentMode} ${paperFormat.name}…`);
    try {
      const response = await requestFinalExport(exportContentMode, controller.signal, false);
      if (!response.ok) throw await readExportFailure(response);
      if (controller.signal.aborted) throw new DOMException("Exportação cancelada.", "AbortError");
      setBleedDiagnostics(decodeBleedDiagnostics(response.headers.get("x-tcgprint-bleed-diagnostics")));
      const calibrationWarnings = decodeCalibrationBoundsWarnings(response.headers.get("x-tcgprint-calibration-warnings"));
      const disposition = response.headers.get("content-disposition") ?? "";
      const downloadName = disposition.match(/filename="([^"]+)"/i)?.[1] ?? (exportContentMode === "front-back-separated" ? "tcgprint-front-back.zip" : "tcgprint-cards.pdf");
      const blob = await response.blob();
      if (controller.signal.aborted) throw new DOMException("Exportação cancelada.", "AbortError");
      const nextUrl = URL.createObjectURL(blob);
      const boundsStatus = calibrationWarnings.length
        ? ` Aviso de margem: ${calibrationWarnings.length} conteúdo(s) a até 0.5 mm da borda; menor folga ${Math.min(...calibrationWarnings.map(({ nearestEdgeClearanceMm }) => nearestEdgeClearanceMm)).toFixed(3)} mm.`
        : "";
      setPdfUrl(nextUrl); setExportDownloadName(downloadName); setStatus(`${downloadName} pronto · ${physicalCardCount} slots físicos pareados · ${paperFormat.name} · ${pageOrientation}.${boundsStatus}`);
    } catch (error) {
      setBleedDiagnostics(null);
      if (controller.signal.aborted) { setProblem(""); setStatus("Exportação cancelada."); }
      else { setProblem(error instanceof Error ? error.message : "Export falhou."); setStatus(""); }
    } finally {
      finishAbortableOperation(controller);
      setBusy(false);
    }
  }

  async function proveFinalPdf() {
    if (!exportIsReady()) return;
    const contentMode = exportContentMode;
    const fingerprint = compositorFingerprint;
    const controller = beginAbortableOperation("pdf-proof");
    setBleedDiagnostics(null);
    setBusy(true); clearProblem(); setStatus(`Produzindo conferência lossless para ${contentMode}…`);
    let frontUrl: string | undefined;
    let backUrl: string | undefined;
    try {
      const response = await requestFinalExport(contentMode, controller.signal, true);
      if (!response.ok) throw await readExportFailure(response);
      if (controller.signal.aborted) throw new DOMException("Conferência cancelada.", "AbortError");
      setBleedDiagnostics(decodeBleedDiagnostics(response.headers.get("x-tcgprint-bleed-diagnostics")));
      if (contentMode === "front-back-separated") {
        const result = await response.json() as { readonly frontPdfBase64?: unknown; readonly backPdfBase64?: unknown };
        if (typeof result.frontPdfBase64 !== "string" || typeof result.backPdfBase64 !== "string") {
          throw new Error("O resultado separado não contém os dois PDFs finais.");
        }
        frontUrl = pdfUrlFromBase64(result.frontPdfBase64);
        backUrl = pdfUrlFromBase64(result.backPdfBase64);
      } else {
        const blob = await response.blob();
        if (blob.type !== "application/pdf") throw new Error("A conferência final não retornou um PDF.");
        frontUrl = URL.createObjectURL(blob);
      }
      if (controller.signal.aborted) throw new DOMException("Conferência cancelada.", "AbortError");
      setPdfProof({ frontUrl, ...(backUrl ? { backUrl } : {}), separated: contentMode === "front-back-separated", contentMode, fingerprint });
      setPdfProofSide("front");
      setStatus("PDF final lossless pronto para conferência. O compositor live permanece sincronizado.");
    } catch (error) {
      if (frontUrl) URL.revokeObjectURL(frontUrl);
      if (backUrl) URL.revokeObjectURL(backUrl);
      setBleedDiagnostics(null);
      if (controller.signal.aborted) { setProblem(""); setStatus("Conferência cancelada."); }
      else { setProblem(error instanceof Error ? error.message : "Não foi possível conferir o PDF final."); setStatus(""); }
    } finally {
      finishAbortableOperation(controller);
      setBusy(false);
    }
  }

  function restoreProject(project: ProjectDto) {
    const { settings, cards } = project.snapshot;
    setRegistrationOverride(settings.registrationOverride);
    setTemplateRegistrationStatus(project.templateSelection ? "checking" : "unselected");
    const nextRestoreVersion = projectRestoreVersion + 1;
    projectRestoreLookupGate.current = createProjectRestoreLookupGate(nextRestoreVersion);
    setProjectRestoreVersion(nextRestoreVersion);

    clearRequestCache(artworkCatalogRequests.current);
    clearRequestCache(identityDetailsRequests.current);
    dispatchEditor({ type: "load-project", cards, physicalOrder: project.snapshot.physicalOrder });
    setSelectedPhysicalInstanceId(null);
    setBleedMm(String(settings.bleedMm));
    setRoundedCorners(settings.roundedCorners);
    setTrimGuideEnabled(settings.cutGuides.trim.enabled);
    setTrimGuideExtentMm(settings.cutGuides.trim.extentMm === "full" ? "full" : String(settings.cutGuides.trim.extentMm));
    setTrimGuideColor(settings.cutGuides.trim.color);
    setExternalGuideEnabled(settings.cutGuides.external.enabled);
    setExternalGuideStrokeWidthPt(String(settings.cutGuides.external.strokeWidthPt));
    setExternalGuideColor(settings.cutGuides.external.color);
    setPageOrientation(settings.pageOrientation);
    setCardOrientation(settings.cardOrientation);
    setPaperFormat(settings.paperFormat);
    setCardFormat(settings.cardFormat);
    setExportContentMode(settings.exportContentMode);
    setMissingBackPolicy(settings.missingBackPolicy);
    setDuplexFlipMode(settings.duplexFlipMode);
    setProjectDefaultBack(settings.projectDefaultBack);
    setPrinterProfileSelection(settings.printerProfileSelection);
    setPrinterDuplexMode(settings.printerDuplexMode);
    setMarginsMm(settings.marginsMm);
    setHorizontalGapMm(settings.horizontalGapMm);
    setVerticalGapMm(settings.verticalGapMm);
    setRegistration(settings.registration);
    setLayoutRows(settings.layout.rows === undefined ? "" : String(settings.layout.rows));
    setLayoutColumns(settings.layout.columns === undefined ? "" : String(settings.layout.columns));
    setSkippedSlotIndices(settings.layout.skippedSlotIndices);
    setTemplateGeometry(settings.layout.templateGeometry);
    setCutSourceSelection(settings.cutSourceSelection);

    setArtworkCatalogState(null);
    setPickerContext(null);
    setPendingArtwork(null);
    setPendingBackChoice(null);
    setArtworkProblem(null);
    setArtworkFilter("all");
    setArtworkPageIndex(0);
    setArtworkSearch("");
    setManualQuery("");
    manualQueryRef.current = "";
    setAutocompleteEnabled(true);
    setAutocompleteResults(null);
    setManualIdentities([]);
    setIdentityDetails(null);
    setProviderHealth({});
    clearProblem();
    setPdfUrl("");
    setBleedDiagnostics(null);
    setBusy(false);
    setStatus(`${project.name} aberto · revisão ${project.revision}.`);
  }

  const selected = artworkTargetCard
    ? manualPhysicalBackPicker ? artworkTargetCard.manualBackArtwork : selectedFor(artworkTargetCard, effectivePickerSide)
    : undefined;
  const previewMatchesActiveProject = !activeProjectSync || Boolean(activeProjectSync.saved
    && cutGeometryPreview
    && cutGeometryPreview.projectId === activeProjectSync.projectId
    && cutGeometryPreview.projectRevision === activeProjectSync.revision
    && cutGeometryPreview.activeGeometry);
  const selectedCutSourceReady = !cutSourceSelection || Boolean(cutGeometryPreview
    && cutGeometryPreview.geometry.source.kind === "template-file"
    && cutGeometryPreview.geometry.source.fileId === cutSourceSelection.fileId
    && cutGeometryPreview.geometry.source.fileHash === cutSourceSelection.fileHash
    && cutGeometryPreview.activeGeometry);
  const projectCutSyncReady = previewMatchesActiveProject && selectedCutSourceReady;

  const providerStatus = () => <div className="provider-health compact-provider-health" aria-label="Estado dos providers">
    {(["scryfall", "upload", "mpc"] as const).map((source) => {
      const health = providerHealth[source];
      const state = !health ? "verificando" : !health.available ? "offline" : health.degraded ? "degradado" : "disponível";
      return <span key={source} className={health?.degraded || health && !health.available ? "health-degraded" : ""}>{labelSource(source)} · {state}</span>;
    })}
  </div>;

  const sharedProjectSections: readonly WorkspaceSection[] = ["project", "layout", "pdf", "cut", "templates"];
  const sharedProjectPanel = (activeSection: WorkspaceSection) => <div className="workspace-project-settings-content">
      <ProjectsPanel
        view={activeSection === "project" ? "project" : activeSection === "templates" ? "templates" : activeSection === "cut" ? "cut" : "hidden"}
        cards={workingCards}
        physicalOrder={physicalOrder}
        settings={projectSettings}
        onProjectOpen={restoreProject}
        onCutSourceSelectionChange={setCutSourceSelection}
        onCutGeometryPreviewChange={setCutGeometryPreview}
        selectedCutPageNumber={cutPageNumber}
        onCutPageNumberChange={setCutPageNumber}
        onProjectSyncStateChange={setActiveProjectSync}
        onTemplateRegistrationStatusChange={(registrationStatus) => setTemplateRegistrationStatus(
          applyProjectRegistrationOverride(registrationStatus, projectSettings.registrationOverride),
        )}
        onTemplateDefaults={(defaults: TemplateRegistrationDefaults | null) => {
          if (!defaults) {
            setTemplateRegistrationStatus("unselected");
            updateProjectSetting(() => {
              setRegistrationOverride(false);
              const layout = applyTemplateLayoutDefaults({ rows: layoutRows, columns: layoutColumns, skippedSlotIndices }, undefined);
              setTemplateGeometry(undefined);
              setSkippedSlotIndices(layout.skippedSlotIndices);
            });
            return;
          }
          if (defaults.physicalFormatUnconfigured) {
            updateProjectSetting(() => {
              setRegistrationOverride(false);
              if (defaults.registration) setRegistration(defaults.registration);
              setTemplateRegistrationStatus("legacy-physical-format-unconfigured");
              const layout = applyTemplateLayoutDefaults({ rows: layoutRows, columns: layoutColumns, skippedSlotIndices }, undefined);
              setTemplateGeometry(undefined);
              setLayoutRows(layout.rows);
              setLayoutColumns(layout.columns);
              setSkippedSlotIndices(layout.skippedSlotIndices);
            });
            return;
          }
          updateProjectSetting(() => {
            setRegistrationOverride(false);
            setPageOrientation(defaults.pageOrientation);
            setCardOrientation(defaults.cardOrientation);
            setPaperFormat(defaults.paperFormat);
            setCardFormat(defaults.cardFormat);
            if (defaults.registration) setRegistration(defaults.registration);
            setTemplateRegistrationStatus(defaults.registrationUnconfigured ? "legacy-custom-unconfigured" : "configured");
            const layout = applyTemplateLayoutDefaults({ rows: layoutRows, columns: layoutColumns, skippedSlotIndices }, defaults.templateGeometry);
            setTemplateGeometry(layout.templateGeometry);
            setLayoutRows(layout.rows);
            setLayoutColumns(layout.columns);
            setSkippedSlotIndices(layout.skippedSlotIndices);
          });
        }}
        onProjectInteractionLockChange={setProjectInteractionLocked}
        disabled={busy}
      />
    <div className="workspace-settings-view" hidden={activeSection !== "layout" && activeSection !== "pdf" && activeSection !== "cut"}>
          <ProjectSettingsControls
            paperFormat={paperFormat}
            cardFormat={cardFormat}
            section={activeSection === "layout" || activeSection === "pdf" || activeSection === "cut" ? activeSection : "layout"}
            bleedMm={bleedMm}
            roundedCorners={roundedCorners}
            trimGuideEnabled={trimGuideEnabled}
            trimGuideExtentMm={trimGuideExtentMm}
            trimGuideColor={trimGuideColor}
            externalGuideEnabled={externalGuideEnabled}
            externalGuideStrokeWidthPt={externalGuideStrokeWidthPt}
            externalGuideColor={externalGuideColor}
            pageOrientation={pageOrientation}
            cardOrientation={cardOrientation}
            marginsMm={marginsMm}
            horizontalGapMm={horizontalGapMm}
            verticalGapMm={verticalGapMm}
            registration={registration}
            layoutRows={layoutRows}
            layoutColumns={layoutColumns}
            templateGeometryActive={Boolean(templateGeometry)}
            skippedSlotIndices={skippedSlotIndices}
            exportContentMode={exportContentMode}
            missingBackPolicy={missingBackPolicy}
            duplexFlipMode={duplexFlipMode}
            disabled={interactionBusy}
            onBleedMmChange={(value) => updateProjectSetting(() => setBleedMm(value))}
            onRoundedCornersChange={(value) => updateProjectSetting(() => setRoundedCorners(value))}
            onTrimGuideEnabledChange={(value) => updateProjectSetting(() => setTrimGuideEnabled(value))}
            onTrimGuideExtentMmChange={(value) => updateProjectSetting(() => setTrimGuideExtentMm(value))}
            onTrimGuideColorChange={(value) => updateProjectSetting(() => setTrimGuideColor(value))}
            onExternalGuideEnabledChange={(value) => updateProjectSetting(() => setExternalGuideEnabled(value))}
            onExternalGuideStrokeWidthPtChange={(value) => updateProjectSetting(() => setExternalGuideStrokeWidthPt(value))}
            onExternalGuideColorChange={(value) => updateProjectSetting(() => setExternalGuideColor(value))}
            onPageOrientationChange={(value) => updateProjectSetting(() => setPageOrientation(value))}
            onCardOrientationChange={(value) => updateProjectSetting(() => setCardOrientation(value))}
            onMarginChange={(side, value) => updateProjectSetting(() => setMarginsMm((current) => ({ ...current, [side]: value })))}
            onHorizontalGapChange={(value) => updateProjectSetting(() => setHorizontalGapMm(value))}
            onVerticalGapChange={(value) => updateProjectSetting(() => setVerticalGapMm(value))}
            onRegistrationChange={(value) => updateProjectSetting(() => {
              setRegistrationOverride(true);
              setRegistration(value);
              setTemplateRegistrationStatus((current) => applyProjectRegistrationOverride(current, true));
            })}
            onLayoutRowsChange={(value) => updateProjectSetting(() => setLayoutRows(value))}
            onLayoutColumnsChange={(value) => updateProjectSetting(() => setLayoutColumns(value))}
            onExportContentModeChange={(value) => updateProjectSetting(() => setExportContentMode(value))}
            onMissingBackPolicyChange={(value) => updateProjectSetting(() => setMissingBackPolicy(value))}
            onDuplexFlipModeChange={(value) => updateProjectSetting(() => setDuplexFlipMode(value))}
          />
    </div>
    <div className="workspace-back-library-view" hidden={activeSection !== "pdf"}>
      <BackLibraryControls
            assets={backLibraryAssets}
            selectedDefault={projectDefaultBack}
            selectedCard={activeCard ?? null}
            disabled={interactionBusy}
            onAssetsChange={setBackLibraryAssets}
            onDefaultChange={(asset) => updateProjectSetting(() => setProjectDefaultBack(asset))}
            onCardModeChange={(mode) => { if (activeCard) updateCardBackMode(activeCard, mode); }}
            onManualBackChange={(asset) => { if (activeCard) dispatchEditor({ type: "replace-card", cardId: activeCard.id, card: selectManualBackLibraryAsset(activeCard, asset) }); }}
      />
    </div>
  </div>;

  const cardsSection = <div className="workspace-section-content workspace-cards-content">
    {inputContent}
    <section className="panel card-actions-panel" aria-label="Working Set actions">
      <div className="action-row phase5-actions">
        <button className="button primary" type="button" onClick={addCards} disabled={interactionBusy}>{abortableOperation === "add-cards" ? "Adicionando…" : "Adicionar cartas"}</button>
        {abortableOperation === "add-cards" && <button className="button secondary" type="button" aria-label="Cancelar adição" onClick={() => activeOperationAbortController.current?.abort()}>Cancelar adição</button>}
        <div className="editor-history-controls" role="group" aria-label="Histórico do editor">
          <button className="button secondary" type="button" aria-label="Desfazer" aria-keyshortcuts="Control+Z Meta+Z" disabled={interactionBusy || editorHistory.past.length === 0} onClick={() => dispatchEditor({ type: "undo" })}>Desfazer</button>
          <button className="button secondary" type="button" aria-label="Refazer" aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z" disabled={interactionBusy || editorHistory.future.length === 0} onClick={() => dispatchEditor({ type: "redo" })}>Refazer</button>
        </div>
        <span className="status" aria-live="polite">{status}</span>
      </div>
      {(visibleProblem || editorState.error) && <p className="error-message" role="alert">{visibleProblem || editorState.error}</p>}
    </section>
      {workingCards.length > 0 && <div className="card-workbench-layout">
        <WorkingCardList
          cards={workingCards}
          selectedCardId={selectedCardId}
          physicalCardCount={physicalCardCount}
          disabled={interactionBusy}
          onSelect={(cardId) => {
            if (problemCardId !== null && problemCardId !== cardId) clearProblem();
            setArtworkProblem(null);
            dispatchEditor({ type: "select-card", cardId });
          }}
          onQuantityCommit={(cardId, value) => dispatchEditor({ type: "set-quantity", cardId, quantity: Number(value) })}
          onQuantityAdjust={(cardId, delta) => dispatchEditor({ type: "adjust-quantity", cardId, delta })}
          onMove={(cardId, targetIndex) => dispatchEditor({ type: "move-card", cardId, targetIndex })}
          onDuplicate={(cardId) => dispatchEditor({ type: "duplicate-card", cardId, newCardId: globalThis.crypto.randomUUID() })}
          onDelete={(cardId) => dispatchEditor({ type: "delete-card", cardId })}
        />

        {activeCard && <div className="working-card-detail">
          <div className="compact-heading detail-title">
            <div><strong>{displayCard(activeCard)}</strong><span>{activeCard.quantity} cópia(s) físicas · entrada {activeCard.order + 1}</span></div>
            {isDoubleFacedIdentity(activeCard.identity) && <span className="multiface-label" aria-label="Carta dupla-face">Carta dupla-face · Front ↔ Back</span>}
          </div>

          <WorkingCardDetailsSummary card={activeCard} identityLayout={identityDetails?.layout} artworkCandidates={artworkCandidates} />
          <div className="card-identity-actions">
            <button className="button secondary" type="button" disabled={interactionBusy} onClick={() => void reresolveCard(activeCard)}>Re-resolver esta carta</button>
          </div>

          {(activeCard.identityResolution.candidates.length > 0 || activeCard.identityResolution.status === "suggested" || activeCard.identityResolution.status === "ambiguous") && <div className="identity-suggestions">
            <strong>Confirme uma sugestão</strong>
            {activeCard.identityResolution.candidates.map(({ identity: candidateIdentity, score, reason }) => (
              <div className="identity-option" key={candidateIdentity.id}>
                <span>{candidateIdentity.name} · {(score * 100).toFixed(0)}% · {reason}</span>
                <button className="button secondary" type="button" disabled={interactionBusy} onClick={() => void confirmIdentity(activeCard, candidateIdentity)}>Usar esta identidade</button>
              </div>
            ))}
          </div>}

          <div className="manual-identity-search">
            <label className="field-label" htmlFor="manual-card-search">Escolher outra identidade</label>
            <div className="manual-search-row">
              <input id="manual-card-search" value={manualQuery} disabled={interactionBusy} onChange={(event) => { setAutocompleteEnabled(true); setManualQuery(event.currentTarget.value); }} onKeyDown={(event) => { if (event.key === "Enter") void searchIdentities(); }} placeholder="Nome da carta" />
              <button className="button secondary" type="button" disabled={interactionBusy || manualQuery.trim().length < 2} onClick={() => void searchIdentities()}>Buscar</button>
            </div>
            {autocompleteEnabled && autocompleteNames.length > 0 && <div className="autocomplete-list" role="listbox" aria-label="Autocompletar carta">
              {autocompleteNames.map((name) => <button type="button" role="option" key={name} disabled={interactionBusy} onClick={() => { setManualQuery(name); void searchIdentities(name); }}>{name}</button>)}
            </div>}
            {manualIdentities.map((identity) => <div className="identity-option manual-result" key={identity.id}>
              <span>{identity.name}{identity.setCode ? ` · ${identity.setCode.toUpperCase()} #${identity.collectorNumber ?? "?"}` : ""}</span>
              <button className="button secondary" type="button" disabled={interactionBusy} onClick={() => void confirmIdentity(activeCard, identity)}>Usar esta identidade</button>
            </div>)}
            <button className="button secondary custom-button" type="button" disabled={interactionBusy} onClick={() => void keepCustom(activeCard)}>Manter como custom</button>
          </div>

          {(identityDetails?.relatedCards.length || relatedCardNames(activeCard).length) > 0 && <div className="related-card-list"><strong>Related cards / tokens:</strong> {(identityDetails?.relatedCards ?? relatedCardNames(activeCard)).map((item) => `${item.name}${item.component === "token" ? " (token; não adicionado)" : ""}`).join(" · ")}</div>}
        </div>}
      </div>}
  </div>;

  const artworkSection = <div className="workspace-section-content workspace-artwork-content">
    {activeCard ? <>
      <p className="muted">A arte é aplicada ao estado canônico usado pelo compositor, pelo Project e pelo PDF.</p>
      <div className="selected-artwork-summary">
        <strong>{displayCard(activeCard)}</strong>
        <span>{activeCard.quantity} cópia(s) · {isDoubleFacedIdentity(activeCard.identity) ? "Carta dupla-face" : "Carta simples"}</span>
        {selected && <span>Arte atual: {labelSource(selected.source)} · {selected.candidateId}</span>}
        {activeCard.manualBackArtwork?.source === "scryfall" && <span>Verso Scryfall legado preservado.</span>}
        <button className="button primary" type="button" disabled={interactionBusy} onClick={(event) => openArtworkPicker(activeCard.id, face, event.currentTarget)}>Selecionar arte</button>
      </div>
      <p className="muted">Para editar uma cópia específica, selecione-a no compositor e use “Selecionar arte”.</p>
    </> : <section className="panel"><h3>Nenhuma carta selecionada</h3><p>Adicione e selecione uma carta para escolher artwork.</p></section>}
  </div>;

  const pickerCard = artworkTargetCard;
  const pickerIsDfc = Boolean(pickerCard && isDoubleFacedIdentity(pickerCard.identity));
  const pickerFaceName = pickerCard?.faces.find((item) => item.side === effectivePickerSide)?.name ?? (effectivePickerSide === "front" ? pickerCard?.identity?.name ?? pickerCard?.identityHints.name ?? "Front" : "Back");
  const pickerTitle = pickerCard
    ? `${displayCard(pickerCard)}${pickerContext?.physicalCardIndex !== undefined ? ` · cópia ${pickerContext.physicalCopyNumber}/${pickerContext.physicalTotalCopies}` : ` · ${pickerCard.quantity} cópia(s)`}`
    : "Artwork Picker";
  const sameIdentityCards = pickerCard?.identity
    ? workingCards.filter((card) => card.identity?.id === pickerCard.identity?.id && card.identity?.provider === pickerCard.identity?.provider)
    : [];
  const sameIdentitySimpleCards = sameIdentityCards.filter((card) => !isDoubleFacedIdentity(card.identity));
  const allSimpleCards = workingCards.filter((card) => !isDoubleFacedIdentity(card.identity));
  const preservedDfcCards = workingCards.filter((card) => isDoubleFacedIdentity(card.identity));
  const plannedBackPhysicalCount = pickerScope === "physical-copy" ? 1
    : pickerScope === "same-identity" ? sameIdentitySimpleCards.reduce((sum, card) => sum + card.quantity, 0)
      : pickerScope === "all-simple-project" ? allSimpleCards.reduce((sum, card) => sum + card.quantity, 0)
        : pickerCard?.quantity ?? 0;
  const plannedBackDfcCount = pickerScope === "all-simple-project" ? preservedDfcCards.reduce((sum, card) => sum + card.quantity, 0) : 0;
  const selectedBackAssetId = pickerCard?.manualBackAsset?.assetId;
  const currentSimpleBack = manualPhysicalBackPicker && pickerCard
    ? pickerCard.backMode === "none"
      ? { mode: "none" as const, label: "Sem verso" }
      : pickerCard.backMode === "project-default"
        ? { mode: "project-default" as const, label: "Project Default Back" }
        : pickerCard.backMode === "manual" && pickerCard.manualBackAsset
          ? {
            mode: "library" as const,
            assetId: pickerCard.manualBackAsset.assetId,
            label: `Back Library · ${backLibraryAssets.find((asset) => asset.assetId === pickerCard.manualBackAsset?.assetId)?.name ?? pickerCard.manualBackAsset.assetId}`,
          }
          : pickerCard.backMode === "manual" && pickerCard.manualBackArtwork
            ? { mode: "artwork" as const, candidateId: pickerCard.manualBackArtwork.candidateId, label: `${labelSource(pickerCard.manualBackArtwork.source)} · ${pickerCard.manualBackArtwork.candidateId}` }
            : { mode: "auto" as const, label: "Verso automático" }
    : null;
  const pendingBackChoiceLabel = pendingBackChoice?.mode === "none" ? "Sem verso"
    : pendingBackChoice?.mode === "project-default" ? "Project Default Back"
      : pendingBackChoice?.mode === "library" ? `Back Library · ${backLibraryAssets.find((asset) => asset.assetId === pendingBackChoice.asset.assetId)?.name ?? pendingBackChoice.asset.assetId}`
        : "";
  const pickerBackLibraryAssets = backLibraryAssets.filter((asset) =>
    (asset.selectable !== false && !asset.retired) || asset.assetId === selectedBackAssetId,
  );

  const mpcAdvancedFilters = <details className="mpc-advanced-filters">
    <summary>Filtros avançados MPC</summary>
    {mpcCatalogProblem && <p className="muted" role="status">Catálogos de filtros indisponíveis; a busca básica MPC continua disponível. {mpcCatalogProblem} <button className="button secondary" type="button" disabled={interactionBusy} onClick={() => { setMpcCatalogs(null); setMpcCatalogRetry((revision) => revision + 1); }}>Tentar novamente</button></p>}
    {!mpcCatalogs && !mpcCatalogProblem && <p className="muted">Carregando catálogos MPC…</p>}
    {(!mpcDiagnostic?.capabilities.filters.dpi) && <p className="muted" role="status">Os filtros MPC aparecem quando o suporte do provider for confirmado. Atualize os resultados para consultar o protocolo atual.</p>}
    <div className="mpc-filter-controls">
      {mpcDiagnostic?.capabilities.filters.dpi && <>
        <label>DPI mínimo<input type="number" min={0} max={10000} step={1} value={mpcFilters.minimumDpi ?? ""} onChange={(event) => setMpcFilters((current) => ({ ...current, minimumDpi: event.target.value === "" ? undefined : Number(event.target.value) }))} /></label>
        <label>DPI máximo<input type="number" min={0} max={10000} step={1} value={mpcFilters.maximumDpi ?? ""} placeholder="1500" onChange={(event) => setMpcFilters((current) => ({ ...current, maximumDpi: event.target.value === "" ? undefined : Number(event.target.value) }))} /></label>
      </>}
      {mpcDiagnostic?.capabilities.filters.sources && <label>Sources permitidas (vazio = todas)<select multiple size={4} value={(mpcFilters.sources ?? []).map(String)} disabled={!mpcCatalogs} onChange={(event) => setMpcFilters((current) => ({ ...current, sources: Array.from(event.currentTarget.selectedOptions, (option) => Number(option.value)) }))}>{mpcCatalogs?.sources.map((source) => <option key={source.id} value={source.id}>{source.name} · {source.id}</option>)}</select></label>}
      {mpcDiagnostic?.capabilities.filters.languages && <>
        <label>Languages<select multiple size={4} value={[...(mpcFilters.languages ?? [])]} disabled={!mpcCatalogs} onChange={(event) => setMpcFilters((current) => ({ ...current, languages: Array.from(event.currentTarget.selectedOptions, (option) => option.value) }))}>{mpcCatalogs?.languages.map((language) => <option key={language.code} value={language.code}>{language.name} · {language.code}</option>)}</select></label>
        <label>Languages preferidos (códigos em ordem)<input type="text" value={(mpcFilters.preferredLanguages ?? []).join(", ")} onChange={(event) => setMpcFilters((current) => ({ ...current, preferredLanguages: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) }))} /></label>
      </>}
      {mpcDiagnostic?.capabilities.filters.tags && <>
        <label>Incluir tags<select multiple size={4} value={[...(mpcFilters.includeTags ?? [])]} disabled={!mpcCatalogs} onChange={(event) => setMpcFilters((current) => ({ ...current, includeTags: Array.from(event.currentTarget.selectedOptions, (option) => option.value) }))}>{mpcCatalogs?.tags.map((tag) => <option key={tag.name} value={tag.name}>{tag.name}</option>)}</select></label>
        <label>Excluir tags<select multiple size={4} value={[...(mpcFilters.excludeTags ?? [])]} disabled={!mpcCatalogs} onChange={(event) => setMpcFilters((current) => ({ ...current, excludeTags: Array.from(event.currentTarget.selectedOptions, (option) => option.value) }))}>{mpcCatalogs?.tags.map((tag) => <option key={tag.name} value={tag.name}>{tag.name}</option>)}</select></label>
        <label>Tags preferidas<input type="text" value={(mpcFilters.preferredTags ?? []).join(", ")} onChange={(event) => setMpcFilters((current) => ({ ...current, preferredTags: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) }))} /></label>
      </>}
      {mpcDiagnostic?.capabilities.filters.sources && <label>Sources preferidas (IDs em ordem)<input type="text" inputMode="numeric" value={(mpcFilters.preferredSources ?? []).join(", ")} onChange={(event) => setMpcFilters((current) => ({ ...current, preferredSources: event.target.value.split(",").map((value) => value.trim()).filter(Boolean).map(Number) }))} /></label>}
      {mpcDiagnostic?.capabilities.search && <label>Ordenação do provider<select value={mpcFilters.rankingMode ?? "balanced"} onChange={(event) => setMpcFilters((current) => ({ ...current, rankingMode: event.target.value === "provider" ? "provider" : "balanced" }))}><option value="balanced">Equilibrada</option><option value="provider">Ordem original MPC</option></select></label>}
    </div>
    <p className="muted">Filtros MPC atuam no catálogo do provider; a escolha atual permanece intacta.</p>
    {mpcDiagnostic && <p className="muted">Protocolo confirmado: {mpcDiagnostic.lastProtocolConfirmed ?? "ainda não"}{mpcDiagnostic.fallbackV2Used ? " · fallback v2 usado" : ""} · cache MPC {mpcDiagnostic.degraded ? "degradado" : "operacional"}</p>}
  </details>;

  const artworkPickerContent = pickerCard && pickerIsOpen ? <div className="artwork-picker-content">
    {providerStatus()}
    <div className="artwork-picker-context">
      <strong>{pickerIsDfc ? "Carta dupla-face" : "Carta simples"}</strong>
      <span>CardIdentity: {pickerCard.identity?.id ?? "não resolvida"}</span>
      <span>{effectivePickerSide === "front" ? "Front" : "Back"} · {pickerFaceName}</span>
      {pickerContext?.physicalCardIndex !== undefined
        ? <span>Carta física {pickerContext.physicalCardIndex + 1} · cópia original {pickerContext.physicalCopyNumber}/{pickerContext.physicalTotalCopies}</span>
        : <span>Entrada {pickerCard.order + 1} · {pickerCard.quantity} cópia(s)</span>}
      {pickerCard.manualBackArtwork?.source === "scryfall" && manualPhysicalBackPicker && <span role="status">Verso Scryfall legado preservado; essa fonte não pode ser escolhida novamente para cartas simples.</span>}
    </div>

    <div className="artwork-picker-face-tabs" role="tablist" aria-label="Face da carta">
      {(["front", "back"] as const).map((side) => <button key={side} type="button" role="tab" aria-selected={effectivePickerSide === side} className={`button ${effectivePickerSide === side ? "primary" : "secondary"}`} disabled={interactionBusy || (pickerIsDfc && !pickerCard.faces.some((item) => item.side === side))} onClick={() => changeArtworkPickerSide(side)}>
        {side === "front" ? "Front" : "Back"}{pickerIsDfc && pickerCard.faces.find((item) => item.side === side)?.name ? ` · ${pickerCard.faces.find((item) => item.side === side)?.name}` : ""}
      </button>)}
    </div>

    {pickerIsDfc && <p className="multiface-label">Carta dupla-face · {pickerCard.faces.map((item) => `${item.side === "front" ? "Front" : "Back"} · ${item.name ?? "face sem nome"}`).join(" · ")}</p>}

    {!manualPhysicalBackPicker && <div className="artwork-filter-row picker-provider-tabs" role="group" aria-label="Filtrar provider">
      {([ ["all", "Todas"], ["scryfall", "Scryfall"], ["mpc", "MPC Autofill"], ["upload", "Meus uploads"] ] as const).map(([value, label]) => <button key={value} type="button" disabled={interactionBusy} aria-pressed={artworkFilter === value} className={`button ${artworkFilter === value ? "primary" : "secondary"}`} onClick={() => { setArtworkFilter(value); setArtworkPageIndex(0); setPendingArtwork(null); }}>{label}</button>)}
    </div>}

    {manualPhysicalBackPicker && <section className="simple-back-options" aria-label="Opções de verso para carta simples">
      <h3>Verso da carta simples</h3>
      {currentSimpleBack && <p className="simple-back-current" role="status" aria-label="Estado atual do verso">Estado atual do verso: {currentSimpleBack.label}</p>}
      <div className="simple-back-semantic-options">
        <button type="button" aria-current={currentSimpleBack?.mode === "none" ? "true" : undefined} aria-pressed={pendingBackChoice?.mode === "none"} className={`button ${pendingBackChoice?.mode === "none" || currentSimpleBack?.mode === "none" ? "primary" : "secondary"}`} disabled={interactionBusy} onClick={() => chooseSemanticBack({ mode: "none" })}>Sem verso{currentSimpleBack?.mode === "none" ? " · Atual" : ""}</button>
        {projectDefaultBack && <button type="button" aria-current={currentSimpleBack?.mode === "project-default" ? "true" : undefined} aria-pressed={pendingBackChoice?.mode === "project-default"} className={`button ${pendingBackChoice?.mode === "project-default" || currentSimpleBack?.mode === "project-default" ? "primary" : "secondary"}`} disabled={interactionBusy} onClick={() => chooseSemanticBack({ mode: "project-default" })}>Project Default Back · {backLibraryAssets.find((asset) => asset.assetId === projectDefaultBack.assetId)?.name ?? "configurado"}{currentSimpleBack?.mode === "project-default" ? " · Atual" : ""}</button>}
      </div>
      <div className="picker-back-library">
        <h4>Back Library</h4>
        {pickerBackLibraryAssets.length === 0 && <p className="muted">A Back Library ainda não tem imagens disponíveis. Adicione uma pela seção Exportar → Back Library.</p>}
        <div className="picker-back-library-grid">
          {pickerBackLibraryAssets.map((asset) => {
            const currentAsset = currentSimpleBack?.mode === "library" && currentSimpleBack.assetId === asset.assetId;
            const pendingAsset = pendingBackChoice?.mode === "library" && pendingBackChoice.asset.assetId === asset.assetId;
            return <button key={asset.assetId} type="button" aria-current={currentAsset ? "true" : undefined} aria-pressed={pendingAsset} className={`picker-back-asset ${pendingAsset || currentAsset ? "is-selected" : ""} ${currentAsset ? "is-current" : ""}`} disabled={interactionBusy || asset.retired} onClick={() => chooseSemanticBack({ mode: "library", asset: { assetId: asset.assetId, sha256: asset.sha256, format: asset.format } })}>
            <Image src={`/api/back-library/${encodeURIComponent(asset.assetId)}/preview`} alt={`Preview do verso ${asset.name}`} width={200} height={280} unoptimized loading="lazy" />
            <strong>{asset.name}{asset.retired ? " · arquivado" : ""}{currentAsset ? " · Atual" : ""}</strong>
            <span>{asset.widthPx} × {asset.heightPx}px · {asset.format.toUpperCase()} · SHA-256 {asset.sha256.slice(0, 12)}</span>
          </button>;
          })}
        </div>
      </div>
      <p className="muted">Cardbacks MPC precisam ser do tipo CARDBACK. Imagens próprias são selecionadas pela Back Library existente.</p>
    </section>}

    {(manualPhysicalBackPicker || artworkFilter === "mpc") && <div className="picker-mpc-controls">
      <div className="picker-mpc-heading"><strong>{manualPhysicalBackPicker ? "MPC Autofill · cardbacks validados" : "MPC Autofill"}</strong><button className="button secondary" type="button" disabled={interactionBusy} onClick={() => {
        const revision = artworkCatalogRevision + 1;
        setForcedMpcRefreshRevision(revision);
        setArtworkCatalogRevision(revision);
      }}>Atualizar resultados MPC</button></div>
      {mpcDiagnostic && (mpcDiagnostic.degraded || !mpcDiagnostic.available) && <p className="muted" role="status">MPC está {mpcDiagnostic.available ? "degradado ou em modo de cache" : "offline"}. Outros providers e a seleção anterior continuam disponíveis.</p>}
      {mpcAdvancedFilters}
    </div>}

    <div className="artwork-picker-search-row">
      <label>Buscar neste catálogo<input data-picker-initial-focus type="search" value={artworkSearch} onChange={(event) => { setArtworkSearch(event.target.value); setArtworkPageIndex(0); }} placeholder="Nome, set, idioma, tags…" /></label>
      <label>Ordenar<select value={artworkSort} onChange={(event) => { setArtworkSort(event.target.value as ArtworkSort); setArtworkPageIndex(0); }}>
        <option value="recommended">Recomendado</option><option value="dpi">Maior DPI</option><option value="recent">Mais recente</option><option value="provider">Ordem original do provider</option>
      </select></label>
    </div>

    {selected && <p className="selected-artwork-line">Estado atual: {labelSource(selected.source)} · {selected.candidateId} · {artworkPolicyLabel(selected)}</p>}
    {!manualPhysicalBackPicker && !pickerCard.identity && <p className="muted">Sem CardIdentity resolvida: “todas iguais” fica indisponível até a identidade ser confirmada.</p>}
    {!manualPhysicalBackPicker && <button className="button secondary restore-artwork-default" type="button" disabled={interactionBusy || !pickerCard.identity || !activeFaceExists} title={!pickerCard.identity ? "Não há identidade resolvida para determinar uma artwork padrão." : undefined} onClick={() => void restoreArtworkDefault(pickerCard, effectivePickerSide)}>Restaurar artwork padrão desta face</button>}
    {visibleArtworkProblem && <p className="error-message" role="alert">{visibleArtworkProblem}</p>}
    {artworkCatalogState?.requestKey !== currentArtworkRequestKey && !visibleArtworkProblem && <p className="muted" role="status">Carregando o catálogo completo…</p>}
    {artworkCatalogState?.requestKey === currentArtworkRequestKey && filteredArtworkCandidates.length === 0 && !visibleArtworkProblem && <p className="muted" role="status">Nenhum resultado corresponde a esta busca. Se um provider falhou, os demais resultados continuam disponíveis.</p>}

    <ArtworkCandidateGrid
      candidates={filteredArtworkCandidates}
      windowLimit={ARTWORK_WINDOW_SIZE}
      pageIndex={artworkPageIndex}
      pageSize={ARTWORK_WINDOW_SIZE}
      onPageChange={setArtworkPageIndex}
      catalogTotal={artworkCatalogTotal}
      catalogTotalComplete={currentArtworkCatalog.catalogTotalComplete}
      filterTotal={filteredArtworkCandidates.length}
      catalogLabel={manualPhysicalBackPicker ? "MPC cardbacks" : artworkRequest?.source && artworkRequest.source !== "all" ? labelSource(artworkRequest.source) : "Catálogo de arte"}
      cardName={displayCard(pickerCard)}
      selectedCandidateId={pendingArtwork?.id ?? selected?.candidateId}
      disabled={interactionBusy}
      qualityCheckingIds={qualityCheckingIds}
      onSelect={chooseArtwork}
      onRevalidate={(candidate) => void refreshMpcMetadata(candidate)}
      onLoadMore={() => undefined}
    />

    {(pendingArtwork || pendingBackChoice) && <section className="artwork-apply-scope" aria-label="Confirmar escopo da seleção">
      <p className="artwork-pending-selection" role="status">Nova escolha: {pendingArtwork
        ? `${pendingArtwork.faceName ?? displayCard(pickerCard)} · ${labelSource(pendingArtwork.source)}`
        : pendingBackChoiceLabel}</p>
      <h3>Aplicar para</h3>
      <div className="artwork-scope-options">
        <label><input type="radio" name="artwork-scope" checked={pickerScope === (pickerContext?.physicalCardIndex === undefined ? "entry" : "physical-copy")} onChange={() => setPickerScope(pickerContext?.physicalCardIndex === undefined ? "entry" : "physical-copy")} />{pickerContext?.physicalCardIndex === undefined ? "Somente esta entrada/cópias" : "Somente esta cópia física"}</label>
        <label><input type="radio" name="artwork-scope" checked={pickerScope === "same-identity"} disabled={!pickerCard.identity} onChange={() => setPickerScope("same-identity")} />Todas iguais · mesma CardIdentity + {manualPhysicalBackPicker ? "verso simples" : effectivePickerSide}</label>
        {manualPhysicalBackPicker && <label><input type="radio" name="artwork-scope" checked={pickerScope === "all-simple-project"} onChange={() => setPickerScope("all-simple-project")} />Todas as cartas simples do Project</label>}
      </div>
      {manualPhysicalBackPicker && <p className="artwork-bulk-impact" role="status">Aplicar verso a {plannedBackPhysicalCount} carta(s) simples · {plannedBackDfcCount} carta(s) dupla-face serão preservadas.</p>}
      {!manualPhysicalBackPicker && pickerScope === "same-identity" && <p className="muted" role="status">A seleção afeta {sameIdentityCards.filter((card) => card.faces.some((item) => item.side === effectivePickerSide)).reduce((sum, card) => sum + card.quantity, 0)} cópia(s) com a mesma CardIdentity e face.</p>}
      <div className="artwork-scope-actions"><button className="button primary" type="button" disabled={interactionBusy || (pickerScope === "same-identity" && !pickerCard.identity)} onClick={() => void confirmArtworkSelection()}>Aplicar seleção</button><button className="button secondary" type="button" disabled={interactionBusy} onClick={() => { setPendingArtwork(null); setPendingBackChoice(null); }}>Cancelar seleção</button></div>
    </section>}
    {abortableOperation === "artwork" && <button className="button secondary" type="button" aria-label="Cancelar download e seleção da arte" onClick={() => activeOperationAbortController.current?.abort()}>Cancelar download/seleção</button>}
  </div> : null;

  const exportActionDisabled = interactionBusy
    || templateRegistrationRequiresUserChoice(templateRegistrationStatus)
    || !projectCutSyncReady
    || (exportModeRequiresFrontArtwork(exportContentMode) && !workingCards.every((card) => Boolean(card.selectedArtworkByFace.front)))
    || (exportContentMode !== "front-only" && backValidation.blockers.length > 0);

  const exportSection = <div className="workspace-section-content workspace-export-content">
    <p className="status" aria-live="polite">{status}</p>
    {problem && <p className="error-message" role="alert">{problem}</p>}
      {workingCards.length > 0 ? <div className="phase5-export">
        <div className="panel-heading"><div><h3>Export PDF</h3><p>PDF {paperFormat.name} · {cardFormat.name} {cardFormat.widthMm} × {cardFormat.heightMm} mm · quantities expandidas somente na composição.</p></div></div>
        <section className="export-sync-status" aria-label="Estado de sincronização do export">
          <h4>Pré-validação</h4>
          <p>Project: {activeProjectSync ? `${activeProjectSync.projectId} · revisão ${activeProjectSync.revision} · ${activeProjectSync.saved ? "salvo" : "autosave pendente"}` : "sem Project aberto · Working Set local"}</p>
          <p>Template: {templateRegistrationStatus} · corte: {cutGeometryPreview ? `preview da revisão ${cutGeometryPreview.projectRevision}` : "sem preview de Project"} · sincronizado {projectCutSyncReady ? "sim" : "não"}.</p>
        </section>
        <div className="pdf-controls">


          {exportContentMode !== "front-only" && <section className="back-preflight" aria-label="Validação de versos antes do export">
            <h4>Validação de versos</h4>
            <p>{physicalCardCount} cartas físicas · {backValidation.dfcPhysicalCards} DFC · {backValidation.simplePhysicalCards} simples</p>
            <p>Versos: {backValidation.backs.auto} auto · {backValidation.backs.projectDefault} Project default · {backValidation.backs.manual} manual · {backValidation.backs.noneOrMissing} none/missing</p>
            {backValidation.missing.length > 0 && <div>
              <p className={backValidation.blockers.length ? "error-message" : backValidation.warnings.length ? "warning-message" : "muted"} role={backValidation.blockers.length ? "alert" : "status"}>
                {backValidation.blockers.length ? `${backValidation.blockers.length} slot(s) sem verso bloqueiam o export.` : backValidation.warnings.length ? `${backValidation.warnings.length} slot(s) sem verso; política permite continuar.` : `${backValidation.missing.length} slot(s) ficarão sem arte traseira.`}
              </p>
              <ul>{backValidation.missing.map((item, index) => <li key={`${item.cardId}-${item.copy}-${index}`}>
                <button type="button" className="link-button" onClick={() => dispatchEditor({ type: "select-card", cardId: item.cardId })}>{item.name} · cópia {item.copy}: {item.reason}</button>
              </li>)}</ul>
            </div>}
          </section>}
          {templateRegistrationStatus === "legacy-custom-unconfigured" && <p className="error-message" role="alert">O template selecionado declara registration custom, mas a versão não contém geometria física. O PDF usará somente a configuração independente do Project após escolha explícita.</p>}
          {templateRegistrationStatus === "legacy-physical-format-unconfigured" && <p className="error-message" role="alert">A versão legada do template declara papel ou carta custom sem dimensões físicas. Os formatos atuais do Working Set não foram substituídos; exportação bloqueada até selecionar uma versão com geometria explícita.</p>}
          {templateRegistrationStatus === "unavailable" && <p className="error-message" role="alert">A versão exata do template não está disponível para validar registration. Revise ou desassocie o template.</p>}
          <button className="button primary" type="button" disabled={exportActionDisabled} onClick={() => void exportPdf()}>Gerar PDF final</button>
          <button ref={pdfProofTriggerRef} className="button secondary final-pdf-proof-action" type="button" disabled={exportActionDisabled} onClick={() => void proveFinalPdf()}>Conferir PDF final</button>
          {abortableOperation === "export" && <button className="button secondary" type="button" aria-label="Cancelar exportação do PDF" onClick={() => activeOperationAbortController.current?.abort()}>Cancelar exportação</button>}
          {abortableOperation === "pdf-proof" && <button className="button secondary" type="button" aria-label="Cancelar conferência do PDF final" onClick={() => activeOperationAbortController.current?.abort()}>Cancelar conferência</button>}
          {pdfUrl && <a className="download-link" href={pdfUrl} download={exportDownloadName}>Baixar {exportDownloadName}</a>}
        </div>
        <p className="muted">Bleed estende somente os pixels da borda imediata de cada lado. Moldura preta continua preta; full-art continua a própria arte. O trim da carta permanece intacto. Cantos arredondados são uma opção separada.</p>

      </div>: <p className="muted">Adicione cartas em Cartas para validar e gerar o PDF.</p>}
  </div>;

  const diagnosticsSection = <div className="workspace-section-content workspace-diagnostics-content">
    <section className="panel">
      <h2>Diagnóstico</h2>
      <h3>Providers</h3>
      {providerStatus()}
      {mpcDiagnostic && <details className="diagnostic-group">
        <summary>Diagnóstico MPC</summary>
        <p>{mpcDiagnostic.available ? "Disponível" : "Offline"}{mpcDiagnostic.degraded ? " · degradado ou em cache" : ""} · protocolo {mpcDiagnostic.lastProtocolConfirmed ?? "ainda não confirmado"}{mpcDiagnostic.fallbackV2Used ? " · fallback v2 usado" : ""}</p>
        <p>Filtros: DPI {mpcDiagnostic.capabilities.filters.dpi ? "sim" : "não"} · fontes {mpcDiagnostic.capabilities.filters.sources ? "sim" : "não"} · languages {mpcDiagnostic.capabilities.filters.languages ? "sim" : "não"} · tags {mpcDiagnostic.capabilities.filters.tags ? "sim" : "não"}</p>
      </details>}
      {lastImportReport && <details className="diagnostic-group">
        <summary>ImportReport da adição de cartas</summary>
        <dl className="summary-grid">
          {Object.entries(lastImportReport.summary).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
        </dl>
        <h4>Fontes e importers</h4>
        <ul>{lastImportReport.sources.map((source) => {
          const selected = lastImportReport.selectedImporters.find((item) => item.sourceId === source.id);
          return <li key={source.id}>{source.filename ?? source.id} · {source.kind}{selected ? ` · ${selected.kind}` : ""}</li>;
        })}</ul>
        {lastImportReport.warnings.length > 0 && <><h4>Warnings</h4><ul>{lastImportReport.warnings.map((item, index) => <li key={`${item.code}:${index}`}><strong>{item.code}</strong> · {item.message}</li>)}</ul></>}
        {lastImportReport.errors.length > 0 && <><h4>Errors</h4><ul className="issue-list errors">{lastImportReport.errors.map((item, index) => <li key={`${item.code}:${index}`}><strong>{item.code}</strong> · {item.message}</li>)}</ul></>}
        {lastImportReport.pairings.length > 0 && <><h4>Sugestões de pareamento Front/Back</h4><ul>{lastImportReport.pairings.map((pairing, index) => <li key={`${pairing.frontAssetId}:${pairing.backAssetId}:${index}`}>{pairing.reason} · {(pairing.confidence * 100).toFixed(0)}% · requer confirmação</li>)}</ul></>}
      </details>}
    </section>
    {diagnosticsContent}
    <section className="panel">
      <h3>Layout, slots e sincronização</h3>
      <p>Grade: {layoutRows} × {layoutColumns} · slots ignorados: {skippedSlotIndices.length ? skippedSlotIndices.join(", ") : "nenhum"}.</p>
      <p>Template: {templateRegistrationStatus} · preview de corte {cutGeometryPreview ? `revision ${cutGeometryPreview.projectRevision}` : "indisponível"} · export sincronizado {projectCutSyncReady ? "sim" : "não"}.</p>
      {cutGeometryPreview && <details><summary>Estado técnico do preview de corte</summary><pre className="diagnostic-code">{JSON.stringify(cutGeometryPreview, null, 2)}</pre></details>}
    </section>
        {bleedDiagnostics && <details className="bleed-diagnostics">
          <summary>Diagnóstico aplicado pelo BleedEngine ({bleedDiagnostics.mode === "summary" ? "resumo" : `${bleedDiagnostics.diagnostics?.length ?? 0} carta(s)`})</summary>
          {bleedDiagnostics.diagnostics?.map((diagnostic) => <article key={diagnostic.workingCardId}>
            <strong>{diagnostic.cardName} · {labelSource(diagnostic.source)}</strong>
            <p>{diagnostic.effectiveMode} · {diagnostic.algorithmVersion} · {diagnostic.policyId}</p>
            <p>Bleed {diagnostic.bleedMm} mm · trim {diagnostic.trimSizeMm.widthMm} × {diagnostic.trimSizeMm.heightMm} mm · preview SHA-256 <code>{diagnostic.previewSha256}</code></p>
            <p>Cantos arredondados: {diagnostic.roundedCorners ? `sim · raio ${diagnostic.cornerRadiusMm} mm` : "não"}</p>
            <ul>{Object.entries(diagnostic.sideDiagnostics).map(([side, result]) => <li key={side}>
              {side}: {result.strategy}
            </li>)}</ul>
          </article>)}
          {bleedDiagnostics.truncated && <p className="muted">Relatório detalhado excedeu o limite do cabeçalho; resumo de {bleedDiagnostics.count ?? 0} carta(s).</p>}
          {Object.entries(bleedDiagnostics.effectiveModeCounts ?? {}).map(([mode, count]) => <p key={`mode-${mode}`}>Modo efetivo {mode}: {count}</p>)}
        </details>}
  </div>;

  function handleCompositorPhysicalAction(action: "increase" | "remove-copy" | "duplicate-copy" | "delete-entry" | "open-settings", instanceId: string, cardId: string) {
    if (interactionBusy) return;
    if (action === "increase") {
      const target = workingCards.find(({ id }) => id === cardId);
      if (target) dispatchEditor({ type: "set-quantity", cardId, quantity: target.quantity + 1 });
      return;
    }
    if (action === "remove-copy") {
      const target = workingCards.find(({ id }) => id === cardId);
      const previousIndex = physicalOrder.instances.findIndex(({ id }) => id === instanceId);
      const remaining = physicalOrder.instances.filter((reference) => reference.id !== instanceId && (target?.quantity !== 1 || reference.workingCardId !== cardId));
      setSelectedPhysicalInstanceId(remaining[Math.min(previousIndex, remaining.length - 1)]?.id ?? null);
      dispatchEditor({ type: "remove-physical-instance", instanceId });
      return;
    }
    if (action === "duplicate-copy") {
      const nextInstanceId = "instance-" + physicalOrder.nextInstanceId;
      dispatchEditor({ type: "duplicate-physical-instance", instanceId, newCardId: globalThis.crypto.randomUUID() });
      setSelectedPhysicalInstanceId(nextInstanceId);
      return;
    }
    if (action === "delete-entry") {
      const previousIndex = physicalOrder.instances.findIndex(({ id }) => id === instanceId);
      const remaining = physicalOrder.instances.filter(({ workingCardId }) => workingCardId !== cardId);
      setSelectedPhysicalInstanceId(remaining[Math.min(previousIndex, remaining.length - 1)]?.id ?? null);
      dispatchEditor({ type: "delete-card", cardId });
      return;
    }
    dispatchEditor({ type: "select-card", cardId });
    const cardsTab = document.getElementById("workspace-tab-cards");
    cardsTab?.click();
    cardsTab?.focus();
  }

  const preview = <div className="workspace-preview-stack">
    <div ref={liveCompositorRef} className="workspace-live-compositor" tabIndex={-1} inert={pdfProof ? true : undefined} aria-hidden={pdfProof ? true : undefined}>
      <RegistrationLayoutPreview
        settings={projectSettings}
        cardCount={physicalCardCount}
        cards={workingCards}
        physicalOrder={physicalOrder}
        selectedPhysicalInstanceId={selectedPhysicalInstanceId}
        face={compositorSide}
        interactionBusy={interactionBusy}
        cutPreview={cutGeometryPreview}
        selectedPageNumber={cutPageNumber}
        onSelectPage={setCutPageNumber}
        onSelectPhysicalInstance={(instanceId, cardId, side) => {
          setSelectedPhysicalInstanceId(instanceId);
          setCompositorSide(side);
          if (selectedCardId !== cardId) dispatchEditor({ type: "select-card", cardId });
          const target = workingCards.find((item) => item.id === cardId);
          if (target?.faces.some((item) => item.side === side) && face !== side) dispatchEditor({ type: "set-face", side });
        }}
        onFaceChange={(side) => {
          setCompositorSide(side);
          if (activeCard?.faces.some((item) => item.side === side) && face !== side) dispatchEditor({ type: "set-face", side });
        }}
        onSelectArtwork={(cardId, instanceId, physicalCardIndex, side, opener, copyNumber, totalCopies) => openArtworkPicker(cardId, side, opener, { instanceId, index: physicalCardIndex, copyNumber, totalCopies })}
        onPhysicalAction={handleCompositorPhysicalAction}
        onReorderPhysicalInstance={(instanceId, targetInstanceId, placement) => {
          if (!interactionBusy) dispatchEditor({ type: "reorder-physical-instance", instanceId, targetInstanceId, placement });
        }}
        onToggleSkippedSlot={(index) => updateProjectSetting(() => setSkippedSlotIndices((current) => current.includes(index) ? current.filter((slot) => slot !== index) : [...current, index].sort((left, right) => left - right)))}
      />
    </div>
    {pdfProof && <section className="compositor-proof-overlay" role="dialog" aria-label="Conferir PDF final" aria-modal="false">
      <header className="compositor-proof-heading">
        <div><h2>Conferir PDF final</h2><p>Arquivo lossless gerado pelo pipeline de impressão com originals validados.</p></div>
        <button ref={pdfProofCloseRef} className="button secondary" type="button" aria-label="Fechar conferência do PDF final" onClick={() => setPdfProof(null)}>Voltar ao compositor</button>
      </header>
      {pdfProofIsStale && <p className="compositor-proof-stale" role="status" aria-live="polite">PDF conferido anteriormente está desatualizado. O compositor live continua atualizado; feche esta conferência para voltar a ele.</p>}
      {pdfProof.separated && <div className="compositor-proof-side-controls" role="group" aria-label="PDFs finais separados">
        <button className={`button ${pdfProofSide === "front" ? "primary" : "secondary"}`} type="button" aria-pressed={pdfProofSide === "front"} onClick={() => setPdfProofSide("front")}>Frente final</button>
        <button className={`button ${pdfProofSide === "back" ? "primary" : "secondary"}`} type="button" aria-pressed={pdfProofSide === "back"} onClick={() => setPdfProofSide("back")}>Verso final</button>
      </div>}
      <iframe className="compositor-proof-frame" src={pdfProof.separated && pdfProofSide === "back" ? pdfProof.backUrl : pdfProof.frontUrl} title={pdfProof.separated ? `${pdfProofSide === "front" ? "Frente" : "Verso"} final em PDF` : `PDF final · ${pdfProof.contentMode}`} />
    </section>}
  </div>;

  return <>
    <WorkspaceShell
      preview={preview}
      hasCards={workingCards.length > 0}
      inert={pickerIsOpen}
      ariaHidden={pickerIsOpen}
      sharedPanel={{ id: "workspace-project-settings-panel", sections: sharedProjectSections, content: sharedProjectPanel }}
      sections={{
        cards: cardsSection,
        artwork: artworkSection,
        calibration: <div className="workspace-section-content">
          <PrinterCalibrationPanel
          paperFormat={paperFormat}
          pageOrientation={pageOrientation}
          printerProfileSelection={printerProfileSelection}
          printerDuplexMode={printerDuplexMode}
          exportContentMode={exportContentMode}
          duplexFlipMode={duplexFlipMode}
          disabled={interactionBusy}
          onProjectSelectionChange={(selection, mode) => updateProjectSetting(() => {
            setPrinterProfileSelection(selection);
            setPrinterDuplexMode(mode);
          })}
          />
        </div>,
        export: exportSection,
        diagnostics: diagnosticsSection,
      }}
    />
    {artworkPickerContent && <ArtworkPickerDialog title={pickerTitle} onClose={closeArtworkPicker} restoreFocusRef={pickerOpenerRef}>{artworkPickerContent}</ArtworkPickerDialog>}
  </>;
}
