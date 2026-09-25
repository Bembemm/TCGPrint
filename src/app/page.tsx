"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, DragEvent, InputHTMLAttributes } from "react";
import type { ImportKind, ImportPreview } from "../../import-engine/types";

function sourceId(index: number, filename: string): string {
  return `input:${index}:${encodeURIComponent(filename)}`;
}

function previewImageKind(kind: string | undefined): boolean {
  return kind === "png" || kind === "jpeg" || kind === "svg";
}

function displayName(entry: ImportPreview["entries"][number]): string {
  return entry.cardHint?.name ?? entry.nameSuggestion ?? entry.asset?.sourceFilename ?? "Entrada sem nome";
}

export default function HomePage() {
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ImportKind>>({});
  const [selectedPdfSource, setSelectedPdfSource] = useState("");
  const [imagePreviewUrl, setImagePreviewUrl] = useState("");
  const [bleedMm, setBleedMm] = useState("0.625");
  const [cutGuides, setCutGuides] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");

  const directoryAttributes = { webkitdirectory: "", directory: "" } as InputHTMLAttributes<HTMLInputElement>;
  const exportableEntries = useMemo(
    () => preview?.entries.filter((entry) => entry.kind === "custom-card" && entry.asset) ?? [],
    [preview],
  );
  const selectedEntry = exportableEntries.find((entry) => entry.sourceId === selectedPdfSource);
  const selectedFormat = selectedEntry?.asset?.originalFormat;
  const directFile = files.find((file, index) => sourceId(index, file.name) === selectedPdfSource);
  useEffect(() => () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  }, [pdfUrl]);

  useEffect(() => {
    if (!directFile) {
      setImagePreviewUrl("");
      return;
    }
    const nextUrl = URL.createObjectURL(directFile);
    setImagePreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [directFile]);

  function addFiles(incoming: FileList | readonly File[]) {
    const next = Array.from(incoming);
    if (next.length === 0) return;
    setFiles((current) => [...current, ...next]);
    setPreview(null);
    setSelectedPdfSource("");
    setPdfUrl("");
    setProblem("");
    setStatus(`${next.length} arquivo(s) adicionado(s).`);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.files) addFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    addFiles(event.dataTransfer.files);
  }

  async function runPreview() {
    if (files.length === 0 && !text.trim()) {
      setProblem("Adicione arquivos ou cole uma decklist para criar o preview.");
      return;
    }
    setBusy(true);
    setProblem("");
    setStatus("Analisando os arquivos fornecidos…");
    setPdfUrl("");
    try {
      const form = new FormData();
      const paths: string[] = [];
      for (const file of files) {
        form.append("files", file, file.name);
        paths.push(file.webkitRelativePath || "");
      }
      form.set("filePaths", JSON.stringify(paths));
      if (text.trim()) form.set("text", text);
      form.set("selections", JSON.stringify(choices));
      const response = await fetch("/api/import/preview", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Não foi possível criar o preview.");
      const result = body as ImportPreview;
      setPreview(result);
      const firstExportable = result.entries.find((entry) => {
        const sourceIndex = files.findIndex((file, index) => sourceId(index, file.name) === entry.sourceId);
        return sourceIndex >= 0 && entry.kind === "custom-card" && entry.asset;
      });
      setSelectedPdfSource((current) => current || firstExportable?.sourceId || "");
      setStatus("Preview atualizado. Nenhum projeto foi gravado.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Erro ao analisar as entradas.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function generatePdf() {
    if (!directFile || !selectedEntry || !previewImageKind(selectedFormat)) return;
    setBusy(true);
    setProblem("");
    setStatus("Gerando PDF com o pipeline existente…");
    try {
      const form = new FormData();
      form.set("image", directFile, directFile.name);
      form.set("bleedMm", bleedMm);
      form.set("cutGuides", cutGuides ? "full" : "none");
      const response = await fetch("/api/import/pdf", { method: "POST", body: form });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.message ?? "Não foi possível gerar o PDF.");
      }
      const nextUrl = URL.createObjectURL(await response.blob());
      setPdfUrl(nextUrl);
      setStatus("PDF de teste pronto. Trim Magic Standard, folha A4.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Erro ao gerar o PDF de teste.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workbench">
      <header className="page-header">
        <div>
          <p className="eyebrow">TCGPrint · fase 4</p>
          <h1>Universal Import Engine</h1>
          <p className="subhead">Inspecione arquivos e listas antes de resolver identidade ou salvar um projeto.</p>
        </div>
        <div className="local-badge">Local · sem busca externa</div>
      </header>

      <section className="panel input-panel" aria-labelledby="inputs-heading">
        <div className="panel-heading">
          <div>
            <h2 id="inputs-heading">Entradas</h2>
            <p>Imagens, listas, arquivos estruturados, ZIPs ou texto colado.</p>
          </div>
          <button className="button secondary" type="button" onClick={() => {
            setFiles([]);
            setText("");
            setPreview(null);
            setChoices({});
            setSelectedPdfSource("");
            setImagePreviewUrl("");
            setPdfUrl("");
            setStatus("");
            setProblem("");
          }}>Limpar</button>
        </div>

        <label className="field-label" htmlFor="decklist">Cole uma decklist</label>
        <textarea
          id="decklist"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          placeholder={'Commander\n1 Sol Ring\nMainboard\n10 Island'}
          rows={6}
        />

        <div
          className="drop-zone"
          role="region"
          aria-label="Área para arrastar arquivos"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <div>
            <strong>Arraste arquivos aqui</strong>
            <span>PNG, JPEG, WebP, TIFF, SVG, TXT, CSV, TSV, JSON, XML e ZIP</span>
          </div>
          <div className="file-actions">
            <label className="button secondary">
              Selecionar arquivos
              <input
                className="visually-hidden"
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp,.tif,.tiff,.svg,.txt,.csv,.tsv,.json,.xml,.zip"
                onChange={handleFileChange}
              />
            </label>
            <label className="button secondary">
              Selecionar pasta
              <input
                className="visually-hidden"
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp,.tif,.tiff,.svg,.txt,.csv,.tsv,.json,.xml,.zip"
                {...directoryAttributes}
                onChange={handleFileChange}
              />
            </label>
          </div>
        </div>

        {files.length > 0 && (
          <div className="selected-files" aria-live="polite">
            <span>{files.length} arquivo(s) selecionado(s)</span>
            <ul>{files.map((file, index) => (
              <li key={`${file.name}:${file.lastModified}:${index}`}>
                <span>{file.webkitRelativePath || file.name}</span>
                <span>{(file.size / 1024).toFixed(1)} KB</span>
              </li>
            ))}</ul>
          </div>
        )}
        <div className="action-row">
          <button className="button primary" type="button" onClick={runPreview} disabled={busy}>
            {busy ? "Processando…" : "Criar preview"}
          </button>
          <span className="status" aria-live="polite">{status}</span>
        </div>
        {problem && <p className="error-message" role="alert">{problem}</p>}
      </section>

      {preview && (
        <section className="panel report-panel" aria-labelledby="report-heading">
          <div className="panel-heading">
            <div>
              <h2 id="report-heading">ImportReport</h2>
              <p>Preview somente leitura; confirme as entradas na etapa seguinte do produto.</p>
            </div>
          </div>

          <dl className="summary-grid">
            {Object.entries(preview.report.summary).map(([key, value]) => (
              <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
            ))}
          </dl>

          <h3>Detecção</h3>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Arquivo</th><th>Status</th><th>Candidatos / confiança</th><th>Importer</th></tr></thead>
              <tbody>{preview.detections.map((detection) => {
                const source = preview.sources.find((item) => item.id === detection.sourceId);
                const manualValue = choices[detection.sourceId ?? ""] ?? detection.selected?.kind ?? "";
                return (
                  <tr key={detection.sourceId}>
                    <td>{source?.sourcePath || source?.filename || detection.sourceId}</td>
                    <td>{detection.status}</td>
                    <td>
                      <div>{detection.candidates.map((candidate) => `${candidate.kind} ${(candidate.confidence * 100).toFixed(0)}%`).join(" · ")}</div>
                      {detection.reasons.length > 0 && <small className="detection-reasons">{detection.reasons.join(" ")}</small>}
                    </td>
                    <td>{detection.status === "ambiguous" ? (
                      <select
                        aria-label={`Importer para ${source?.filename ?? detection.sourceId}`}
                        value={manualValue}
                        onChange={(event) => setChoices((current) => ({ ...current, [detection.sourceId ?? ""]: event.currentTarget.value as ImportKind }))}
                      >
                        <option value="">Escolha</option>
                        {detection.candidates.map((candidate) => <option key={candidate.kind} value={candidate.kind}>{candidate.kind}</option>)}
                      </select>
                    ) : detection.selected?.kind ?? "aguardando escolha"}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>

          {preview.report.mappings.length > 0 && <>
            <h3>Mapeamentos</h3>
            {preview.report.mappings.map((mapping) => (
              <div className="mapping-row" key={mapping.sourceId}>
                <strong>{mapping.format}</strong>
                <span>{Object.entries(mapping.fields).map(([field, column]) => `${field} → ${String(column)}`).join(" · ") || "Nenhum campo reconhecido"}</span>
                <span>Desconhecidos: {mapping.unknownFields.join(", ") || "nenhum"}</span>
              </div>
            ))}
          </>}

          <h3>Entries detectadas</h3>
          <div className="table-scroll">
            <table>
              <thead><tr><th>#</th><th>Tipo</th><th>Nome sugerido</th><th>Qtd.</th><th>Seção</th><th>Asset</th></tr></thead>
              <tbody>{preview.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.order + 1}</td>
                  <td>{entry.kind}</td>
                  <td>{displayName(entry)}</td>
                  <td>{entry.quantity}</td>
                  <td>{entry.section ?? entry.cardHint?.section ?? "—"}</td>
                  <td>{entry.asset ? `${entry.asset.originalFormat} · ${entry.asset.widthPx ?? "?"}×${entry.asset.heightPx ?? "?"}` : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>

          <div className="report-columns">
            <div>
              <h3>Warnings</h3>
              {preview.report.warnings.length === 0 ? <p className="muted">Nenhum warning.</p> : <ul className="issue-list">{preview.report.warnings.map((item, index) => <li key={`${item.code}:${index}`}><strong>{item.code}</strong> · {item.message}</li>)}</ul>}
            </div>
            <div>
              <h3>Errors</h3>
              {preview.report.errors.length === 0 ? <p className="muted">Nenhum erro.</p> : <ul className="issue-list errors">{preview.report.errors.map((item, index) => <li key={`${item.code}:${index}`}><strong>{item.code}</strong> · {item.message}</li>)}</ul>}
            </div>
          </div>

          <section className="pdf-test" aria-labelledby="pdf-heading">
            <div>
              <h3 id="pdf-heading">PDF local de teste</h3>
              <p>Magic Standard 63,5 × 88,9 mm · A4 · motores existentes de bleed e guias.</p>
            </div>
            {exportableEntries.length > 0 && <div className="pdf-controls">
              <label>
                Imagem local
                <select value={selectedPdfSource} onChange={(event) => setSelectedPdfSource(event.currentTarget.value)}>
                  {exportableEntries.map((entry) => <option key={entry.sourceId} value={entry.sourceId}>{displayName(entry)} · {entry.asset?.originalFormat.toUpperCase()}</option>)}
                </select>
              </label>
              <label className="narrow-field">Bleed (mm)
                <input type="number" min="0" max="3" step="0.125" value={bleedMm} onChange={(event) => setBleedMm(event.currentTarget.value)} />
              </label>
              <label className="checkbox-field"><input type="checkbox" checked={cutGuides} onChange={(event) => setCutGuides(event.currentTarget.checked)} /> Guias vetoriais</label>
              <button className="button primary" type="button" disabled={busy || !directFile || !previewImageKind(selectedFormat)} onClick={generatePdf}>Gerar PDF de teste</button>
            </div>}
            {selectedFormat && !previewImageKind(selectedFormat) && <p className="muted">Importado, export direto ainda não suportado para {selectedFormat.toUpperCase()}.</p>}
            {!selectedEntry && <p className="muted">Importe uma imagem local PNG, JPEG ou SVG para testar o PDF.</p>}
            {selectedEntry && !directFile && <p className="muted">Para exportar o teste, selecione diretamente o arquivo de imagem local.</p>}
            {imagePreviewUrl && <img className="local-preview" src={imagePreviewUrl} alt={`Preview local de ${directFile?.name ?? "imagem"}`} />}
            {pdfUrl && <a className="download-link" href={pdfUrl} download="tcgprint-test.pdf">Baixar PDF de teste</a>}
          </section>
        </section>
      )}
    </main>
  );
}
