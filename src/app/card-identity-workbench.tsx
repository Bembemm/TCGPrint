"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import Image from "next/image";
import type { ImportKind } from "../../import-engine/types";
import type { ArtworkCandidate, CardFaceSide, CardIdentity, WorkingCard } from "../../core/cards/types";

import { formatResolutionSummary } from "../../core/cards/resolution-summary";
import {
  createWorkingCardEditorState,
  deleteWorkingCard,
  duplicateWorkingCard,
  moveWorkingCard,
  replaceWorkingCard,
  replaceWorkingCards,
  selectWorkingCard,
  setWorkingCardQuantity,
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
import { postArtworkSelection } from "./artwork-selection-request";
import { clearRequestCache, createRequestCache, getOrCreateCachedRequest, updateResolvedRequestCache } from "./request-cache";
import { buildBleedExportOptions, buildCutGuideConfig, decodeBleedDiagnostics, type BleedDiagnosticsReport } from "./bleed-export-options";
import CutGuideControls from "./cut-guide-controls";
import type { GuideColor } from "../../core/geometry";

type ArtworkFilter = "all" | "scryfall" | "mpc" | "upload";
type CandidateDto = Omit<ArtworkCandidate, "originalUri" | "localOriginalPath" | "previewUri"> & {
  readonly previewUri?: string;
  readonly resolutionQuality?: "excellent" | "good" | "warning" | "low" | "unknown";
};

interface Props {
  readonly files: readonly File[];
  readonly text: string;
  readonly choices: Readonly<Record<string, ImportKind>>;
}

interface ApiErrorBody { readonly code?: string; readonly message?: string; }
interface IdentityDetails extends CardIdentity { readonly layout?: string; readonly relatedCards: readonly { readonly id: string; readonly component: string; readonly name: string; readonly typeLine?: string }[]; }
type ProviderHealth = Record<string, { available: boolean; degraded: boolean; message?: string }>;
interface ArtworkCatalogResult { readonly candidates: CandidateDto[]; readonly providerHealth: ProviderHealth; }

async function jsonResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(`Server response was not JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error((body as ApiErrorBody)?.message ?? `Request failed (${response.status}).`);
  return body as T;
}

function labelSource(source: string): string {
  return source === "scryfall" ? "Scryfall" : source === "mpc" ? "MPC Autofill" : source === "upload" ? "Meus uploads" : source;
}

function resolutionQualityLabel(value: CandidateDto["resolutionQuality"]): string {
  if (value === "excellent") return "excelente";
  if (value === "good") return "bom";
  if (value === "warning") return "warning";
  if (value === "low") return "baixa resolução";
  return "desconhecida";
}

function displayCard(card: WorkingCard): string {
  return card.identity?.name ?? card.identityHints.name ?? card.importSource.filename ?? "Carta custom";
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

      return <article
        key={card.id}
        className={`working-card-row ${card.id === selectedCardId ? "is-active" : ""}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("text/plain")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
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
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", card.id);
          }}
        >⠿</span>
        <button type="button" className="working-card-select" aria-pressed={card.id === selectedCardId} onClick={() => onSelect(card.id)}>
          <span className="working-card-name">{index + 1}/{orderedCards.length} · {name}</span>
          <span className="working-card-meta">×{card.quantity} · {card.section ?? "sem seção"} · {statusLabel(card)}</span>
          <span className="working-card-meta">{artworkStatus}</span>
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
  | { readonly type: "replace-cards"; readonly cards: readonly WorkingCard[] }
  | { readonly type: "replace-card"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-identity-result"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-custom-result"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-artwork-selection"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-artwork-default"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-reresolve-result"; readonly cardId: string; readonly card: WorkingCard }
  | { readonly type: "apply-resolve-all-result"; readonly cards: readonly WorkingCard[] }
  | { readonly type: "select-card"; readonly cardId: string }
  | { readonly type: "set-quantity"; readonly cardId: string; readonly quantity: number }
  | { readonly type: "adjust-quantity"; readonly cardId: string; readonly delta: -1 | 1 }
  | { readonly type: "move-card"; readonly cardId: string; readonly targetIndex: number }
  | { readonly type: "duplicate-card"; readonly cardId: string; readonly newCardId: string }
  | { readonly type: "delete-card"; readonly cardId: string }
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
      case "replace-cards": return preserveActiveFace(state, replaceWorkingCards(state, action.cards));
      case "replace-card": return preserveActiveFace(state, replaceWorkingCard(state, action.cardId, action.card));
      case "apply-identity-result":
      case "apply-custom-result":
      case "apply-artwork-selection":
      case "apply-artwork-default":
      case "apply-reresolve-result":
        return preserveActiveFace(state, replaceWorkingCard(state, action.cardId, action.card));
      case "apply-resolve-all-result": return preserveActiveFace(state, replaceWorkingCards(state, action.cards));
      case "select-card": return withActiveFace(selectWorkingCard(state, action.cardId), "front");
      case "set-face": return withActiveFace(state, action.side);
      case "set-quantity": return preserveActiveFace(state, setWorkingCardQuantity(state, action.cardId, action.quantity));
      case "adjust-quantity": {
        const card = state.cards.find((item) => item.id === action.cardId);
        return preserveActiveFace(state, setWorkingCardQuantity(state, action.cardId, (card?.quantity ?? 0) + action.delta));
      }
      case "move-card": return preserveActiveFace(state, moveWorkingCard(state, action.cardId, action.targetIndex));
      case "duplicate-card": return preserveActiveFace(state, duplicateWorkingCard(state, action.cardId, action.newCardId));
      case "delete-card": return preserveActiveFace(state, deleteWorkingCard(state, action.cardId));
    }
  } catch (error) {
    return { ...state, error: error instanceof Error ? error.message : "A operação do Editor falhou." };
  }
}

