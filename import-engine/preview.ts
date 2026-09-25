import type { ImportPreview, ImportPreviewAsset, ImportPreviewEntry, ImportPreviewFace, ImportResult, ImportedAsset, ImportedEntry, ImportedFace } from "./types";

function previewAsset(asset: ImportedAsset): ImportPreviewAsset {
  const { originalBytes: _originalBytes, ...metadata } = asset;
  return metadata;
}

function previewFace(face: ImportedFace): ImportPreviewFace {
  return { ...face, asset: previewAsset(face.asset) };
}

function previewEntry(entry: ImportedEntry): ImportPreviewEntry {
  return {
    ...entry,
    ...(entry.asset ? { asset: previewAsset(entry.asset) } : {}),
    ...(entry.cardbackAsset ? { cardbackAsset: previewAsset(entry.cardbackAsset) } : {}),
    ...(entry.front ? { front: previewFace(entry.front) } : {}),
    ...(entry.back ? { back: previewFace(entry.back) } : {}),
    ...(entry.faces ? { faces: entry.faces.map(previewFace) } : {}),
  };
}

/** Removes binary source and asset bytes while retaining a JSON-safe preview and report. */
export function toImportPreview(result: ImportResult): ImportPreview {
  return {
    sources: result.sources.map((source) => {
      const { originalBytes: _originalBytes, originalText: _originalText, ...metadata } = source;
      return metadata;
    }),
    detections: result.detections,
    entries: result.entries.map(previewEntry),
    report: result.report,
  };
}
