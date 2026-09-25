import type {
  ImportCandidate,
  ImportDetection,
  ImportDetectionInput,
  ImportKind,
} from "./types";

export interface DetectionPolicy {
  readonly autoSelectMinimum: number;
  readonly ambiguousMinimum: number;
  readonly ambiguityMargin: number;
  readonly extensionAdjustment: number;
}

export const DETECTION_POLICY: DetectionPolicy = Object.freeze({
  autoSelectMinimum: 0.78,
  ambiguousMinimum: 0.5,
  ambiguityMargin: 0.12,
  extensionAdjustment: 0.04,
});

const EXTENSION_KINDS: Readonly<Record<string, ImportKind>> = Object.freeze({
  png: "image", jpg: "image", jpeg: "image", webp: "image", tif: "image", tiff: "image",
  svg: "svg", txt: "simple-decklist", csv: "csv", tsv: "tsv", json: "json", xml: "generic-xml", zip: "zip",
  mwdeck: "mwdeck-like", dck: "xmage-like",
});

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function bufferView(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function normalizedText(input: ImportDetectionInput): string | undefined {
  if (input.text !== undefined) return input.text.replace(/^\uFEFF/, "");
  if (!input.bytes) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input.bytes).replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  }
}

function stripXmlPreamble(value: string): string {
  return value
    .replace(/^\s+/, "")
    .replace(/^(?:<\?xml\b[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)+/i, "");
}

function addCandidate(
  candidates: ImportCandidate[],
  kind: ImportKind,
  confidence: number,
  reason: string,
  originalFormat?: string,
): void {
  const existing = candidates.find((candidate) => candidate.kind === kind);
  if (existing) {
    const index = candidates.indexOf(existing);
    candidates[index] = {
      ...existing,
      confidence: Math.max(existing.confidence, confidence),
      reasons: [...existing.reasons, reason],
      originalFormat: existing.originalFormat ?? originalFormat,
    };
    return;
  }
  candidates.push({ kind, confidence, reasons: [reason], ...(originalFormat ? { originalFormat } : {}) });
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isTiff(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && (bytes[2] === 0x2a || bytes[2] === 0x2b) && bytes[3] === 0)
    || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && (bytes[3] === 0x2a || bytes[3] === 0x2b))
  );
}

function countUnquotedDelimiters(text: string, delimiter: "," | "\t"): number[] {
  const rows: number[] = [];
  let count = 0;
  let inQuotes = false;
  for (let index = 0; index < Math.min(text.length, 64 * 1024); index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && character === delimiter) count += 1;
    else if (!inQuotes && (character === "\n" || character === "\r")) {
      if (count > 0) rows.push(count);
      count = 0;
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    }
  }
  if (count > 0) rows.push(count);
  return rows.slice(0, 12);
}

function tabularConfidence(rows: readonly number[]): number {
  if (rows.length === 0) return 0;
  const consistentRows = rows.filter((count) => count === rows[0]).length;
  const consistency = consistentRows / rows.length;
  return 0.72 + Math.min(rows[0] * 0.04, 0.08) + (rows.length > 1 ? consistency * 0.08 : 0);
}