function snapshotFromEditorState(state: EditorUiState): EditorSnapshot {
  return { cards: state.cards, selectedCardId: state.selectedCardId, face: state.face };
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
      return true;
    case "load-cards":
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
  if (action.type === "load-cards") {
    return { ...resetEditorHistory(state, nextSnapshot), error: undefined };
  }

  const nextHistory = isEditorialAction(action)
    ? commitEditorHistory(state, nextSnapshot)
    : updateEditorHistoryPresent(state, nextSnapshot);
  return { ...nextHistory, error: undefined };
}

const initialEditorState: EditorUiState = { ...createWorkingCardEditorState([]), face: "front" };
const initialEditorHistoryState: EditorHistoryUiState = createEditorHistoryState(initialEditorState);

export default function CardIdentityWorkbench({ files, text, choices }: Props) {
  const [editorHistory, dispatchEditor] = useReducer(editorHistoryReducer, initialEditorHistoryState);
  const editorState: EditorUiState = { ...editorHistory.present, error: editorHistory.error };
  const workingCards = editorState.cards;
  const selectedCardId = editorState.selectedCardId;
  const face = editorState.face;
  const [artworkCandidates, setArtworkCandidates] = useState<CandidateDto[]>([]);
  const [artworkCatalogRevision, setArtworkCatalogRevision] = useState(0);
  const [artworkFilter, setArtworkFilter] = useState<ArtworkFilter>("all");
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const [problemCardId, setProblemCardId] = useState<string | null>(null);
  const [artworkProblem, setArtworkProblem] = useState<{ message: string; cardId: string; requestKey: string } | null>(null);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth>({});
  const [identityDetails, setIdentityDetails] = useState<IdentityDetails | null>(null);
  const artworkCatalogRequests = useRef(createRequestCache<ArtworkCatalogResult>());
  const identityDetailsRequests = useRef(createRequestCache<IdentityDetails>());
  const [pdfUrl, setPdfUrl] = useState("");
  const [bleedDiagnostics, setBleedDiagnostics] = useState<BleedDiagnosticsReport | null>(null);

  function clearProblem(cardId: string | null = null) {
    setProblem("");
    setProblemCardId(cardId);
  }


  const activeCard = useMemo(() => workingCards.find((card) => card.id === selectedCardId), [workingCards, selectedCardId]);
  const physicalCardCount = useMemo(() => workingCards.reduce((sum, card) => sum + card.quantity, 0), [workingCards]);
  const filterCards = useMemo(() => artworkCandidates.filter((candidate) => artworkFilter === "all" || candidate.source === artworkFilter), [artworkCandidates, artworkFilter]);
  const activeFaceExists = Boolean(activeCard?.faces.some((item) => item.side === face));
  const activeIdentityId = activeCard?.identity?.id ?? null;
  const artworkRequest = activeCard && activeFaceExists
    ? {
      identityId: activeIdentityId ?? "custom:artwork-picker",
      faceId: face,
      source: artworkFilter,
      mpcReferences: activeCard.mpcReferences,
      cacheKey: JSON.stringify([activeIdentityId, face, artworkFilter, activeCard.mpcReferences, artworkCatalogRevision]),
    }
    : null;
  const visibleProblem = problem && (problemCardId === null || problemCardId === selectedCardId) ? problem : "";
  const visibleArtworkProblem = artworkProblem
    && artworkProblem.cardId === activeCard?.id
    && artworkProblem.requestKey === artworkRequest?.cacheKey
    ? artworkProblem.message
    : "";

  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || busy) return;
      const target = event.target;
      const textEditingFocused = target instanceof HTMLElement && isEditorTextEditingTarget(target);
      const command = editorHistoryShortcut(event, textEditingFocused);
      if (!command) return;
      event.preventDefault();
      dispatchEditor({ type: command });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy]);

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
    if (!artworkRequest || !activeCard) { setArtworkCandidates([]); setArtworkProblem(null); return; }
    setArtworkProblem(null);
    const requestKey = artworkRequest.cacheKey;
    const cardId = activeCard.id;
    let current = true;
    const request = getOrCreateCachedRequest(artworkCatalogRequests.current, artworkRequest.cacheKey, async () => {
      const response = await fetch(`/api/cards/${encodeURIComponent(artworkRequest.identityId)}/artworks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ faceId: artworkRequest.faceId, source: artworkRequest.source, mpcReferences: artworkRequest.mpcReferences }),
      });
      return jsonResponse<ArtworkCatalogResult>(response);
    });
    void request
      .then((result) => {
        if (!current) return;
        setArtworkCandidates(result.candidates);
        setProviderHealth((current) => ({ ...current, ...result.providerHealth }));
        setArtworkProblem(null);
      })
      .catch((error: unknown) => {
        if (current) {
          setArtworkCandidates([]);
          setArtworkProblem({
            message: error instanceof Error ? error.message : "Não foi possível abrir o catálogo de artes.",
            cardId,
            requestKey,
          });
        }
      });
    return () => { current = false; };
  }, [artworkRequest?.cacheKey, activeCard?.id]);

  useEffect(() => {
    if (!activeIdentityId) { setIdentityDetails(null); return; }
    let current = true;
    const request = getOrCreateCachedRequest(identityDetailsRequests.current, activeIdentityId, async () => {
      const response = await fetch(`/api/cards/${encodeURIComponent(activeIdentityId)}`);
      const result = await jsonResponse<{ identity: IdentityDetails }>(response);
      return result.identity;
    });
    void request
      .then((identity) => { if (current) setIdentityDetails(identity); })
      .catch(() => { if (current) setIdentityDetails(null); });
    return () => { current = false; };
  }, [activeIdentityId]);

  async function importToWorkingSet() {
    if (!files.length && !text.trim()) { clearProblem(); setProblem("Adicione arquivos ou cole uma decklist antes de importar."); return; }
    setBusy(true); clearProblem(); setStatus("Universal Import → Working Set…"); setPdfUrl("");
    try {
      const form = new FormData();
      files.forEach((file) => form.append("files", file, file.name));
      form.set("filePaths", JSON.stringify(files.map((file) => file.webkitRelativePath || "")));
      if (text.trim()) form.set("text", text);
      form.set("selections", JSON.stringify(choices));
      const response = await fetch("/api/cards/import", { method: "POST", body: form });
      const result = await jsonResponse<{ workingCards: WorkingCard[]; providerHealth: typeof providerHealth }>(response);
      clearRequestCache(artworkCatalogRequests.current);
      setArtworkCatalogRevision((revision) => revision + 1);
      setArtworkCandidates([]);
      setArtworkProblem(null);
      dispatchEditor({ type: "load-cards", cards: result.workingCards });
      setArtworkFilter("all"); setManualIdentities([]);
      setProviderHealth(result.providerHealth);
      setStatus(`${result.workingCards.length} entradas no Working Set. Quantidades permanecem compactas.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Não foi possível importar para o Working Set."); setStatus("");
    } finally { setBusy(false); }
  }

  async function resolveAll() {
    if (!workingCards.length) return;
    setBusy(true); clearProblem(); setStatus("Resolvendo identidades pelo Scryfall…");
    try {
      const response = await fetch("/api/cards/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resolve", cards: workingCards }) });
      const result = await jsonResponse<{ workingCards: WorkingCard[]; providerHealth: typeof providerHealth }>(response);
      dispatchEditor({ type: "apply-resolve-all-result", cards: result.workingCards }); setProviderHealth(result.providerHealth);
      setStatus(formatResolutionSummary(result.workingCards, result.providerHealth));
    } catch (error) { setProblem(error instanceof Error ? error.message : "A resolução falhou."); setStatus(""); }
    finally { setBusy(false); }
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

  async function chooseArtwork(candidate: CandidateDto) {
    if (!activeCard || !artworkRequest) return;
    const problemCardId = activeCard.id;
    const problemRequestKey = artworkRequest.cacheKey;
    setBusy(true); setArtworkProblem(null); clearProblem(problemCardId);
    try {
      if (candidate.originalAvailable) {
        const prepareResponse = await fetch(`/api/cards/artworks/${encodeURIComponent(candidate.id)}/prepare`, { method: "POST" });
        const prepared = await jsonResponse<{ candidate: CandidateDto }>(prepareResponse);
        updateResolvedRequestCache(artworkCatalogRequests.current, problemRequestKey, (cached) => ({
          ...cached,
          candidates: cached.candidates.map((item) => item.id === prepared.candidate.id ? prepared.candidate : item),
        }));
        setArtworkCandidates((current) => current.map((item) => item.id === candidate.id ? prepared.candidate : item));
      }
      const response = await postArtworkSelection(activeCard, face, candidate.id);
      const result = await jsonResponse<{ workingCards: WorkingCard[] }>(response);
      dispatchEditor({ type: "apply-artwork-selection", cardId: activeCard.id, card: result.workingCards[0] });
      setStatus(candidate.originalAvailable ? "Artwork selecionado; original validado e armazenado no cache." : "Referência MPC selecionada; nenhum original local está disponível.");
    } catch (error) {
      setArtworkProblem({
        message: error instanceof Error ? error.message : "Não foi possível selecionar essa arte.",
        cardId: problemCardId,
        requestKey: problemRequestKey,
      });
    }
    finally { setBusy(false); }
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

  async function exportPdf() {
    if (!workingCards.length) return;
    setBleedDiagnostics(null);
    setBusy(true); clearProblem(); setStatus("Compondo quantidade física e gerando PDF A4…");
    try {
      const response = await fetch("/api/cards/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: workingCards, options: buildBleedExportOptions(
          bleedMm,
          buildCutGuideConfig(trimGuideEnabled, trimGuideExtentMm, externalGuideEnabled, externalGuideStrokeWidthPt, trimGuideColor, externalGuideColor),
          roundedCorners,
        ) }),
      });
      if (!response.ok) {
        const body = await response.json() as ApiErrorBody;
        throw new Error(body.message ?? "Não foi possível gerar o PDF.");
      }
      setBleedDiagnostics(decodeBleedDiagnostics(response.headers.get("x-tcgprint-bleed-diagnostics")));
      const nextUrl = URL.createObjectURL(await response.blob());
      setPdfUrl(nextUrl); setStatus("PDF pronto · A4 · trim 63,5 × 88,9 mm · bleed externo · guias vetoriais.");
    } catch (error) { setBleedDiagnostics(null); setProblem(error instanceof Error ? error.message : "Export falhou."); setStatus(""); }
    finally { setBusy(false); }
  }

  const selected = activeCard ? selectedFor(activeCard, face) : undefined;

  return (
    <section className="panel card-identity-workbench" aria-labelledby="identity-workbench-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Fase 6B · Working Set da sessão</p>
          <h2 id="identity-workbench-heading">Identidade da carta e artwork</h2>
          <p>Card Details separa origem/hints importados da identidade aplicada; artwork e escolhas permanecem por face nesta sessão.</p>
        </div>
        <div className="provider-health" aria-label="Estado dos providers">
          {(["scryfall", "upload", "mpc"] as const).map((source) => {
            const health = providerHealth[source];
            return <span key={source} className={health?.degraded ? "health-degraded" : ""}>{labelSource(source)} · {health?.degraded ? "degradado" : "disponível"}</span>;
          })}
        </div>
      </div>

      <div className="action-row phase5-actions">
        <button className="button primary" type="button" onClick={importToWorkingSet} disabled={busy}>{busy ? "Processando…" : "Universal Import → Working Set"}</button>
        <button className="button secondary" type="button" onClick={resolveAll} disabled={busy || !workingCards.length}>Resolver identidades</button>
        <div className="editor-history-controls" role="group" aria-label="Histórico do editor">
          <button className="button secondary" type="button" aria-label="Desfazer" aria-keyshortcuts="Control+Z Meta+Z" disabled={busy || editorHistory.past.length === 0} onClick={() => dispatchEditor({ type: "undo" })}>Desfazer</button>
          <button className="button secondary" type="button" aria-label="Refazer" aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z" disabled={busy || editorHistory.future.length === 0} onClick={() => dispatchEditor({ type: "redo" })}>Refazer</button>
        </div>
        <span className="status" aria-live="polite">{status}</span>
      </div>
      {(visibleProblem || editorState.error) && <p className="error-message" role="alert">{visibleProblem || editorState.error}</p>}

      {workingCards.length > 0 && <div className="card-workbench-layout">
        <WorkingCardList
          cards={workingCards}
          selectedCardId={selectedCardId}
          physicalCardCount={physicalCardCount}
          disabled={busy}
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
            {activeCard.faces.length > 1 && <span className="multiface-label">DFC / multiface · carta dupla-face</span>}
          </div>

          <WorkingCardDetailsSummary card={activeCard} identityLayout={identityDetails?.layout} artworkCandidates={artworkCandidates} />
          <div className="card-identity-actions">
            <button className="button secondary" type="button" disabled={busy} onClick={() => void reresolveCard(activeCard)}>Re-resolver esta carta</button>
          </div>

          {(activeCard.identityResolution.candidates.length > 0 || activeCard.identityResolution.status === "suggested" || activeCard.identityResolution.status === "ambiguous") && <div className="identity-suggestions">
            <strong>Confirme uma sugestão</strong>
            {activeCard.identityResolution.candidates.map(({ identity: candidateIdentity, score, reason }) => (
              <div className="identity-option" key={candidateIdentity.id}>
                <span>{candidateIdentity.name} · {(score * 100).toFixed(0)}% · {reason}</span>
                <button className="button secondary" type="button" disabled={busy} onClick={() => void confirmIdentity(activeCard, candidateIdentity)}>Usar esta identidade</button>
              </div>
            ))}
          </div>}

          <div className="manual-identity-search">
            <label className="field-label" htmlFor="manual-card-search">Escolher outra identidade</label>
            <div className="manual-search-row">
              <input id="manual-card-search" value={manualQuery} onChange={(event) => { setAutocompleteEnabled(true); setManualQuery(event.currentTarget.value); }} onKeyDown={(event) => { if (event.key === "Enter") void searchIdentities(); }} placeholder="Nome da carta" />
              <button className="button secondary" type="button" disabled={busy || manualQuery.trim().length < 2} onClick={() => void searchIdentities()}>Buscar</button>
            </div>
            {autocompleteEnabled && autocompleteNames.length > 0 && <div className="autocomplete-list" role="listbox" aria-label="Autocompletar carta">
              {autocompleteNames.map((name) => <button type="button" role="option" key={name} onClick={() => { setManualQuery(name); void searchIdentities(name); }}>{name}</button>)}
            </div>}
            {manualIdentities.map((identity) => <div className="identity-option manual-result" key={identity.id}>
              <span>{identity.name}{identity.setCode ? ` · ${identity.setCode.toUpperCase()} #${identity.collectorNumber ?? "?"}` : ""}</span>
              <button className="button secondary" type="button" disabled={busy} onClick={() => void confirmIdentity(activeCard, identity)}>Usar esta identidade</button>
            </div>)}
            <button className="button secondary custom-button" type="button" disabled={busy} onClick={() => void keepCustom(activeCard)}>Manter como custom</button>
          </div>

          {(identityDetails?.relatedCards.length || relatedCardNames(activeCard).length) > 0 && <div className="related-card-list"><strong>Related cards / tokens:</strong> {(identityDetails?.relatedCards ?? relatedCardNames(activeCard)).map((item) => `${item.name}${item.component === "token" ? " (token; não adicionado)" : ""}`).join(" · ")}</div>}

          {activeCard.faces.length > 1 && <div className="face-tabs" role="group" aria-label="Face da carta">
            {activeCard.faces.map((item) => <button key={item.side} type="button" className={`button ${face === item.side ? "primary" : "secondary"}`} onClick={() => dispatchEditor({ type: "set-face", side: item.side })}>{item.side === "front" ? "Front" : "Back"}{item.name ? ` · ${item.name}` : ""}</button>)}
          </div>}

          <div className="artwork-section">
            <div className="compact-heading"><div><strong>Artwork Picker · {face === "front" ? "Front" : "Back"}</strong><span>Seleção atual é preservada durante a atualização do catálogo.</span></div></div>
            <div className="artwork-filter-row" role="group" aria-label="Filtrar origem das artes">
              {([ ["all", "Todas"], ["scryfall", "Scryfall"], ["mpc", "MPC Autofill"], ["upload", "Meus uploads"] ] as const).map(([value, label]) => <button key={value} type="button" className={`button ${artworkFilter === value ? "primary" : "secondary"}`} onClick={() => setArtworkFilter(value)}>{label}</button>)}
            </div>
            {selected && <p className="selected-artwork-line">Selecionada: {labelSource(selected.source)} · {selected.candidateId} · {artworkPolicyLabel(selected)}</p>}
            <button
              className="button secondary restore-artwork-default"
              type="button"
              disabled={busy || !activeCard.identity || !activeFaceExists}
              title={!activeCard.identity ? "Não há identidade resolvida para determinar uma artwork padrão." : undefined}
              onClick={() => void restoreArtworkDefault(activeCard, face)}
            >Restaurar artwork padrão desta face</button>
            {!activeCard.identity && <p className="muted">Não há identidade resolvida para determinar uma artwork padrão.</p>}
            {visibleArtworkProblem && <p className="error-message" role="alert">{visibleArtworkProblem}</p>}
            {filterCards.length === 0 && !visibleArtworkProblem && <p className="muted">Nenhuma arte disponível neste filtro. Referências MPC não possuem original se não foram importadas localmente.</p>}
            <div className="artwork-grid">
              {filterCards.map((candidate) => {
                const isSelected = selected?.candidateId === candidate.id;
                return <article className={`artwork-candidate ${isSelected ? "is-selected" : ""}`} key={candidate.id}>
                  {candidate.previewUri ? <Image src={candidate.previewUri} alt={`${displayCard(activeCard)} · ${candidate.setCode ?? labelSource(candidate.source)} ${candidate.collectorNumber ?? ""}`} width={300} height={420} unoptimized /> : <div className="artwork-reference-thumb">{candidate.source === "mpc" ? "MPC reference" : "Preview indisponível"}</div>}
                  <div className="candidate-meta">
                    <strong>{candidate.faceName ?? candidate.metadata?.originalFilename as string ?? labelSource(candidate.source)}</strong>
                    <span>{labelSource(candidate.source)}{candidate.setCode ? ` · ${candidate.setCode.toUpperCase()} #${candidate.collectorNumber ?? "?"}` : ""}</span>
                    <span>{candidate.language ? candidate.language.toUpperCase() : "idioma não informado"}{candidate.effectiveDpi ? ` · ${candidate.effectiveDpi} DPI · ${resolutionQualityLabel(candidate.resolutionQuality)}` : " · DPI será calculado ao validar o original"}</span>
                    {candidate.source === "mpc" && <span className="reference-status">{candidate.originalCached ? "original em cache local" : candidate.originalAvailable ? "original remoto informado · validação no download" : "referência sem original disponível"}</span>}
                    {candidate.source === "mpc" && candidate.metadata?.localAvailabilityHint === true && !candidate.originalCached && <span className="reference-status">XML relata disponibilidade local; bytes ainda não verificados no cache</span>}
                  </div>
                  <button className={`button ${isSelected ? "primary" : "secondary"}`} type="button" disabled={busy} onClick={() => void chooseArtwork(candidate)}>{isSelected && candidate.originalAvailable && !candidate.effectiveDpi ? "Validar original e calcular DPI" : isSelected ? "Selecionada" : candidate.originalAvailable ? "Selecionar arte" : "Selecionar referência"}</button>
                </article>;
              })}
            </div>
          </div>
        </div>}
      </div>}

      {workingCards.length > 0 && <div className="phase5-export">
        <div className="panel-heading"><div><h3>Export PDF</h3><p>PDF A4 · Magic Standard 63,5 × 88,9 mm · quantities expandidas somente na composição.</p></div></div>
        <div className="pdf-controls">
          <label className="narrow-field">Bleed externo (mm)<input type="number" min="0" max="3" step="0.125" value={bleedMm} onChange={(event) => setBleedMm(event.currentTarget.value)} /></label>
          <label className="checkbox-field"><input type="checkbox" checked={roundedCorners} onChange={(event) => setRoundedCorners(event.currentTarget.checked)} /> Cantos arredondados (opcional; desligado por padrão)</label>
          <CutGuideControls
            trimEnabled={trimGuideEnabled}
            trimExtentMm={trimGuideExtentMm}
            trimColor={trimGuideColor}
            externalEnabled={externalGuideEnabled}
            externalStrokeWidthPt={externalGuideStrokeWidthPt}
            externalColor={externalGuideColor}
            onTrimEnabledChange={setTrimGuideEnabled}
            onTrimExtentMmChange={setTrimGuideExtentMm}
            onTrimColorChange={setTrimGuideColor}
            onExternalEnabledChange={setExternalGuideEnabled}
            onExternalStrokeWidthPtChange={setExternalGuideStrokeWidthPt}
            onExternalColorChange={setExternalGuideColor}
          />
          <button className="button primary" type="button" disabled={busy || !workingCards.every((card) => Boolean(card.selectedArtworkByFace.front))} onClick={() => void exportPdf()}>Gerar PDF real</button>
          {pdfUrl && <a className="download-link" href={pdfUrl} download="tcgprint-cards.pdf">Baixar PDF</a>}
        </div>
        <p className="muted">Bleed estende somente os pixels da borda imediata de cada lado. Moldura preta continua preta; full-art continua a própria arte. O trim da carta permanece intacto. Cantos arredondados são uma opção separada.</p>
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
      </div>}
    </section>
  );
}
