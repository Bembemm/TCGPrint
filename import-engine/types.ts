export type ImportKind =
  | "image"
  | "svg"
  | "simple-decklist"
  | "arena-like"
  | "mtgo-like"
  | "xmage-like"
  | "mwdeck-like"
  | "csv"
  | "tsv"
  | "json"
  | "generic-xml"
  | "mpc-autofill-xml"
  | "zip"
  | "url"
  | "unknown";

export type ImportSourceKind = "file" | "folder-file" | "text" | "clipboard" | "zip-entry" | "url";
export type ImportDetectionStatus = "auto-selected" | "user-selected" | "ambiguous" | "unknown";
export type ImportedEntryKind = "deck-card" | "custom-card" | "asset" | "mpc-order-card" | "document";
export type ImportedFaceSide = "front" | "back";

export interface ImportSource {
  readonly id: string;
  readonly kind: ImportSourceKind;
  readonly filename?: string;
  /** Path relative to a selected folder or ZIP; never used as a filesystem destination. */
  readonly sourcePath?: string;
  readonly parentSourceId?: string;
  readonly order: number;
  readonly originalFormat?: string;
  readonly mediaType?: string;
  readonly sizeBytes: number;
  /** Exact caller supplied file bytes. They are never normalized or re-encoded. */
  readonly originalBytes?: Uint8Array;
  /** Exact caller supplied text for clipboard/paste inputs. */
  readonly originalText?: string;
  readonly sha256?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ImportCandidate {
  readonly kind: ImportKind;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly originalFormat?: string;
}

export interface ImportDetection {
  readonly sourceId?: string;
  readonly status: ImportDetectionStatus;
  readonly candidates: readonly ImportCandidate[];
  readonly selected?: ImportCandidate;
  readonly reasons: readonly string[];
}

export interface ImportedCardHint {
  readonly name?: string;
  readonly setCode?: string;
  readonly collectorNumber?: string;
  readonly scryfallId?: string;
  readonly imageUrl?: string;
  readonly language?: string;
  readonly section?: string;
}

export interface ImportedAsset {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceFilename?: string;
  readonly sourcePath?: string;
  readonly originalFormat: string;
  readonly mediaType?: string;
  readonly sha256?: string;
  readonly widthPx?: number;
  readonly heightPx?: number;
  /** Present only when the user supplied bytes. MPC references never trigger a download. */
  readonly originalBytes?: Uint8Array;
  readonly providerAssetId?: string;
  readonly selectedArtworkId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ImportedFace {
  readonly side: ImportedFaceSide;
  readonly asset: ImportedAsset;
  readonly providerAssetId?: string;
  readonly selectedArtworkId?: string;
  readonly name?: string;
  readonly query?: string;
  readonly slots?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ImportedFaceAssociation {
  readonly slot: string;
  readonly frontAssetId?: string;
  readonly backAssetId?: string;
}

export interface ImportedEntry {
  readonly id: string;
  readonly kind: ImportedEntryKind;
  readonly order: number;
  readonly quantity: number;
  readonly sourceId: string;
  readonly sourceFilename?: string;
  readonly sourcePath?: string;
  readonly cardHint?: ImportedCardHint;
  /** A suggested label is not a resolved card identity. */
  readonly nameSuggestion?: string;
  readonly section?: string;
  readonly asset?: ImportedAsset;
  readonly cardbackAsset?: ImportedAsset;
  readonly front?: ImportedFace;
  readonly back?: ImportedFace;
  readonly faces?: readonly ImportedFace[];
  readonly faceAssociations?: readonly ImportedFaceAssociation[];
  readonly slots?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ImportWarning {
  readonly code: string;
  readonly message: string;
  readonly sourceId?: string;
  readonly sourceFilename?: string;
  readonly sourcePath?: string;
  readonly line?: number;
  readonly field?: string;
}

export interface ImportError extends ImportWarning {
  readonly severity: "error";
}

export interface ImportProgress {
  readonly phase: "input" | "zip-entry" | "parse" | "pairing";
  readonly completed: number;
  readonly total: number;
  readonly sourceId?: string;
  readonly sourcePath?: string;
  readonly message?: string;
}

export interface ImportMapping {
  readonly sourceId: string;
  readonly format: "csv" | "tsv" | "json";
  readonly fields: Readonly<Record<string, string | number | undefined>>;
  readonly unknownFields: readonly string[];
}

export interface SuggestedAssetPairing {
  readonly frontAssetId: string;
  readonly backAssetId: string;
  readonly confidence: number;
  readonly reason: string;
  readonly accepted: false;
}

export interface ImportReportSummary {
  readonly totalInputs: number;
  readonly recognizedInputs: number;
  readonly recognizedEntries: number;
  readonly customCards: number;
  readonly deckEntries: number;
  readonly assets: number;
  readonly warnings: number;
  readonly errors: number;
  readonly ambiguousDetections: number;
  readonly unknownInputs: number;
}

export interface ImportReport {
  readonly summary: ImportReportSummary;
  readonly selectedImporters: readonly { readonly sourceId: string; readonly kind: ImportKind }[];
  readonly detections: readonly ImportDetection[];
  readonly warnings: readonly ImportWarning[];
  readonly errors: readonly ImportError[];
  readonly mappings: readonly ImportMapping[];
  readonly pairings: readonly SuggestedAssetPairing[];
}

export interface ImportResult {
  readonly sources: readonly ImportSource[];
  readonly detections: readonly ImportDetection[];
  readonly entries: readonly ImportedEntry[];
  readonly report: ImportReport;
}

export type ImportPreviewSource = Omit<ImportSource, "originalBytes" | "originalText">;
export type ImportPreviewAsset = Omit<ImportedAsset, "originalBytes">;
export type ImportPreviewFace = Omit<ImportedFace, "asset"> & { readonly asset: ImportPreviewAsset };
export type ImportPreviewEntry = Omit<ImportedEntry, "asset" | "cardbackAsset" | "front" | "back" | "faces"> & {
  readonly asset?: ImportPreviewAsset;
  readonly cardbackAsset?: ImportPreviewAsset;
  readonly front?: ImportPreviewFace;
  readonly back?: ImportPreviewFace;
  readonly faces?: readonly ImportPreviewFace[];
};

/** Serializable review DTO; source and asset bytes remain with the caller. */
export interface ImportPreview {
  readonly sources: readonly ImportPreviewSource[];
  readonly detections: readonly ImportDetection[];
  readonly entries: readonly ImportPreviewEntry[];
  readonly report: ImportReport;
}

export interface ImportDetectionInput {
  readonly bytes?: Uint8Array;
  readonly text?: string;
  readonly fileName?: string;
}

export interface JsonImportMapping {
  /** Optional array path such as `cards`; values may also use full paths containing `[]`. */
  readonly collectionPath?: string;
  readonly name?: string;
  readonly quantity?: string;
  readonly setCode?: string;
  readonly collectorNumber?: string;
  readonly scryfallId?: string;
  readonly imageUrl?: string;
  readonly language?: string;
  readonly section?: string;
}

export interface CsvImportMapping {
  readonly name?: string | number;
  readonly quantity?: string | number;
  readonly setCode?: string | number;
  readonly collectorNumber?: string | number;
  readonly scryfallId?: string | number;
  readonly imageUrl?: string | number;
  readonly language?: string | number;
}

export interface ImportFileInput {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly sourcePath?: string;
  readonly kind?: "file" | "folder-file";
}

export interface UniversalImportRequest {
  readonly files?: readonly ImportFileInput[];
  readonly text?: string;
  readonly textFilename?: string;
  readonly selections?: Readonly<Record<string, ImportKind>>;
  readonly csvMappings?: Readonly<Record<string, CsvImportMapping>>;
  readonly jsonMappings?: Readonly<Record<string, JsonImportMapping>>;
}

export interface ImportLimits {
  readonly maxInputBytes: number;
  readonly maxRasterPixels: number;
  readonly maxSvgBytes: number;
  readonly maxTextBytes: number;
  readonly maxCsvBytes: number;
  readonly maxCsvRows: number;
  readonly maxJsonBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxXmlBytes: number;
  readonly maxXmlDepth: number;
  readonly maxXmlNodes: number;
  readonly maxZipArchiveBytes: number;
  readonly maxZipEntries: number;
  readonly maxZipEntryBytes: number;
  readonly maxZipTotalUncompressedBytes: number;
  readonly maxZipCompressionRatio: number;
  readonly maxZipNestingDepth: number;
}

export interface UniversalImportOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImportProgress) => void;
  readonly limits?: Partial<ImportLimits>;
}
