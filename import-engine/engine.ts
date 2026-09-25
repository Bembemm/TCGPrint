import { createHash } from "node:crypto";
import { ImportCancelledError, ImportFailureError } from "./errors";
import { detectImport } from "./detection";
import { resolveImportLimits } from "./limits";
import { importImageSource } from "./importers/image";
import { parseTextImport } from "./importers/text";
import { parseCsvImport } from "./importers/csv";
import { parseJsonImport } from "./importers/json";
import { importGenericXml, importMpcAutofillXml } from "./importers/xml";
import { expandZipSource } from "./zip";
import type {
  ImportCandidate,
  ImportDetection,
  ImportError,
  ImportFileInput,
  ImportKind,
  ImportMapping,
  ImportReport,
  ImportResult,
  ImportSource,
  ImportWarning,
  ImportedAsset,
  ImportedEntry,
  SuggestedAssetPairing,
  UniversalImportOptions,
  UniversalImportRequest,
} from "./types";

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256")
    .update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest("hex");
}

function fileSource(file: ImportFileInput, order: number): ImportSource {
  return {
    id: `input:${order}:${encodeURIComponent(file.filename)}`,
    kind: file.kind ?? "file",
    filename: file.filename,
    sourcePath: file.sourcePath,
    order,
    sizeBytes: file.bytes.byteLength,
    originalBytes: file.bytes,
    sha256: hashBytes(file.bytes),
  };
}

function pastedSource(text: string, filename: string | undefined, order: number): ImportSource {
  const bytes = new TextEncoder().encode(text);
  return {
    id: `input:${order}:${encodeURIComponent(filename ?? "pasted.txt")}`,
    kind: "text",
    filename: filename ?? "pasted.txt",
    order,
    sizeBytes: bytes.byteLength,
    originalText: text,
    sha256: hashBytes(bytes),
  };
}

function candidateDetection(source: ImportSource, maxBytes: number, maxTextBytes: number): ImportDetection {
  const tooLarge = source.sizeBytes > maxBytes;
  if (tooLarge) {
    return {
      sourceId: source.id,
      status: "unknown",
      candidates: [{ kind: "unknown", confidence: 1, reasons: ["Input exceeds the configured size limit and was not sniffed."] }],
      reasons: ["Input exceeds the configured size limit and was not sniffed."],
    };
  }
  if (source.kind === "text" && source.sizeBytes > maxTextBytes) {
    return {
      sourceId: source.id,
      status: "unknown",
      candidates: [{ kind: "unknown", confidence: 1, reasons: ["Pasted text exceeds the configured text limit and was not sniffed."] }],
      reasons: ["Pasted text exceeds the configured text limit and was not sniffed."],
    };
  }
  const result = detectImport({
    ...(source.originalBytes ? { bytes: source.originalBytes } : {}),
    ...(source.originalText !== undefined ? { text: source.originalText } : {}),
    fileName: source.filename,
  });
  return { ...result, sourceId: source.id };
}

function errorFrom(error: unknown, source: ImportSource): ImportError {
  const domain = error instanceof ImportFailureError
    ? error
    : new ImportFailureError(
      error instanceof Error ? error.message : "Importer failed with an unknown error.",
      "UNSUPPORTED_INPUT",
      source.id,
      source.sourcePath,
      error instanceof Error ? { cause: error } : undefined,
    );
  return {
    code: domain.code,
    message: domain.message,
    severity: "error",
    sourceId: domain.sourceId ?? source.id,
    sourceFilename: source.filename,
    sourcePath: domain.sourcePath ?? source.sourcePath,
  };
}

function warning(source: ImportSource, code: string, message: string): ImportWarning {
  return { code, message, sourceId: source.id, sourceFilename: source.filename, sourcePath: source.sourcePath };
}

function sourceExtension(filename?: string): string | undefined {
  const basename = filename?.split(/[\\/]/).pop();
  const index = basename?.lastIndexOf(".") ?? -1;
  return index >= 0 ? basename!.slice(index + 1).toLowerCase() : undefined;
}