function addTextCandidates(text: string, filename: string | undefined, candidates: ImportCandidate[]): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const commaRows = countUnquotedDelimiters(text, ",");
  const tabRows = countUnquotedDelimiters(text, "\t");
  const isTabular = (commaRows[0] ?? 0) > 0 || (tabRows[0] ?? 0) > 0;
  const isStructured = /^[\[{<]/.test(trimmed) || isUrl(trimmed);

  const hasMtgoMarker = /^\s*(?:SB\s*:\s*\d+|SIDEBOARD\s*:\s*\d+)\s+/im.test(text);
  const xmageMarkers = /^\s*LAYOUT\s+(?:MAIN|SIDEBOARD|COMMANDER|MAYBEBOARD)\s*$/im;
  const hasXmageMarker = xmageMarkers.test(text) && /^\s*LAYOUT\s+MAIN\s*$/im.test(text);
  const mwdeckMarker = /Deck file for Magic Workstation|Magic Workstation/i.test(text);
  const bracketedSetLine = /^(?:\d+\s*x?\s*)?\[[A-Za-z0-9]{2,8}\]\s*\S+/m.test(text);
  const extension = getExtension(filename);
  const hasMwsMarker = (mwdeckMarker && bracketedSetLine) || (extension === "mwdeck" && bracketedSetLine);
  const hasArenaSection = /^\s*(?:Deck|Commander|Companion)\s*$/im.test(text);
  const hasArenaPrinting = /^\s*\d+\s+.+\s+\([A-Za-z0-9]{2,8}\)\s+[A-Za-z0-9][A-Za-z0-9/-]*\s*$/m.test(text);
  const hasArenaMarker = hasArenaSection && hasArenaPrinting && /^\s*Deck\s*$/im.test(text);
  const hasRecognizedAdapter = hasMtgoMarker || hasXmageMarker || hasMwsMarker || hasArenaMarker;

  if (!isStructured && !isTabular && !hasRecognizedAdapter) {
    addCandidate(candidates, "simple-decklist", lines.length === 1 ? 0.81 : 0.86, "Texto possui linhas compatíveis com entradas de decklist.");
  }

  if (hasMtgoMarker) {
    addCandidate(candidates, "mtgo-like", 0.97, "Linhas com prefixo de sideboard `SB:` identificam o formato textual MTGO.");
  }

  if (hasXmageMarker) {
    addCandidate(candidates, "xmage-like", 0.97, "Cabeçalhos LAYOUT MAIN/SIDEBOARD identificam uma lista XMage.");
  }

  if (hasMwsMarker) {
    addCandidate(candidates, "mwdeck-like", mwdeckMarker ? 0.98 : 0.9, "Marcadores de Magic Workstation e set entre colchetes identificam MWS.");
  }

  if (hasArenaMarker) {
    addCandidate(candidates, "arena-like", 0.98, "Cabeçalho Deck junto com set/collector no formato Arena.");
  }

  if (extension === "dck" && /^\s*(?:LAYOUT\s+MAIN|SB\s*:)/im.test(text)) {
    addCandidate(candidates, "xmage-like", 0.9, "Extensão .dck junto com estrutura de área de deck reconhecida.");
  }

  if (commaRows.length > 0 && commaRows[0] > 0) {
    addCandidate(candidates, "csv", tabularConfidence(commaRows), "Delimitadores não citados formam colunas CSV consistentes.");
  }
  if (tabRows.length > 0 && tabRows[0] > 0) {
    addCandidate(candidates, "tsv", tabularConfidence(tabRows), "Tabulações fora de campos citados formam colunas TSV consistentes.");
  }

  if (/^\s*[\[{]/.test(text)) {
    addCandidate(candidates, "json", 0.84, "Conteúdo começa com um objeto ou array JSON.");
  }

  const xmlText = stripXmlPreamble(text);
  if (/^<svg(?:\s|>)/i.test(xmlText)) {
    addCandidate(candidates, "svg", 0.99, "Elemento raiz SVG encontrado no conteúdo.", "svg");
  } else if (/^<[A-Za-z_:][\w:.-]*(?:\s|>)/.test(xmlText)) {
    const isMpc = /^<order(?:\s|>)/i.test(xmlText)
      && /<fronts(?:\s|>)/i.test(xmlText)
      && /<card(?:\s|>)/i.test(xmlText)
      && /<(?:id|slots?|query|name)(?:\s|>)/i.test(xmlText);
    addCandidate(candidates, "generic-xml", isMpc ? 0.82 : 0.86, "Elemento raiz XML encontrado no conteúdo.", "xml");
    if (isMpc) addCandidate(candidates, "mpc-autofill-xml", 0.99, "Estrutura order/fronts/card com campos MPC Autofill encontrada.", "xml");
  }
}

function getExtension(filename?: string): string | undefined {
  const name = filename?.split(/[\\/]/).pop();
  const index = name?.lastIndexOf(".") ?? -1;
  return index >= 0 ? name!.slice(index + 1).toLowerCase() : undefined;
}

function applyExtensionHint(
  candidates: ImportCandidate[],
  filename: string | undefined,
  reasons: string[],
): ImportCandidate[] {
  const extension = getExtension(filename);
  const extensionKind = extension ? EXTENSION_KINDS[extension] : undefined;
  if (!extension || !extensionKind) return candidates;
  const extensionFormat = extension === "jpg" ? "jpeg" : extension === "tif" ? "tiff" : extension;
  const matching = candidates.find((candidate) => candidate.kind === extensionKind);
  if (matching && (extensionKind !== "image" || matching.originalFormat === extensionFormat)) {
    return candidates.map((candidate) => candidate.kind === extensionKind
      ? { ...candidate, confidence: Math.min(0.99, candidate.confidence + DETECTION_POLICY.extensionAdjustment), reasons: [...candidate.reasons, `A extensão .${extension} reforça a evidência de conteúdo.`] }
      : candidate);
  }
  if (matching || candidates.length > 0) {
    const mismatch = `A extensão .${extension} diverge do formato indicado pelos bytes/conteúdo e teve peso secundário.`;
    reasons.push(mismatch);
    return candidates.map((candidate) => candidate.kind === extensionKind
      ? { ...candidate, reasons: [...candidate.reasons, mismatch] }
      : candidate);
  }
  return candidates;
}

export function detectImport(input: ImportDetectionInput, policy: DetectionPolicy = DETECTION_POLICY): ImportDetection {
  const candidates: ImportCandidate[] = [];
  const reasons: string[] = [];
  const bytes = input.bytes;
  const text = normalizedText(input);
  let signatureFormat: string | undefined;

  if (bytes?.length) {
    if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
      signatureFormat = "png";
    } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      signatureFormat = "jpeg";
    } else if (bytes.length >= 12 && bufferView(bytes).toString("ascii", 0, 4) === "RIFF" && bufferView(bytes).toString("ascii", 8, 12) === "WEBP") {
      signatureFormat = "webp";
    } else if (isTiff(bytes)) {
      signatureFormat = "tiff";
    } else if (
      bytes.length >= 4
      && bytes[0] === 0x50 && bytes[1] === 0x4b
      && ([0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3]))
    ) {
      addCandidate(candidates, "zip", 0.99, "Assinatura ZIP local/central encontrada nos bytes.", "zip");
    }
    if (signatureFormat) {
      addCandidate(candidates, "image", 0.98, `Assinatura binária ${signatureFormat.toUpperCase()} encontrada nos bytes.`, signatureFormat);
    }
  }

  if (!signatureFormat && !candidates.some((candidate) => candidate.kind === "zip") && text !== undefined) {
    if (isUrl(text)) addCandidate(candidates, "url", 0.99, "Texto é uma URL HTTP(S); não haverá fetch nesta fase.");
    else if (/^\s*<\?xml\b/i.test(text) || /^\s*</.test(text)) addTextCandidates(text, input.fileName, candidates);
    else if (/^\s*[\[{]/.test(text)) addTextCandidates(text, input.fileName, candidates);
    else addTextCandidates(text, input.fileName, candidates);
  }

  let hinted = applyExtensionHint(candidates, input.fileName, reasons);
  if (hinted.length === 0) {
    reasons.push("Nenhuma assinatura de bytes ou estrutura textual reconhecida; a extensão sozinha não seleciona um importer.");
    const unknown: ImportCandidate = { kind: "unknown", confidence: 1, reasons: [reasons[0]] };
    return { status: "unknown", candidates: [unknown], reasons };
  }

  hinted = hinted
    .map((candidate) => ({ ...candidate, confidence: Math.min(1, Math.max(0, candidate.confidence)) }))
    .sort((left, right) => right.confidence - left.confidence || left.kind.localeCompare(right.kind));
  const top = hinted[0];
  const second = hinted[1];
  const hasPlausibleSecond = Boolean(second && second.confidence >= policy.ambiguousMinimum);
  const ambiguous = top.confidence < policy.autoSelectMinimum
    || (hasPlausibleSecond && top.confidence - second!.confidence < policy.ambiguityMargin);

  if (ambiguous) {
    reasons.push("Há mais de uma hipótese plausível ou a confiança não atingiu a política de seleção automática; escolha um formato.");
    return { status: "ambiguous", candidates: hinted, reasons };
  }

  reasons.push(`Formato selecionado automaticamente: ${top.kind} (${top.confidence.toFixed(2)}).`);
  return { status: "auto-selected", candidates: hinted, selected: top, reasons };
}
