import Image from "next/image";
import { useState } from "react";
import type { ArtworkCandidate } from "../../core/cards/types";

export const ARTWORK_WINDOW_SIZE = 60;

export type ArtworkQualityStatus = "verified" | "provider-reported" | "checking" | "unknown" | "unavailable";
export type ArtworkSortMode = "recommended" | "dpi" | "recent" | "provider";

export type ArtworkCandidateView = Omit<ArtworkCandidate, "originalUri" | "localOriginalPath"> & {
  readonly resolutionQuality?: "excellent" | "good" | "warning" | "low" | "unknown";
  readonly qualityStatus?: ArtworkQualityStatus;
};

export function sliceArtworkWindow<T>(items: readonly T[], limit: number): readonly T[] {
  return items.slice(0, Math.max(0, limit));
}

export function sliceArtworkPage<T>(items: readonly T[], pageIndex: number, pageSize = ARTWORK_WINDOW_SIZE): readonly T[] {
  const safePage = Math.max(0, Math.floor(pageIndex));
  const safePageSize = Math.max(1, Math.floor(pageSize));
  return items.slice(safePage * safePageSize, (safePage + 1) * safePageSize);
}

export function filterAndSortArtworkCandidates<T extends ArtworkCandidateView>(
  candidates: readonly T[],
  query: string,
  sort: ArtworkSortMode,
): readonly T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = candidates.filter((candidate) => !normalizedQuery || [
    candidate.faceName,
    candidate.setCode,
    candidate.collectorNumber,
    candidate.language,
    candidate.source,
    candidate.releasedAt,
    candidate.metadata?.name,
    candidate.metadata?.sourceName,
    candidate.metadata?.originalFilename,
    ...(Array.isArray(candidate.metadata?.tags) ? candidate.metadata.tags : []),
  ].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalizedQuery)));
  if (sort === "recommended") return filtered;
  if (sort === "provider") {
    const result: T[] = [];
    for (let start = 0; start < filtered.length;) {
      let end = start + 1;
      while (end < filtered.length && filtered[end]!.source === filtered[start]!.source) end += 1;
      const providerGroup = filtered.slice(start, end).map((candidate, index) => ({ candidate, index }));
      providerGroup.sort((left, right) => {
        const leftRank = typeof left.candidate.metadata?.providerRank === "number" ? left.candidate.metadata.providerRank : undefined;
        const rightRank = typeof right.candidate.metadata?.providerRank === "number" ? right.candidate.metadata.providerRank : undefined;
        if (leftRank === undefined && rightRank === undefined) return left.index - right.index;
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        return leftRank - rightRank || left.index - right.index;
      });
      result.push(...providerGroup.map(({ candidate }) => candidate));
      start = end;
    }
    return result;
  }
  const dpi = (candidate: T) => candidate.effectiveDpi ?? (typeof candidate.metadata?.dpi === "number" ? candidate.metadata.dpi : -1);
  const date = (candidate: T) => {
    const value = candidate.releasedAt
      ?? (typeof candidate.metadata?.dateCreated === "string" ? candidate.metadata.dateCreated : undefined)
      ?? (typeof candidate.metadata?.dateModified === "string" ? candidate.metadata.dateModified : undefined)
      ?? (typeof candidate.metadata?.createdAt === "string" ? candidate.metadata.createdAt : undefined)
      ?? (typeof candidate.metadata?.modifiedAt === "string" ? candidate.metadata.modifiedAt : "");
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : -1;
  };
  return filtered.map((candidate, index) => ({ candidate, index })).sort((left, right) => {
    const difference = sort === "dpi" ? dpi(right.candidate) - dpi(left.candidate) : date(right.candidate) - date(left.candidate);
    return difference || left.index - right.index;
  }).map(({ candidate }) => candidate);
}

export function artworkWindowLimitForRequest(window: { readonly requestKey: string; readonly limit: number }, requestKey: string): number {
  return window.requestKey === requestKey ? window.limit : ARTWORK_WINDOW_SIZE;
}

