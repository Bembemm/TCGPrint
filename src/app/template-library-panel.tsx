"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { TemplateRecord, TemplateVersionRecord } from "../../persistence/templates/repository";
import type { TemplateSelection } from "../../templates/types";
import type { CutSourceSelection, DxfUnitsOverride } from "../../core/cut";
import type { TemplateSelectionInspection } from "../../services/template-library";
import {
  registrationDefaultsForTemplate,
  resolveTemplateRegistrationStatus,
  templateRegistrationLabel,
  type TemplateRegistrationDefaults,
  type TemplateRegistrationStatus,
} from "./template-registration-compat";

export type { TemplateRegistrationDefaults } from "./template-registration-compat";

interface TemplateLibraryPanelProps {
  readonly selection: TemplateSelection | null;
  readonly cutSourceSelection: CutSourceSelection | null;
  readonly onCutSourceSelect?: (selection: CutSourceSelection | null) => void;
  readonly onSelect: (selection: TemplateSelection | null, defaults?: TemplateRegistrationDefaults) => void;
  readonly onRegistrationStatusChange?: (status: TemplateRegistrationStatus) => void;
  readonly disabled?: boolean;
}

interface ApiErrorBody { readonly message?: string; }

const DEFAULT_METADATA = {
  name: "", source: "Local", version: "1", paper: "a4", cardFormat: "standard",
  orientation: "portrait", recommendedBleedMm: "", registrationType: "none",
  registrationConfigJson: "", templateGeometryJson: "",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "A operação de template falhou.";
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as unknown;
  if (!response.ok) {
    const details = body && typeof body === "object" ? body as ApiErrorBody : {};
    throw new Error(details.message ?? "A operação de template falhou.");
  }
  return body as T;
}

function selectedVersion(selection: TemplateSelection | null, template: TemplateRecord, version: TemplateVersionRecord): boolean {
  return selection?.templateId === template.id && selection.version === version.version && selection.packageHash === version.packageHash;
}

function integrityLabel(status: TemplateSelectionInspection["status"]): string {
  switch (status) {
    case "available": return "Originais íntegros";
    case "missing": return "Arquivo associado ausente";
    case "corrupt": return "Arquivo associado corrompido";
    case "hash-mismatch": return "Hash da versão não confere";
  }
}

