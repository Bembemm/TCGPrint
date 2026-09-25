"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import type { ImportKind } from "../../import-engine/types";
import type { ArtworkCandidate, CardFaceSide, CardIdentity, WorkingCard } from "../../core/cards/types";
import { formatResolutionSummary } from "../../core/cards/resolution-summary";
import { postArtworkSelection } from "./artwork-selection-request";

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

export default function CardIdentityWorkbench({ files, text, choices }: Props) {
  const [workingCards, setWorkingCards] = useState<WorkingCard[]>([]);
  const [selectedCardId, setSelectedCardId] = useState("");
  const [artworkCandidates, setArtworkCandidates] = useState<CandidateDto[]>([]);
  const [artworkFilter, setArtworkFilter] = useState<ArtworkFilter>("all");
  const [face, setFace] = useState<CardFaceSide>("front");
  const [manualQuery, setManualQuery] = useState("");
  const [autocompleteNames, setAutocompleteNames] = useState<string[]>([]);
  const [manualIdentities, setManualIdentities] = useState<CardIdentity[]>([]);
  const [bleedMm, setBleedMm] = useState("0.625");
  const [cutGuides, setCutGuides] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const [artworkProblem, setArtworkProblem] = useState("");
  const [providerHealth, setProviderHealth] = useState<Record<string, { available: boolean; degraded: boolean; message?: string }>>({});
  const [identityDetails, setIdentityDetails] = useState<IdentityDetails | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");

  const activeCard = useMemo(() => workingCards.find((card) => card.id === selectedCardId), [workingCards, selectedCardId]);
  const filterCards = useMemo(() => artworkCandidates.filter((candidate) => artworkFilter === "all" || candidate.source === artworkFilter), [artworkCandidates, artworkFilter]);
  const activeFaceExists = Boolean(activeCard?.faces.some((item) => item.side === face));

  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  useEffect(() => {
    if (manualQuery.trim().length < 2) { setAutocompleteNames([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/cards/autocomplete?q=${encodeURIComponent(manualQuery.trim())}`, { signal: controller.signal });
        const result = await jsonResponse<{ names: string[] }>(response);
        setAutocompleteNames(result.names.slice(0, 8));
      } catch (error) {
        if (!controller.signal.aborted) setAutocompleteNames([]);
      }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [manualQuery]);

  useEffect(() => {
    if (!activeCard || !activeFaceExists) { setArtworkCandidates([]); return; }
    const controller = new AbortController();
    const identityId = activeCard.identity?.id ?? "custom:artwork-picker";
    void fetch(`/api/cards/${encodeURIComponent(identityId)}/artworks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ faceId: face, source: artworkFilter, mpcReferences: activeCard.mpcReferences }),
    }).then((response) => jsonResponse<{ candidates: CandidateDto[]; providerHealth: typeof providerHealth }>(response))
      .then((result) => {
        setArtworkCandidates(result.candidates);
        setProviderHealth((current) => ({ ...current, ...result.providerHealth }));
        setArtworkProblem("");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setArtworkCandidates([]);
          setArtworkProblem(error instanceof Error ? error.message : "Não foi possível abrir o catálogo de artes.");
        }
      });
    return () => controller.abort();
  }, [activeCard, activeFaceExists, face, artworkFilter]);

  useEffect(() => {
    if (!activeCard?.identity) { setIdentityDetails(null); return; }
    const controller = new AbortController();
    void fetch(`/api/cards/${encodeURIComponent(activeCard.identity.id)}`, { signal: controller.signal })
      .then((response) => jsonResponse<{ identity: IdentityDetails }>(response))
      .then((result) => setIdentityDetails(result.identity))
      .catch(() => { if (!controller.signal.aborted) setIdentityDetails(null); });
    return () => controller.abort();
  }, [activeCard?.identity?.id]);

  function replaceCard(cardId: string, next: WorkingCard) {
    setWorkingCards((current) => current.map((card) => card.id === cardId ? next : card));
  }

  async function importToWorkingSet() {
    if (!files.length && !text.trim()) { setProblem("Adicione arquivos ou cole uma decklist antes de importar."); return; }
    setBusy(true); setProblem(""); setStatus("Universal Import → Working Set…"); setPdfUrl("");
    try {
      const form = new FormData();
      files.forEach((file) => form.append("files", file, file.name));
      form.set("filePaths", JSON.stringify(files.map((file) => file.webkitRelativePath || "")));
      if (text.trim()) form.set("text", text);
      form.set("selections", JSON.stringify(choices));
      const response = await fetch("/api/cards/import", { method: "POST", body: form });
      const result = await jsonResponse<{ workingCards: WorkingCard[]; providerHealth: typeof providerHealth }>(response);
      setWorkingCards(result.workingCards);
      setSelectedCardId(result.workingCards[0]?.id ?? "");
      setArtworkFilter("all"); setFace("front"); setManualIdentities([]);
      setProviderHealth(result.providerHealth);
      setStatus(`${result.workingCards.length} entradas no Working Set. Quantidades permanecem compactas.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Não foi possível importar para o Working Set."); setStatus("");
    } finally { setBusy(false); }
  }

  async function resolveAll() {
    if (!workingCards.length) return;
    setBusy(true); setProblem(""); setStatus("Resolvendo identidades pelo Scryfall…");
    try {
      const response = await fetch("/api/cards/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resolve", cards: workingCards }) });
      const result = await jsonResponse<{ workingCards: WorkingCard[]; providerHealth: typeof providerHealth }>(response);
      setWorkingCards(result.workingCards); setProviderHealth(result.providerHealth);
      setStatus(formatResolutionSummary(result.workingCards, result.providerHealth));
    } catch (error) { setProblem(error instanceof Error ? error.message : "A resolução falhou."); setStatus(""); }
    finally { setBusy(false); }
  }

  async function confirmIdentity(card: WorkingCard, identity: CardIdentity) {
    if (!identity.scryfallId) { setProblem("A identidade escolhida não tem Scryfall ID."); return; }
    setBusy(true); setProblem("");
    try {
      const response = await fetch("/api/cards/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm", card, scryfallId: identity.scryfallId }) });
      const result = await jsonResponse<{ workingCards: WorkingCard[]; providerHealth: typeof providerHealth }>(response);
      replaceCard(card.id, result.workingCards[0]); setProviderHealth(result.providerHealth);
      setManualIdentities([]); setStatus(`${identity.name} confirmada.`);
    } catch (error) { setProblem(error instanceof Error ? error.message : "Não foi possível confirmar a identidade."); }
    finally { setBusy(false); }
  }

  async function keepCustom(card: WorkingCard) {
    setBusy(true); setProblem("");
    try {
      const response = await fetch("/api/cards/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "custom", cards: [card] }) });
      const result = await jsonResponse<{ workingCards: WorkingCard[] }>(response);
      replaceCard(card.id, result.workingCards[0]); setStatus(`${displayCard(card)} mantida como custom.`);
    } catch (error) { setProblem(error instanceof Error ? error.message : "Não foi possível manter como custom."); }
    finally { setBusy(false); }
  }

  async function searchIdentities(query = manualQuery) {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setBusy(true); setProblem("");
    try {
      const response = await fetch(`/api/cards/search?q=${encodeURIComponent(trimmed)}`);
      const result = await jsonResponse<{ identities: CardIdentity[] }>(response);
      setManualIdentities(result.identities);
      if (!result.identities.length) setProblem("Nenhuma carta encontrada para essa busca.");
    } catch (error) { setProblem(error instanceof Error ? error.message : "Busca manual falhou."); }
    finally { setBusy(false); }
  }

  async function chooseArtwork(candidate: CandidateDto) {
    if (!activeCard) return;
    setBusy(true); setArtworkProblem(""); setProblem("");
    try {
      if (candidate.originalAvailable) {
        const prepareResponse = await fetch(`/api/cards/artworks/${encodeURIComponent(candidate.id)}/prepare`, { method: "POST" });
        const prepared = await jsonResponse<{ candidate: CandidateDto }>(prepareResponse);
        setArtworkCandidates((current) => current.map((item) => item.id === candidate.id ? prepared.candidate : item));
      }
      const response = await postArtworkSelection(activeCard, face, candidate.id);
      const result = await jsonResponse<{ workingCards: WorkingCard[] }>(response);
      replaceCard(activeCard.id, result.workingCards[0]);
      setStatus(candidate.originalAvailable ? "Artwork selecionado; original validado e armazenado no cache." : "Referência MPC selecionada; nenhum original local está disponível.");
    } catch (error) { setArtworkProblem(error instanceof Error ? error.message : "Não foi possível selecionar essa arte."); }
    finally { setBusy(false); }
  }

  async function exportPdf() {
    if (!workingCards.length) return;
    setBusy(true); setProblem(""); setStatus("Compondo quantidade física e gerando PDF A4…");
    try {
      const response = await fetch("/api/cards/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: workingCards, options: { bleedMm: Number(bleedMm), cutGuides: cutGuides ? "full" : "none" } }),
      });
      if (!response.ok) {
        const body = await response.json() as ApiErrorBody;
        throw new Error(body.message ?? "Não foi possível gerar o PDF.");
      }
      const nextUrl = URL.createObjectURL(await response.blob());
      setPdfUrl(nextUrl); setStatus("PDF pronto · A4 · trim 63,5 × 88,9 mm · bleed externo · guias vetoriais.");
    } catch (error) { setProblem(error instanceof Error ? error.message : "Export falhou."); setStatus(""); }
    finally { setBusy(false); }
  }

  const selected = activeCard ? selectedFor(activeCard, face) : undefined;

  return (
    <section className="panel card-identity-workbench" aria-labelledby="identity-workbench-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Fase 5 · Working Set da sessão</p>
          <h2 id="identity-workbench-heading">Identidade da carta e artwork</h2>
          <p>CardIdentity permanece estável enquanto a arte pode ser trocada por face. Nenhum projeto é salvo.</p>
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
        <span className="status" aria-live="polite">{status}</span>
      </div>
      {problem && <p className="error-message" role="alert">{problem}</p>}

      {workingCards.length > 0 && <div className="card-workbench-layout">
        <div className="working-card-list" aria-label="Working cards da sessão">
          <div className="compact-heading"><strong>{workingCards.length} WorkingCard(s)</strong><span>quantidade compacta</span></div>
          {workingCards.slice().sort((a, b) => a.order - b.order).map((card) => (
            <button key={card.id} type="button" className={`working-card-row ${card.id === selectedCardId ? "is-active" : ""}`} onClick={() => { setSelectedCardId(card.id); setFace("front"); }}>
              <span className="working-card-name">{displayCard(card)}</span>
              <span className="working-card-meta">×{card.quantity} · {card.section ?? "sem seção"}</span>
              <span className={`resolution-status status-${card.identityResolution.status}`}>{statusLabel(card)}</span>
              <span className="working-card-meta">Front: {card.selectedArtworkByFace.front ? labelSource(card.selectedArtworkByFace.front.source) : "sem arte"}</span>
            </button>
          ))}
        </div>

        {activeCard && <div className="working-card-detail">
          <div className="compact-heading detail-title">
            <div><strong>{displayCard(activeCard)}</strong><span>{activeCard.quantity} cópia(s) físicas · entrada {activeCard.order + 1}</span></div>
            {activeCard.faces.length > 1 && <span className="multiface-label">DFC / multiface · carta dupla-face</span>}
          </div>

          <div className="identity-summary">
            <span className={`resolution-status status-${activeCard.identityResolution.status}`}>{statusLabel(activeCard)}</span>
            {activeCard.identity && <span>CardIdentity · {activeCard.identity.name} · {activeCard.identity.provider} · {activeCard.identity.resolutionMethod}{identityDetails?.layout ? ` · layout ${identityDetails.layout}` : ""}</span>}
            {activeCard.identity?.setCode && <span>{activeCard.identity.setCode.toUpperCase()} #{activeCard.identity.collectorNumber}</span>}
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
              <input id="manual-card-search" value={manualQuery} onChange={(event) => setManualQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchIdentities(); }} placeholder="Nome da carta" />
              <button className="button secondary" type="button" disabled={busy || manualQuery.trim().length < 2} onClick={() => void searchIdentities()}>Buscar</button>
            </div>
            {autocompleteNames.length > 0 && <div className="autocomplete-list" role="listbox" aria-label="Autocompletar carta">
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
            {activeCard.faces.map((item) => <button key={item.side} type="button" className={`button ${face === item.side ? "primary" : "secondary"}`} onClick={() => setFace(item.side)}>{item.side === "front" ? "Front" : "Back"}{item.name ? ` · ${item.name}` : ""}</button>)}
          </div>}

          <div className="artwork-section">
            <div className="compact-heading"><div><strong>Artwork Picker · {face === "front" ? "Front" : "Back"}</strong><span>Seleção atual é preservada durante a atualização do catálogo.</span></div></div>
            <div className="artwork-filter-row" role="group" aria-label="Filtrar origem das artes">
              {([ ["all", "Todas"], ["scryfall", "Scryfall"], ["mpc", "MPC Autofill"], ["upload", "Meus uploads"] ] as const).map(([value, label]) => <button key={value} type="button" className={`button ${artworkFilter === value ? "primary" : "secondary"}`} onClick={() => setArtworkFilter(value)}>{label}</button>)}
            </div>
            {selected && <p className="selected-artwork-line">Selecionada: {labelSource(selected.source)} · {selected.candidateId}{selected.selectionPolicy && selected.selectionPolicy !== "user-selected" ? " · política default" : ""}</p>}
            {artworkProblem && <p className="error-message" role="alert">{artworkProblem}</p>}
            {filterCards.length === 0 && !artworkProblem && <p className="muted">Nenhuma arte disponível neste filtro. Referências MPC não possuem original se não foram importadas localmente.</p>}
            <div className="artwork-grid">
              {filterCards.map((candidate) => {
                const isSelected = selected?.candidateId === candidate.id;
                return <article className={`artwork-candidate ${isSelected ? "is-selected" : ""}`} key={candidate.id}>
                  {candidate.previewUri ? <Image src={candidate.previewUri} alt={`${displayCard(activeCard)} · ${candidate.setCode ?? labelSource(candidate.source)} ${candidate.collectorNumber ?? ""}`} width={300} height={420} unoptimized /> : <div className="artwork-reference-thumb">{candidate.source === "mpc" ? "MPC reference" : "Preview indisponível"}</div>}
                  <div className="candidate-meta">
                    <strong>{candidate.faceName ?? candidate.metadata?.originalFilename as string ?? labelSource(candidate.source)}</strong>
                    <span>{labelSource(candidate.source)}{candidate.setCode ? ` · ${candidate.setCode.toUpperCase()} #${candidate.collectorNumber ?? "?"}` : ""}</span>
                    <span>{candidate.language ? candidate.language.toUpperCase() : "idioma não informado"}{candidate.effectiveDpi ? ` · ${candidate.effectiveDpi} DPI · ${resolutionQualityLabel(candidate.resolutionQuality)}` : " · DPI será calculado ao validar o original"}</span>
                    {candidate.source === "mpc" && <span className="reference-status">{candidate.originalAvailable ? "bytes locais disponíveis" : "referência sem original local"}</span>}
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
          <label className="checkbox-field"><input type="checkbox" checked={cutGuides} onChange={(event) => setCutGuides(event.currentTarget.checked)} /> Guias vetoriais</label>
          <button className="button primary" type="button" disabled={busy || !workingCards.every((card) => Boolean(card.selectedArtworkByFace.front))} onClick={() => void exportPdf()}>Gerar PDF real</button>
          {pdfUrl && <a className="download-link" href={pdfUrl} download="tcgprint-cards.pdf">Baixar PDF</a>}
        </div>
        <p className="muted">O trim e os guias são posicionados pelos engines atuais. Back fica associado por face para uma fase futura; esta exportação imprime a face front.</p>
      </div>}
    </section>
  );
}