function sourceLabel(source: string): string {
  return source === "scryfall" ? "Scryfall" : source === "mpc" ? "MPC Autofill" : source === "upload" ? "Meus uploads" : source;
}

function resolutionLabel(value: ArtworkCandidateView["resolutionQuality"]): string {
  if (value === "excellent") return "excelente";
  if (value === "good") return "bom";
  if (value === "warning") return "atenção";
  if (value === "low") return "baixa resolução";
  return "desconhecida";
}

function qualityLine(candidate: ArtworkCandidateView, checking: boolean): string {
  const providerDpi = candidate.source === "mpc" && typeof candidate.metadata?.dpi === "number"
    ? `${candidate.metadata.dpi} DPI informado pelo MPC`
    : undefined;
  if (candidate.effectiveDpi !== undefined && candidate.effectiveDpi > 0) {
    return `${candidate.effectiveDpi} DPI efetivo · verificado ✓${providerDpi ? ` · ${providerDpi}` : ""} · ${resolutionLabel(candidate.resolutionQuality)}`;
  }
  if (!candidate.originalAvailable || candidate.qualityStatus === "unavailable") return "DPI efetivo · original indisponível";
  if (checking || candidate.qualityStatus === "checking") return "DPI efetivo · verificando…";
  if (providerDpi) {
    return `${providerDpi} · DPI efetivo · desconhecido`;
  }
  return "DPI efetivo · desconhecido";
}

function qualityBadge(candidate: ArtworkCandidateView, checking: boolean): string {
  if (checking || candidate.qualityStatus === "checking") return "Verificando";
  if (candidate.effectiveDpi !== undefined && candidate.effectiveDpi > 0) return `${candidate.effectiveDpi} DPI`;
  if (candidate.source === "mpc" && typeof candidate.metadata?.dpi === "number") return `${candidate.metadata.dpi} DPI*`;
  if (!candidate.originalAvailable || candidate.qualityStatus === "unavailable") return "Sem original";
  return "DPI ?";
}


export interface ArtworkCandidateGridProps {
  readonly candidates: readonly ArtworkCandidateView[];
  readonly windowLimit: number;
  readonly pageIndex?: number;
  readonly pageSize?: number;
  readonly onPageChange?: (pageIndex: number) => void;
  readonly catalogTotal: number;
  readonly catalogTotalComplete?: boolean;
  readonly filterTotal: number;
  readonly catalogLabel: string;
  readonly cardName: string;
  readonly selectedCandidateId?: string;
  readonly disabled?: boolean;
  readonly qualityCheckingIds?: ReadonlySet<string>;
  readonly onSelect: (candidate: ArtworkCandidateView) => void;
  readonly onRevalidate?: (candidate: ArtworkCandidateView) => void;
  readonly onLoadMore: () => void;
}