function decodeTextSource(source: ImportSource, maximum: number): string {
  if (source.sizeBytes > maximum) {
    throw new ImportFailureError(`Text input is ${source.sizeBytes} bytes; limit is ${maximum} bytes.`, "INPUT_TOO_LARGE", source.id, source.sourcePath);
  }
  if (source.originalText !== undefined) return source.originalText;
  if (!source.originalBytes) throw new ImportFailureError("Text importer requires original bytes.", "UNSUPPORTED_INPUT", source.id, source.sourcePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes);
  } catch (error) {
    throw new ImportFailureError("Text input must be valid UTF-8.", "INVALID_DECKLIST", source.id, source.sourcePath, { cause: error });
  }
}

function hasCandidate(detection: ImportDetection, kind: ImportKind): ImportCandidate | undefined {
  return detection.candidates.find((candidate) => candidate.kind === kind);
}

function collectEntryAssets(entry: ImportedEntry): ImportedAsset[] {
  const assets: ImportedAsset[] = [];
  if (entry.asset) assets.push(entry.asset);
  if (entry.cardbackAsset) assets.push(entry.cardbackAsset);
  for (const face of entry.faces ?? []) assets.push(face.asset);
  if (entry.front) assets.push(entry.front.asset);
  if (entry.back) assets.push(entry.back.asset);
  return assets;
}

function pairingLabel(source: ImportSource): { readonly key?: string; readonly side?: "front" | "back" } {
  const relativePath = source.sourcePath ?? source.filename ?? "";
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const slash = normalizedPath.lastIndexOf("/");
  const folder = slash >= 0 ? normalizedPath.slice(0, slash) : "";
  const filename = slash >= 0 ? normalizedPath.slice(slash + 1) : normalizedPath;
  const dot = filename.lastIndexOf(".");
  const stem = (dot >= 0 ? filename.slice(0, dot) : filename).toLowerCase();
  const match = /^(.*?)[-_ ](front|back)$/.exec(stem);
  if (!match || !match[1]) return {};
  const group = source.parentSourceId ?? "multi-file-batch";
  return { key: `${group}/${folder.toLowerCase()}/${match[1]}`, side: match[2] as "front" | "back" };
}

function suggestPairings(entries: readonly ImportedEntry[], sources: readonly ImportSource[], warnings: ImportWarning[]): SuggestedAssetPairing[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const groups = new Map<string, { fronts: ImportedAsset[]; backs: ImportedAsset[]; paths: string[] }>();
  for (const entry of entries) {
    if (!entry.asset) continue;
    const source = sourceById.get(entry.sourceId);
    if (!source || !["file", "folder-file", "zip-entry"].includes(source.kind)) continue;
    const label = pairingLabel(source);
    if (!label.key || !label.side) continue;
    const group = groups.get(label.key) ?? { fronts: [], backs: [], paths: [] };
    group[label.side === "front" ? "fronts" : "backs"].push(entry.asset);
    group.paths.push(source.sourcePath ?? source.filename ?? entry.sourceId);
    groups.set(label.key, group);
  }
  const pairings: SuggestedAssetPairing[] = [];
  for (const group of groups.values()) {
    if (group.fronts.length === 1 && group.backs.length === 1) {
      pairings.push({
        frontAssetId: group.fronts[0].id,
        backAssetId: group.backs[0].id,
        confidence: 0.99,
        reason: "Basenames share the same directory and an explicit front/back suffix.",
        accepted: false,
      });
    } else if (group.fronts.length > 0 && group.backs.length > 0) {
      warnings.push({
        code: "AMBIGUOUS_ASSET_PAIRING",
        message: `Multiple assets share the same front/back basename key (${group.paths.join(", ")}); no pair was selected.`,
      });
    }
  }
  return pairings;
}

