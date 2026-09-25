import { ImportFailureError } from "../errors";
import type { ImportKind, ImportSource, ImportedEntry, ImportWarning } from "../types";
import type { ImporterOutput } from "./types";

const TEXT_KINDS = new Set<ImportKind>([
  "simple-decklist", "arena-like", "mtgo-like", "xmage-like", "mwdeck-like",
]);

interface ParsedCardLine {
  readonly quantity: number;
  readonly name: string;
  readonly setCode?: string;
  readonly collectorNumber?: string;
}

function sectionFor(line: string): string | undefined {
  const value = line.trim().toLowerCase().replace(/:$/, "");
  if (["mainboard", "main", "main deck", "deck"].includes(value)) return "Mainboard";
  if (["sideboard", "side"].includes(value)) return "Sideboard";
  if (value === "commander") return "Commander";
  if (["maybeboard", "maybe board"].includes(value)) return "Maybeboard";
  if (value === "companion") return "Companion";
  return undefined;
}

function parseCardLine(raw: string, kind: ImportKind): ParsedCardLine | undefined {
  let line = raw.trim();
  if (!line) return undefined;
  if (kind === "mtgo-like") {
    const sideboard = /^SB\s*:\s*/i.exec(line);
    if (sideboard) line = line.slice(sideboard[0].length).trim();
  }

  let quantity = 1;
  const quantityMatch = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
  if (quantityMatch) {
    quantity = Number(quantityMatch[1]);
    line = quantityMatch[2].trim();
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return undefined;
  }

  let setCode: string | undefined;
  let collectorNumber: string | undefined;
  const printing = /^(.*?)\s+\(([A-Za-z0-9]{2,8})\)\s+([A-Za-z0-9][A-Za-z0-9/-]*)$/.exec(line);
  if (printing && printing[1].trim()) {
    line = printing[1].trim();
    setCode = printing[2].toUpperCase();
    collectorNumber = printing[3];
  }

  if (kind === "mwdeck-like") {
    const mwsSet = /^\[([A-Za-z0-9]{2,8})\]\s*(.+)$/.exec(line);
    if (mwsSet && mwsSet[2].trim()) {
      setCode = mwsSet[1].toUpperCase();
      line = mwsSet[2].trim();
    }
  }

  if (!line || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line)) return undefined;
  return { quantity, name: line, ...(setCode ? { setCode } : {}), ...(collectorNumber ? { collectorNumber } : {}) };
}

function adapterMatches(kind: ImportKind, text: string, source?: ImportSource): boolean {
  switch (kind) {
    case "arena-like":
      return /^\s*Deck\s*$/im.test(text)
        && /^\s*\d+\s+.+\s+\([A-Za-z0-9]{2,8}\)\s+[A-Za-z0-9][A-Za-z0-9/-]*\s*$/m.test(text);
    case "mtgo-like":
      return /^\s*SB\s*:\s*\d+\s+\S/im.test(text);
    case "xmage-like":
      return /^\s*LAYOUT\s+MAIN\s*$/im.test(text);
    case "mwdeck-like":
      return /Deck file for Magic Workstation|Magic Workstation/i.test(text)
        || (source?.filename?.toLowerCase().endsWith(".mwdeck") === true && /^\s*\d+\s+\[[A-Za-z0-9]{2,8}\]/m.test(text));
    case "simple-decklist":
      return true;
    default:
      return false;
  }
}

function mapSectionForLine(kind: ImportKind, raw: string, section: string | undefined): string | undefined {
  if (kind === "mtgo-like" && /^\s*SB\s*:/i.test(raw)) return "Sideboard";
  if (kind === "arena-like" && section === undefined) return "Mainboard";
  if (kind === "xmage-like" && section === undefined) return "Mainboard";
  return section;
}

/** Parses supplied deck text only; names and printing fields remain hints, never identities. */
export function parseTextImport(
  text: string,
  kind: ImportKind,
  source?: ImportSource,
): ImporterOutput {
  if (!TEXT_KINDS.has(kind)) {
    throw new ImportFailureError(`Importer ${kind} does not accept deck text.`, "FORMAT_MISMATCH", source?.id, source?.sourcePath);
  }
  if (!adapterMatches(kind, text, source)) {
    throw new ImportFailureError(`Text does not contain enough structure for the selected ${kind} adapter.`, "FORMAT_MISMATCH", source?.id, source?.sourcePath);
  }

  const sourceId = source?.id ?? "pasted-text";
  const sourceOrder = source?.order ?? 0;
  const entries: ImportedEntry[] = [];
  const warnings: ImportWarning[] = [];
  let currentSection: string | undefined;

  text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    if (kind === "mwdeck-like" && /Deck file for Magic Workstation|Magic Workstation/i.test(line)) return;
    if (kind === "xmage-like" && /^LAYOUT\s+/i.test(line)) {
      const layout = /^LAYOUT\s+(MAIN|SIDEBOARD|COMMANDER|MAYBEBOARD)\s*$/i.exec(line);
      if (layout) currentSection = sectionFor(layout[1]);
      else warnings.push({
        code: "UNRECOGNIZED_SECTION",
        message: `Linha de layout não reconhecida: ${line}`,
        sourceId,
        sourceFilename: source?.filename,
        sourcePath: source?.sourcePath,
        line: index + 1,
      });
      return;
    }
    if (kind === "mwdeck-like" && /^\s*\[[^\]]+\]\s*$/.test(line)) {
      currentSection = sectionFor(line.slice(1, -1));
      if (!currentSection) warnings.push({
        code: "UNRECOGNIZED_SECTION", message: `Seção MWS não reconhecida: ${line}`,
        sourceId, sourceFilename: source?.filename, sourcePath: source?.sourcePath, line: index + 1,
      });
      return;
    }
    const recognizedSection = sectionFor(line);
    if (recognizedSection) {
      currentSection = recognizedSection;
      return;
    }
    if (kind === "arena-like" && /^(?:Deck|Commander|Companion)\s*$/i.test(line)) {
      currentSection = line.toLowerCase() === "deck" ? "Mainboard" : sectionFor(line);
      return;
    }
    if (kind === "mwdeck-like" && /^(?:#|\/\/)/.test(line)) return;

    const parsed = parseCardLine(line, kind);
    if (!parsed) {
      warnings.push({
        code: "UNPARSED_LINE",
        message: `Linha não interpretada preservada como aviso: ${line}`,
        sourceId,
        sourceFilename: source?.filename,
        sourcePath: source?.sourcePath,
        line: index + 1,
      });
      return;
    }
    const section = mapSectionForLine(kind, rawLine, currentSection);
    entries.push({
      id: `${sourceId}:line:${index + 1}`,
      kind: "deck-card",
      order: sourceOrder + entries.length,
      quantity: parsed.quantity,
      sourceId,
      sourceFilename: source?.filename,
      sourcePath: source?.sourcePath,
      cardHint: {
        name: parsed.name,
        ...(parsed.setCode ? { setCode: parsed.setCode } : {}),
        ...(parsed.collectorNumber ? { collectorNumber: parsed.collectorNumber } : {}),
        ...(section ? { section } : {}),
      },
      section,
      metadata: Object.freeze({ rawLine, parser: kind, line: index + 1 }),
    });
  });

  return { entries, warnings };
}