export function ArtworkCandidateGrid({
  candidates,
  windowLimit,
  pageIndex,
  pageSize = ARTWORK_WINDOW_SIZE,
  onPageChange,
  catalogTotal,
  catalogTotalComplete = true,
  filterTotal,
  catalogLabel,
  cardName,
  selectedCandidateId,
  disabled = false,
  qualityCheckingIds = new Set<string>(),
  onSelect,
  onRevalidate,
  onLoadMore,
}: ArtworkCandidateGridProps) {
  const [jumpToResult, setJumpToResult] = useState("");
  const paginated = pageIndex !== undefined && onPageChange !== undefined;
  const visibleCandidates = paginated ? sliceArtworkPage(candidates, pageIndex, pageSize) : sliceArtworkWindow(candidates, windowLimit);
  const hasMore = visibleCandidates.length < candidates.length;
  const pageCount = Math.max(1, Math.ceil(candidates.length / pageSize));
  const firstResult = candidates.length === 0 ? 0 : paginated ? pageIndex * pageSize + 1 : 1;
  const lastResult = paginated ? Math.min((pageIndex + 1) * pageSize, candidates.length) : visibleCandidates.length;

  return <>
    <p className="artwork-catalog-count" aria-live="polite">
      {catalogLabel} · {catalogTotal} artworks{catalogTotalComplete ? "" : " conhecidas · catálogo parcial"}
      {paginated
        ? <span> · {firstResult}{lastResult > 0 ? `–${lastResult}` : ""} de {filterTotal} nesta busca</span>
        : <span> · {visibleCandidates.length} de {catalogTotal} exibidas · {filterTotal} de {catalogTotal}{catalogTotalComplete ? "" : " conhecidas"} correspondem ao filtro</span>}
    </p>
    {paginated && <div className="artwork-pagination" role="group" aria-label="Navegação do catálogo">
      <button className="button secondary" type="button" disabled={pageIndex === 0} onClick={() => onPageChange(Math.max(0, pageIndex - 1))}>Anterior</button>
      <span>Página {Math.min(pageIndex + 1, pageCount)} de {pageCount}</span>
      <button className="button secondary" type="button" disabled={pageIndex + 1 >= pageCount} onClick={() => onPageChange(Math.min(pageCount - 1, pageIndex + 1))}>Próxima</button>
      <form onSubmit={(event) => {
        event.preventDefault();
        const rank = Number(jumpToResult);
        if (Number.isSafeInteger(rank) && rank > 0 && rank <= candidates.length) onPageChange(Math.floor((rank - 1) / pageSize));
      }}>
        <label>Ir para resultado<input aria-label="Ir para resultado do catálogo" type="number" min={1} max={candidates.length} value={jumpToResult} onChange={(event) => setJumpToResult(event.target.value)} /></label>
        <button className="button secondary" type="submit" disabled={!Number.isSafeInteger(Number(jumpToResult)) || Number(jumpToResult) < 1 || Number(jumpToResult) > candidates.length}>Ir</button>
      </form>
    </div>}
    <div className="artwork-grid">
      {visibleCandidates.map((candidate, visibleIndex) => {
        const isSelected = selectedCandidateId === candidate.id;
        const mpcSourceName = typeof candidate.metadata?.sourceName === "string" ? candidate.metadata.sourceName : undefined;
        const format = typeof candidate.metadata?.originalFormat === "string"
          ? candidate.metadata.originalFormat.toUpperCase()
          : typeof candidate.metadata?.extension === "string" ? candidate.metadata.extension.toUpperCase() : undefined;
        const size = typeof candidate.metadata?.declaredSize === "number" ? candidate.metadata.declaredSize
          : typeof candidate.metadata?.byteLength === "number" ? candidate.metadata.byteLength : undefined;
        const tags = Array.isArray(candidate.metadata?.tags) ? candidate.metadata.tags.filter((tag): tag is string => typeof tag === "string") : [];
        const checking = qualityCheckingIds.has(candidate.id);

        const resultNumber = (paginated ? pageIndex * pageSize : 0) + visibleIndex + 1;
        const title = candidate.faceName ?? candidate.metadata?.name as string ?? candidate.metadata?.originalFilename as string ?? sourceLabel(candidate.source);
        const compactIdentity = candidate.setCode
          ? `${candidate.setCode.toUpperCase()} #${candidate.collectorNumber ?? "?"}${candidate.language ? ` · ${candidate.language.toUpperCase()}` : ""}`
          : sourceLabel(candidate.source);
        return <article className={`artwork-candidate ${isSelected ? "is-selected" : ""}`} key={candidate.id} data-candidate-rank={resultNumber}>
          <button
            className="artwork-candidate-preview"
            type="button"
            disabled={disabled}
            aria-label={`Escolher visualmente ${title}`}
            onClick={() => onSelect(candidate)}
          >
            {candidate.previewUri
              ? <Image src={candidate.previewUri} alt={`${cardName} · ${candidate.setCode ?? sourceLabel(candidate.source)} ${candidate.collectorNumber ?? ""}`} width={300} height={420} unoptimized loading="lazy" />
              : <span className="artwork-reference-thumb">{candidate.source === "mpc" ? "MPC reference" : "Preview indisponível"}</span>}
            <span className="artwork-quality-badge">{qualityBadge(candidate, checking)}</span>
            {isSelected && <span className="artwork-selected-badge">Selecionada</span>}
          </button>
          <div className="candidate-primary">
            <strong>{title}</strong>
            <span>{compactIdentity}</span>
          </div>
          <details className="candidate-technical">
            <summary>Detalhes</summary>
            <div className="candidate-meta">
              {paginated && <span className="candidate-result-number">Resultado #{resultNumber}</span>}
              <span>Provider: {sourceLabel(candidate.source)} · Face: {candidate.faceId === "back" ? "Back" : "Front"}</span>
              <span>{candidate.setCode ? `${candidate.setCode.toUpperCase()} #${candidate.collectorNumber ?? "?"}` : "Set/collector não informados"} · {candidate.language ? candidate.language.toUpperCase() : "idioma não informado"}</span>
              {candidate.source === "mpc" && <span>Source: {mpcSourceName ?? "não informada"} · Formato: {format ?? "não informado"} · Tamanho: {size === undefined ? "não informado" : `${Math.ceil(size / 1024)} KB`}</span>}
              {candidate.source !== "mpc" && <span>Formato: {format ?? "não informado"}{size === undefined ? "" : ` · ${Math.ceil(size / 1024)} KB`}</span>}
              <span>{candidate.widthPx && candidate.heightPx ? `${candidate.widthPx} × ${candidate.heightPx} px` : "Dimensões não validadas"} · {qualityLine(candidate, checking)}</span>
              {candidate.releasedAt && <span>Release: {candidate.releasedAt}</span>}
              {typeof candidate.metadata?.fullArt === "boolean" && <span>Full-art: {candidate.metadata.fullArt ? "sim" : "não"}</span>}
              <span>{candidate.originalAvailable ? "Original disponível" : "Original indisponível"} · {candidate.originalCached ? "cache local validado" : "sem cache local"}</span>
              {tags.length > 0 && <span>Tags: {tags.join(", ")}</span>}
              {candidate.source === "mpc" && typeof candidate.metadata?.remoteMetadataStatus === "string" && <span className="reference-status">Validação da metadata MPC: {candidate.metadata.remoteMetadataStatus === "current" ? "atual" : candidate.metadata.remoteMetadataStatus === "removed" ? "removida no provider" : candidate.metadata.remoteMetadataStatus === "stale" ? "desatualizada" : candidate.metadata.remoteMetadataStatus}</span>}
              {typeof candidate.metadata?.imageStatus === "string" && <span className="reference-status">Validação da imagem no provider: {candidate.metadata.imageStatus}</span>}
              {candidate.source === "mpc" && typeof candidate.metadata?.metadataFreshness === "string" && <span className="reference-status">Atualidade da metadata: {candidate.metadata.metadataFreshness === "fresh" ? "atual" : candidate.metadata.metadataFreshness === "stale" ? "cache desatualizado" : candidate.metadata.metadataFreshness === "revalidated" ? "revalidada" : candidate.metadata.metadataFreshness}</span>}
              {candidate.source === "mpc" && candidate.metadata?.localAvailabilityHint === true && !candidate.originalCached && <span className="reference-status">XML informa disponibilidade local; bytes ainda não verificados no cache</span>}
            </div>
          </details>
          <div className="candidate-actions">
            {candidate.source === "mpc" && onRevalidate && <button className="button secondary" type="button" disabled={disabled} onClick={() => onRevalidate(candidate)}>Revalidar metadata</button>}
            <button className={`button ${isSelected ? "primary" : "secondary"}`} type="button" disabled={disabled} onClick={() => onSelect(candidate)}>
              {isSelected && candidate.originalAvailable && !candidate.effectiveDpi ? "Validar original e calcular DPI" : isSelected ? "Selecionada" : candidate.originalAvailable ? "Selecionar arte" : "Selecionar referência"}
            </button>
          </div>
        </article>;
      })}
    </div>
    {!paginated && hasMore && <button className="button secondary artwork-load-more" type="button" onClick={onLoadMore}>
      Carregar mais artes ({candidates.length - visibleCandidates.length} restantes)
    </button>}
  </>;
}