export default function TemplateLibraryPanel({ selection, cutSourceSelection, onCutSourceSelect, onSelect, onRegistrationStatusChange, disabled = false }: TemplateLibraryPanelProps) {
  const [templates, setTemplates] = useState<readonly TemplateRecord[]>([]);
  const [metadata, setMetadata] = useState(DEFAULT_METADATA);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<TemplateSelectionInspection | null>(null);

  const refresh = useCallback(async () => {
    const result = await responseJson<{ templates: TemplateRecord[] }>(await fetch("/api/templates", { cache: "no-store" }));
    setTemplates(result.templates);
  }, []);

  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(errorText(reason)));
  }, [refresh]);

  useEffect(() => {
    if (!selection) {
      setInspection(null);
      return;
    }
    let active = true;
    setInspection(null);
    void fetch(
      `/api/templates/${encodeURIComponent(selection.templateId)}/versions/${encodeURIComponent(selection.version)}/verify?hash=${encodeURIComponent(selection.packageHash)}`,
      { cache: "no-store" },
    ).then((response) => responseJson<TemplateSelectionInspection>(response)).then((result) => {
      if (active) setInspection(result);
    }).catch((reason: unknown) => {
      if (active) setInspection({ selection, status: "missing", version: null, files: [] });
      if (active) setError(errorText(reason));
    });
    return () => { active = false; };
  }, [selection?.templateId, selection?.version, selection?.packageHash]);

  const selectedId = useMemo(() => selection ? `${selection.templateId}:${selection.version}` : "", [selection]);
  const registrationStatus = resolveTemplateRegistrationStatus(selection, inspection);
  const cutFiles = inspection?.files.filter((file) => file.extension === "svg" || file.extension === "dxf") ?? [];
  const selectedCutFile = cutFiles.find((file) => file.fileId === cutSourceSelection?.fileId);

  useEffect(() => {
    onRegistrationStatusChange?.(registrationStatus);
  }, [onRegistrationStatusChange, registrationStatus]);

  async function importTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled) return;
    const formElement = event.currentTarget;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      const bleed = metadata.recommendedBleedMm.trim();
      form.set("metadata", JSON.stringify({
        name: metadata.name,
        source: metadata.source,
        version: metadata.version,
        paper: metadata.paper,
        cardFormat: metadata.cardFormat,
        orientation: metadata.orientation,
        ...(bleed ? { recommendedBleedMm: Number(bleed) } : {}),
        registrationType: metadata.registrationType,
        ...(metadata.registrationConfigJson.trim() ? { registrationConfig: JSON.parse(metadata.registrationConfigJson) as unknown } : {}),
        ...(metadata.templateGeometryJson.trim() ? { templateGeometry: JSON.parse(metadata.templateGeometryJson) as unknown } : {}),
      }));
      if (selectedTemplateId) form.set("templateId", selectedTemplateId);
      for (const file of files) form.append("files", file, file.name);
      await responseJson<unknown>(await fetch("/api/templates", { method: "POST", body: form }));
      await refresh();
      setFiles([]);
      formElement.reset();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate(template: TemplateRecord) {
    if (busy || disabled || !window.confirm(`Remover “${template.name}” da biblioteca? Os originais permanecem armazenados.`)) return;
    setBusy(true);
    setError(null);
    try {
      await responseJson(await fetch(`/api/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" }));
      if (selection?.templateId === template.id) onSelect(null);
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="template-library" aria-label="Template Library">
      <div className="template-library-heading">
        <div>
          <h3>Silhouette Template Library</h3>
          <p>Arquivos originais imutáveis · SHA-256 · seleção vinculada à versão do Project.</p>
        </div>
        {selection && <button className="button secondary" type="button" disabled={disabled || busy} onClick={() => onSelect(null)}>Desassociar</button>}
      </div>

      <form className="template-import-form" onSubmit={(event) => void importTemplate(event)}>
        <div className="template-form-grid">
          <label>Nome<input required maxLength={160} value={metadata.name} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, name: event.currentTarget.value })} /></label>
          <label>Origem<input required maxLength={240} value={metadata.source} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, source: event.currentTarget.value })} /></label>
          <label>Versão<input required maxLength={80} value={metadata.version} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, version: event.currentTarget.value })} /></label>
          <label>Template existente<select value={selectedTemplateId} disabled={disabled || busy} onChange={(event) => {
            const value = event.currentTarget.value;
            setSelectedTemplateId(value);
            const existing = templates.find(({ id }) => id === value);
            if (existing) setMetadata((current) => ({ ...current, name: existing.name, source: existing.source }));
          }}>
            <option value="">Novo template</option>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.source}</option>)}
          </select></label>
          <label>Papel<select value={metadata.paper} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, paper: event.currentTarget.value })}>
            <option value="a4">A4</option><option value="a3">A3</option><option value="letter">Letter</option><option value="legal">Legal</option><option value="tabloid">Tabloid</option><option value="custom">Custom</option>
          </select></label>
          <label>Formato de carta<select value={metadata.cardFormat} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, cardFormat: event.currentTarget.value })}>
            <option value="standard">Standard</option><option value="poker">Poker</option><option value="bridge">Bridge</option><option value="tarot">Tarot</option><option value="custom">Custom</option>
          </select></label>
          <label>Orientação<select value={metadata.orientation} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, orientation: event.currentTarget.value })}>
            <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
          </select></label>
          <label>Bleed recomendado (mm)<input type="number" min="0" max="3" step="0.001" value={metadata.recommendedBleedMm} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, recommendedBleedMm: event.currentTarget.value })} /></label>
          <label>Registration type<select value={metadata.registrationType} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, registrationType: event.currentTarget.value })}>
            <option value="none">None</option><option value="three-point">Three-point</option><option value="four-point">Four-point</option><option value="custom">Custom</option>
          </select></label>
        </div>
        <label>Registration geometry JSON (mm; opcional para 3/4 pontos, obrigatório para custom)
          <textarea rows={4} maxLength={65_536} value={metadata.registrationConfigJson} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, registrationConfigJson: event.currentTarget.value })} />
        </label>
        <label>Template layout geometry JSON (mm; posições exatas dos slots, opcional)
          <textarea rows={5} maxLength={131_072} value={metadata.templateGeometryJson} disabled={disabled || busy} onChange={(event) => setMetadata({ ...metadata, templateGeometryJson: event.currentTarget.value })} />
        </label>
        <label className="template-files-field">Arquivos associados (.studio3, .dxf, .svg, .json, .zip)
          <input type="file" multiple accept=".studio3,.dxf,.svg,.json,.zip" disabled={disabled || busy} onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))} />
        </label>
        <div className="template-import-actions">
          <span>{files.length} arquivo(s) · até 32 uploads · ZIP aninhado não permitido. A associação ao Project é explícita.</span>
          <button className="button primary" type="submit" disabled={disabled || busy || files.length === 0}>{busy ? "Processando…" : selectedTemplateId ? "Adicionar versão" : "Importar template"}</button>
        </div>
      </form>

      {selection && <div className={`template-selection-status template-integrity-${inspection?.status ?? "checking"}`} aria-live="polite">
        <strong>Project selecionado:</strong> {selection.templateId} · v{selection.version} · SHA-256 {selection.packageHash}
        <span>{inspection ? integrityLabel(inspection.status) : "Verificando arquivos originais…"}</span>
        {registrationStatus === "legacy-custom-unconfigured" && <span role="alert">Registration custom desta versão legada não tem geometria física configurada. Ela não será convertida para “none”; escolha uma configuração de registration do Project antes de exportar.</span>}
        {registrationStatus === "legacy-physical-format-unconfigured" && <span role="alert">Esta versão legada declara papel ou formato de carta custom sem dimensões em mm. Os valores do Working Set foram mantidos; selecione uma versão com geometria física explícita antes de exportar.</span>}
        {registrationStatus === "unavailable" && <span role="alert">A versão selecionada não pôde ser verificada exatamente. Revise ou desassocie o template antes de exportar.</span>}
        {inspection?.files.filter((file) => file.status !== "available").map((file) => <span key={file.fileId} role="alert">{file.relativePath}: {file.status === "missing" ? "ausente" : "corrompido"}</span>)}
      </div>}

      {selection && <section className="template-cut-source" aria-label="Geometria de corte">
        <h4>Fonte de geometria de corte</h4>
        <p>Selecione explicitamente um SVG ou DXF desta versão. Se houver vários, nenhum será escolhido automaticamente. Sem arquivo selecionado, exports de corte usam somente retângulos de trim do layout.</p>
        <label>Arquivo SVG/DXF
          <select
            value={selectedCutFile?.fileId ?? ""}
            disabled={disabled || busy || !inspection || inspection.status !== "available"}
            onChange={(event) => {
              const file = cutFiles.find((candidate) => candidate.fileId === event.currentTarget.value);
              onCutSourceSelect?.(file ? { fileId: file.fileId, fileHash: file.contentHash } : null);
            }}
          >
            <option value="">Sem arquivo de corte</option>
            {cutFiles.map((file) => <option key={file.fileId} value={file.fileId}>{file.relativePath} · {file.extension.toUpperCase()} · {file.status}</option>)}
          </select>
        </label>
        {selectedCutFile && selectedCutFile.extension === "dxf" && cutSourceSelection && <label>Unidades DXF
          <select
            value={cutSourceSelection.dxfUnitsOverride ?? "auto"}
            disabled={disabled || busy}
            onChange={(event) => {
              const value = event.currentTarget.value;
              const units = value === "auto" ? undefined : value as DxfUnitsOverride;
              onCutSourceSelect?.({
                fileId: selectedCutFile.fileId,
                fileHash: selectedCutFile.contentHash,
                ...(units ? { dxfUnitsOverride: units } : {}),
              });
            }}
          >
            <option value="auto">Automática por $INSUNITS</option>
            <option value="mm">Milímetros (mm)</option><option value="cm">Centímetros (cm)</option>
            <option value="m">Metros (m)</option><option value="in">Polegadas (in)</option>
            <option value="ft">Pés (ft)</option><option value="yd">Jardas (yd)</option>
          </select>
        </label>}
        {selectedCutFile && selectedCutFile.status !== "available" && <span role="alert">O original selecionado não está íntegro; preview e export ficam bloqueados.</span>}
        {cutFiles.length > 1 && <span>Esta versão contém {cutFiles.length} fontes vetoriais; a geometria exportada fica vinculada somente ao arquivo escolhido.</span>}
      </section>}

      {templates.length === 0 ? <p className="muted">Biblioteca vazia.</p> : <ul className="template-list">
        {templates.map((template) => <li key={template.id} className="template-list-item">
          <div className="template-title-row">
            <div><strong>{template.name}</strong><span>{template.source} · atualizado {template.updatedAt}</span></div>
            <button className="button secondary" type="button" disabled={disabled || busy} onClick={() => void removeTemplate(template)}>Remover</button>
          </div>
          {template.versions.map((version) => {
            const versionKey = `${template.id}:${version.version}`;
            return <div className="template-version-row" key={versionKey}>
              <div className="template-version-meta">
                <strong>v{version.version} · {version.paper.toUpperCase()} · {version.cardFormat} · {version.orientation}</strong>
                <code>SHA-256 {version.packageHash}</code>
                <span>{templateRegistrationLabel(version)}{version.recommendedBleedMm === undefined ? "" : ` · bleed ${version.recommendedBleedMm} mm`} · {version.files.length} arquivo(s)</span>
                <ul>{version.files.map((file) => <li key={file.fileId}>
                  <a href={`/api/templates/files/${encodeURIComponent(file.fileId)}`}>{file.relativePath}</a>
                  <span>{file.byteLength.toLocaleString()} bytes · SHA-256 {file.contentHash}</span>
                </li>)}</ul>
              </div>
              <button className={`button ${selectedVersion(selection, template, version) ? "primary" : "secondary"}`} type="button" disabled={disabled || busy} aria-pressed={selectedId === versionKey} onClick={() => onSelect(
                { templateId: template.id, version: version.version, packageHash: version.packageHash },
                registrationDefaultsForTemplate(version),
              )}>
                {selectedVersion(selection, template, version) ? "Associado" : "Associar ao Project"}
              </button>
            </div>;
          })}
        </li>)}
      </ul>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </section>
  );
}
