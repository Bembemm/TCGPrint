"use client";

import { useState } from "react";
import type { BackLibraryAssetReference, WorkingCard, WorkingCardBackMode } from "../../core/cards/types";
import { isDoubleFacedIdentity } from "../../core/cards/back-selection";

export interface BackLibraryAssetDto extends BackLibraryAssetReference {
  readonly name: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly retired: boolean;
  readonly selectable?: boolean;
}

export function backLibraryAssetReference(asset: BackLibraryAssetDto): BackLibraryAssetReference {
  return { assetId: asset.assetId, sha256: asset.sha256, format: asset.format };
}

interface BackLibraryControlsProps {
  readonly assets: readonly BackLibraryAssetDto[];
  readonly selectedDefault: BackLibraryAssetReference | null;
  readonly selectedCard: WorkingCard | null;
  readonly disabled: boolean;
  readonly onAssetsChange: (assets: readonly BackLibraryAssetDto[]) => void;
  readonly onDefaultChange: (asset: BackLibraryAssetReference | null) => void;
  readonly onCardModeChange: (mode: WorkingCardBackMode) => void;
  readonly onManualBackChange: (asset: BackLibraryAssetReference) => void;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(`Resposta inesperada da Back Library (HTTP ${response.status}).`); }
  const object = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (!response.ok) throw new Error(typeof object.message === "string" ? object.message : `Back Library retornou HTTP ${response.status}.`);
  return object;
}

export default function BackLibraryControls({ assets, selectedDefault, selectedCard, disabled, onAssetsChange, onDefaultChange, onCardModeChange, onManualBackChange }: BackLibraryControlsProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const selectedCardBack = selectedCard?.manualBackAsset ?? null;
  const activeAssets = assets.filter((asset) => asset.selectable !== false && !asset.retired);
  const assetForValue = (value: string) => assets.find(({ assetId }) => assetId === value);
  const choicesFor = (selected: BackLibraryAssetReference | null) => {
    const referencedRetired = selected && assets.find((asset) => asset.retired && asset.assetId === selected.assetId && asset.sha256 === selected.sha256);
    return referencedRetired ? [...activeAssets, referencedRetired] : activeAssets;
  };
  const defaultChoices = choicesFor(selectedDefault);
  const manualChoices = choicesFor(selectedCardBack);

  async function reload() {
    const result = await responseJson(await fetch("/api/back-library", { cache: "no-store" }));
    onAssetsChange(Array.isArray(result.assets) ? result.assets as BackLibraryAssetDto[] : []);
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true); setProblem(""); setStatus("Validando e armazenando original imutável…");
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      await responseJson(await fetch("/api/back-library", { method: "POST", body: form }));
      await reload();
      setStatus(`${file.name} adicionado à Back Library.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Não foi possível adicionar o verso."); setStatus("");
    } finally { setBusy(false); }
  }

  async function retire(asset: BackLibraryAssetDto) {
    setBusy(true); setProblem(""); setStatus("");
    try {
      await responseJson(await fetch(`/api/back-library/${encodeURIComponent(asset.assetId)}`, { method: "DELETE" }));
      await reload();
      setStatus(`${asset.name} arquivado. Projects que guardam este assetId e SHA-256 continuam podendo exportar.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Não foi possível arquivar o verso.");
    } finally { setBusy(false); }
  }

  return <section className="back-library-controls" aria-label="Back Library e seleção de verso">
    <h4>Versos do Project</h4>
    <label>Verso padrão do Project
      <select aria-label="Verso padrão do Project" value={selectedDefault?.assetId ?? ""} disabled={disabled || busy} onChange={(event) => {
        const asset = assetForValue(event.currentTarget.value);
        if (!asset || (asset.selectable !== false && !asset.retired) || asset.assetId === selectedDefault?.assetId) onDefaultChange(asset ? backLibraryAssetReference(asset) : null);
      }}>
        <option value="">Nenhum verso padrão</option>
        {defaultChoices.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.name} · {asset.format.toUpperCase()} · {asset.sha256.slice(0, 12)}{asset.retired ? " · arquivado (imutável)" : ""}</option>)}
      </select>
    </label>
    <label>Adicionar verso (JPEG ou PNG)
      <input aria-label="Adicionar verso à Back Library" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" disabled={disabled || busy} onChange={(event) => { void upload(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
    </label>
    <p className="muted">Os originais são validados por bytes, guardados sem recompressão e endereçados por SHA-256. Arquivar esconde o asset da lista ativa, mantendo seu ID e bytes resolvíveis por Projects existentes.</p>
    {assets.length > 0 && <ul className="back-library-list" aria-label="Back Library assets">
      {assets.map((asset) => <li key={asset.assetId}>
        <span><strong>{asset.name}</strong> · {asset.widthPx} × {asset.heightPx} · {asset.format.toUpperCase()} · SHA-256 <code>{asset.sha256.slice(0, 16)}</code>{asset.retired ? " · arquivado" : ""}</span>
        {!asset.retired && <button className="button secondary" type="button" disabled={disabled || busy} onClick={() => void retire(asset)}>Arquivar</button>}
      </li>)}
    </ul>}

    {selectedCard && isDoubleFacedIdentity(selectedCard.identity) && <p className="muted">Esta carta usa sua face traseira DFC como verso físico. O verso padrão e a Back Library não substituem essa face.</p>}
    {selectedCard && !isDoubleFacedIdentity(selectedCard.identity) && <div className="card-back-controls" aria-label={`Verso de ${selectedCard.identity?.name ?? selectedCard.identityHints.name ?? "carta selecionada"}`}>
      <label>Modo de verso da carta
        <select aria-label="Modo de verso da carta" value={selectedCard.backMode} disabled={disabled || busy} onChange={(event) => onCardModeChange(event.currentTarget.value as WorkingCardBackMode)}>
          <option value="auto">Auto · face traseira DFC</option>
          <option value="project-default">Verso padrão do Project</option>
          <option value="manual" disabled={!selectedCard.manualBackAsset && !selectedCard.manualBackArtwork && !selectedCard.selectedArtworkByFace.back}>Manual · verso escolhido</option>
          <option value="none">Sem verso · slot traseiro em branco</option>
        </select>
      </label>
      <label>Verso manual da Back Library
        <select aria-label="Verso manual da Back Library" value={selectedCardBack?.assetId ?? ""} disabled={disabled || busy} onChange={(event) => {
          const asset = assetForValue(event.currentTarget.value);
          if (asset && ((asset.selectable !== false && !asset.retired) || asset.assetId === selectedCardBack?.assetId)) onManualBackChange(backLibraryAssetReference(asset));
        }}>
          <option value="">Usar face traseira / nenhum asset manual</option>
          {manualChoices.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.name} · {asset.sha256.slice(0, 12)}{asset.retired ? " · arquivado" : ""}</option>)}
        </select>
      </label>
      {selectedCard.backMode === "manual" && <p className="muted">Override manual bloqueado contra re-resolução automática; restaurar Auto é uma ação explícita.</p>}
    </div>}
    {problem && <p className="error-message" role="alert">{problem}</p>}
    <p className="status" aria-live="polite">{status}</p>
  </section>;
}
