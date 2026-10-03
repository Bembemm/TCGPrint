import Image from "next/image";
import type { ArtworkCandidate } from "../../core/cards/types";

export const ARTWORK_WINDOW_SIZE = 60;

export type ArtworkQualityStatus = "verified" | "provider-reported" | "checking" | "unknown" | "unavailable";

export type ArtworkCandidateView = Omit<ArtworkCandidate, "originalUri" | "localOriginalPath"> & {
  readonly resolutionQuality?: "excellent" | "good" | "warning" | "low" | "unknown";
  readonly qualityStatus?: ArtworkQualityStatus;
};

export function sliceArtworkWindow<T>(items: readonly T[], limit: number): readonly T[] {
  return items.slice(0, Math.max(0, limit));
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
  if (candidate.effectiveDpi !== undefined && candidate.effectiveDpi > 0) {
    return `${candidate.effectiveDpi} DPI efetivo · verificado ✓ · ${resolutionLabel(candidate.resolutionQuality)}`;
  }
  if (!candidate.originalAvailable || candidate.qualityStatus === "unavailable") return "DPI efetivo · original indisponível";
  if (checking || candidate.qualityStatus === "checking") return "DPI efetivo · verificando…";
  if (candidate.source === "mpc" && typeof candidate.metadata?.dpi === "number") {
    return `${candidate.metadata.dpi} DPI · informado pelo MPC · DPI efetivo · desconhecido`;
  }
  return "DPI efetivo · desconhecido";
}

export interface ArtworkCandidateGridProps {
  readonly candidates: readonly ArtworkCandidateView[];
  readonly windowLimit: number;
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
  const visibleCandidates = sliceArtworkWindow(candidates, windowLimit);
  const hasMore = visibleCandidates.length < candidates.length;

  return <>
    <p className="artwork-catalog-count" aria-live="polite">
      {catalogLabel} · {catalogTotal} artworks{catalogTotalComplete ? "" : " conhecidas · catálogo parcial"}
      <span> · {visibleCandidates.length} de {catalogTotal} exibidas · {filterTotal} de {catalogTotal}{catalogTotalComplete ? "" : " conhecidas"} correspondem ao filtro</span>
    </p>
    <div className="artwork-grid">
      {visibleCandidates.map((candidate) => {
        const isSelected = selectedCandidateId === candidate.id;
        const mpcSourceName = typeof candidate.metadata?.sourceName === "string" ? candidate.metadata.sourceName : undefined;
        const format = typeof candidate.metadata?.originalFormat === "string"
          ? candidate.metadata.originalFormat.toUpperCase()
          : typeof candidate.metadata?.extension === "string" ? candidate.metadata.extension.toUpperCase() : undefined;
        const size = typeof candidate.metadata?.declaredSize === "number" ? candidate.metadata.declaredSize
          : typeof candidate.metadata?.byteLength === "number" ? candidate.metadata.byteLength : undefined;
        const tags = Array.isArray(candidate.metadata?.tags) ? candidate.metadata.tags.filter((tag): tag is string => typeof tag === "string") : [];
        const checking = qualityCheckingIds.has(candidate.id);

        return <article className={`artwork-candidate ${isSelected ? "is-selected" : ""}`} key={candidate.id}>
          {candidate.previewUri
            ? <Image src={candidate.previewUri} alt={`${cardName} · ${candidate.setCode ?? sourceLabel(candidate.source)} ${candidate.collectorNumber ?? ""}`} width={300} height={420} unoptimized loading="lazy" />
            : <div className="artwork-reference-thumb">{candidate.source === "mpc" ? "MPC reference" : "Preview indisponível"}</div>}
          <div className="candidate-meta">
            <strong>{candidate.faceName ?? candidate.metadata?.name as string ?? candidate.metadata?.originalFilename as string ?? sourceLabel(candidate.source)}</strong>
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
            {candidate.source === "mpc" && typeof candidate.metadata?.metadataFreshness === "string" && <span className="reference-status">Atualidade da metadata: {candidate.metadata.metadataFreshness === "fresh" ? "atual" : candidate.metadata.metadataFreshness === "stale" ? "cache desatualizado" : candidate.metadata.metadataFreshness === "revalidated" ? "revalidada" : candidate.metadata.metadataFreshness}</span>}
            {candidate.source === "mpc" && candidate.metadata?.localAvailabilityHint === true && !candidate.originalCached && <span className="reference-status">XML informa disponibilidade local; bytes ainda não verificados no cache</span>}
          </div>
          {candidate.source === "mpc" && onRevalidate && <button className="button secondary" type="button" disabled={disabled} onClick={() => onRevalidate(candidate)}>Revalidar metadata</button>}
          <button className={`button ${isSelected ? "primary" : "secondary"}`} type="button" disabled={disabled} onClick={() => onSelect(candidate)}>
            {isSelected && candidate.originalAvailable && !candidate.effectiveDpi ? "Validar original e calcular DPI" : isSelected ? "Selecionada" : candidate.originalAvailable ? "Selecionar arte" : "Selecionar referência"}
          </button>
        </article>;
      })}
    </div>
    {hasMore && <button className="button secondary artwork-load-more" type="button" onClick={onLoadMore}>
      Carregar mais artes ({candidates.length - visibleCandidates.length} restantes)
    </button>}
  </>;
}