function buildReport(
  detections: readonly ImportDetection[],
  entries: readonly ImportedEntry[],
  warnings: readonly ImportWarning[],
  errors: readonly ImportError[],
  mappings: readonly ImportMapping[],
  pairings: readonly SuggestedAssetPairing[],
  selectedImporters: readonly { readonly sourceId: string; readonly kind: ImportKind }[],
): ImportReport {
  const assets = new Map(entries.flatMap(collectEntryAssets).map((asset) => [asset.id, asset]));
  return {
    summary: {
      totalInputs: detections.length,
      recognizedInputs: detections.filter((detection) => detection.selected && detection.selected.kind !== "unknown").length,
      recognizedEntries: entries.length,
      customCards: entries.filter((entry) => entry.kind === "custom-card").length,
      deckEntries: entries.filter((entry) => entry.kind === "deck-card").length,
      assets: assets.size,
      warnings: warnings.length,
      errors: errors.length,
      ambiguousDetections: detections.filter((detection) => detection.status === "ambiguous").length,
      unknownInputs: detections.filter((detection) => detection.status === "unknown").length,
    },
    selectedImporters,
    detections,
    warnings,
    errors,
    mappings,
    pairings,
  };
}

/** Creates a preview/report only. It performs no project writes or provider lookups. */
export async function importFiles(
  request: UniversalImportRequest,
  options: UniversalImportOptions = {},
): Promise<ImportResult> {
  const limits = resolveImportLimits(options.limits);
  const inputFiles = request.files ?? [];
  const roots: ImportSource[] = inputFiles.map((file, index) => fileSource(file, index));
  if (request.text !== undefined) roots.push(pastedSource(request.text, request.textFilename, roots.length));
  const detections: ImportDetection[] = [];
  const allSources = [...roots];
  const entries: ImportedEntry[] = [];
  const warnings: ImportWarning[] = [];
  const errors: ImportError[] = [];
  const mappings: ImportMapping[] = [];
  const selectedImporters: Array<{ readonly sourceId: string; readonly kind: ImportKind }> = [];

  const importOne = async (source: ImportSource): Promise<void> => {
    if (options.signal?.aborted) throw new ImportCancelledError(source.id);
    let currentSource = source;
    const isZipBySignature = source.originalBytes?.[0] === 0x50 && source.originalBytes?.[1] === 0x4b;
    const detection = candidateDetection(source, isZipBySignature ? limits.maxZipArchiveBytes : limits.maxInputBytes, limits.maxTextBytes);
    const requestedKind = request.selections?.[source.id];
    const selectedCandidate = requestedKind ? hasCandidate(detection, requestedKind) : detection.selected;
    let finalDetection: ImportDetection = detection;
    if (requestedKind && selectedCandidate) {
      finalDetection = { ...detection, selected: selectedCandidate, status: "user-selected", reasons: [...detection.reasons, `Importer ${requestedKind} was selected for this source.`] };
    } else if (requestedKind && !selectedCandidate) {
      errors.push(errorFrom(new ImportFailureError(`Selected importer ${requestedKind} is not a detected candidate for this input.`, "FORMAT_MISMATCH", source.id, source.sourcePath), source));
    }
    detections.push(finalDetection);
    const candidate = requestedKind ? selectedCandidate : detection.selected;
    const kind = candidate?.kind ?? (detection.status === "unknown" ? "unknown" : undefined);
    if (kind) selectedImporters.push({ sourceId: source.id, kind });
    const originalFormat = candidate?.originalFormat
      ?? (candidate?.kind === "url" ? "url" : sourceExtension(source.filename) ?? candidate?.kind);
    if (originalFormat) {
      currentSource = { ...source, originalFormat };
      const sourceIndex = allSources.findIndex((candidateSource) => candidateSource.id === source.id);
      if (sourceIndex >= 0) allSources[sourceIndex] = currentSource;
    }

    const sizeLimit = source.kind === "text" ? limits.maxTextBytes : isZipBySignature ? limits.maxZipArchiveBytes : limits.maxInputBytes;
    if (source.sizeBytes > sizeLimit) {
      const code = isZipBySignature ? "ZIP_SIZE_LIMIT" : "INPUT_TOO_LARGE";
      const label = isZipBySignature ? "ZIP archive" : "Input";
      errors.push(errorFrom(new ImportFailureError(`${label} is ${source.sizeBytes} bytes; configured limit is ${sizeLimit}.`, code, source.id, source.sourcePath), currentSource));
      return;
    }
    if (requestedKind && !selectedCandidate) return;
    if (!candidate || candidate.kind === "unknown") {
      warnings.push(warning(currentSource, "UNKNOWN_INPUT", "Conteúdo não reconhecido; o material original permanece disponível para revisão."));
      return;
    }
    if (detection.status === "ambiguous" && !requestedKind) {
      warnings.push(warning(currentSource, "AMBIGUOUS_DETECTION", "Mais de um formato é plausível; selecione um importer antes de processar."));
      return;
    }
    if (candidate.kind === "url") {
      warnings.push(warning(currentSource, "URL_ADAPTER_DEFERRED", "URL detectada; adapters e fetch de sites ficam fora desta fase."));
      return;
    }
    if (candidate.kind !== "image" && candidate.kind !== "svg") {
      const mismatchReason = detection.reasons.find((reason) => /extensão \.\w+ diverge/i.test(reason));
      if (mismatchReason) warnings.push(warning(currentSource, "EXTENSION_MISMATCH", mismatchReason));
    }

    let importOutput: { entries: readonly ImportedEntry[]; warnings: readonly ImportWarning[]; mappings?: readonly ImportMapping[]; metadata?: Readonly<Record<string, unknown>> } | undefined;
    try {
      switch (candidate.kind) {
        case "image":
        case "svg": {
          const output = await importImageSource(currentSource, limits);
          importOutput = { entries: [output.entry], warnings: output.warnings };
          break;
        }
        case "simple-decklist":
        case "arena-like":
        case "mtgo-like":
        case "xmage-like":
        case "mwdeck-like":
          importOutput = parseTextImport(decodeTextSource(currentSource, limits.maxTextBytes), candidate.kind, currentSource);
          break;
        case "csv":
        case "tsv":
          importOutput = parseCsvImport(currentSource, request.csvMappings?.[source.id], candidate.kind === "tsv" ? "\t" : ",", limits);
          break;
        case "json":
          importOutput = parseJsonImport(currentSource, request.jsonMappings?.[source.id], limits);
          break;
        case "generic-xml":
          importOutput = importGenericXml(currentSource, limits);
          break;
        case "mpc-autofill-xml":
          importOutput = importMpcAutofillXml(currentSource, limits);
          break;
        case "zip": {
          if (source.kind !== "zip-entry") {
            const expansion = await expandZipSource(currentSource, options);
            errors.push(...expansion.errors);
            allSources.push(...expansion.sources);
          }
          break;
        }
      }
      if (importOutput) {
        entries.push(...importOutput.entries.map((entry) => ({ ...entry, order: entries.length })));
        warnings.push(...importOutput.warnings);
        if (importOutput.mappings) mappings.push(...importOutput.mappings);
        if (importOutput.metadata) {
          const index = allSources.findIndex((candidateSource) => candidateSource.id === source.id);
          if (index >= 0) allSources[index] = { ...currentSource, metadata: importOutput.metadata };
        }
      }
    } catch (error) {
      if (error instanceof ImportCancelledError) throw error;
      errors.push(errorFrom(error, currentSource));
    }
  };

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    await importOne(root);
    if (root.originalBytes && root.originalBytes[0] === 0x50 && root.originalBytes[1] === 0x4b) {
      const descendants = allSources
        .filter((source) => source.kind === "zip-entry" && source.id.startsWith(`${root.id}!/`))
        .sort((left, right) => left.order - right.order);
      for (const child of descendants) {
        if (!detections.some((detection) => detection.sourceId === child.id)) await importOne(child);
      }
    }
    if (options.signal?.aborted) throw new ImportCancelledError(root.id);
    options.onProgress?.({ phase: "input", completed: index + 1, total: roots.length, sourceId: root.id, sourcePath: root.sourcePath });
    if (options.signal?.aborted) throw new ImportCancelledError(root.id);
  }

  const pairings = suggestPairings(entries, allSources, warnings);
  const report = buildReport(detections, entries, warnings, errors, mappings, pairings, selectedImporters);
  return { sources: allSources, detections, entries, report };
}
