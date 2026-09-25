import { randomUUID } from "node:crypto";
import { mpcArtworkCandidateId } from "./ids";
import type { ImportedAsset, ImportedEntry, ImportResult, ImportedFace } from "../../import-engine/types";
import type { CardFace, CardFaceSide, SelectedArtwork, WorkingCard, WorkingCardMpcReference } from "./types";

export interface CreateWorkingSetOptions {
  readonly idFactory?: (entry: ImportedEntry, index: number) => string;
}

function sideAsset(entry: ImportedEntry, side: CardFaceSide): ImportedFace | undefined {
  const explicit = side === "front" ? entry.front : entry.back;
  return explicit ?? entry.faces?.find((face) => face.side === side);
}

function allImportedAssets(entry: ImportedEntry): readonly ImportedAsset[] {
  return [
    ...(entry.asset ? [entry.asset] : []),
    ...(entry.cardbackAsset ? [entry.cardbackAsset] : []),
    ...(entry.front ? [entry.front.asset] : []),
    ...(entry.back ? [entry.back.asset] : []),
    ...(entry.faces ?? []).map((face) => face.asset),
  ];
}

function createFaces(entry: ImportedEntry): readonly CardFace[] {
  const faces: CardFace[] = [];
  for (const side of ["front", "back"] as const) {
    const imported = sideAsset(entry, side);
    if (imported) {
      faces.push({
        id: side,
        side,
        ...(imported.name ? { name: imported.name } : {}),
        importedAssetId: imported.asset.id,
        ...(imported.slots ? { slots: [...imported.slots] } : {}),
      });
    }
  }
  if (!faces.length && entry.asset) {
    faces.push({ id: "front", side: "front", importedAssetId: entry.asset.id });
  }
  if (!faces.length) {
    faces.push({ id: "front", side: "front", ...(entry.cardHint?.name ?? entry.nameSuggestion ? { name: entry.cardHint?.name ?? entry.nameSuggestion } : {}) });
  }
  return faces;
}

function selectedForImportedAsset(
  imported: ImportedFace | undefined,
  asset: ImportedAsset | undefined,
  side: CardFaceSide,
): SelectedArtwork | undefined {
  if (!asset) return undefined;
  const providerAssetId = imported?.providerAssetId ?? asset.providerAssetId;
  const selectedArtworkId = imported?.selectedArtworkId ?? asset.selectedArtworkId;
  if (asset.originalBytes) {
    return { candidateId: asset.id, source: "upload", identityId: null, faceId: side };
  }
  if (providerAssetId || selectedArtworkId || asset.originalFormat === "mpc-reference") {
    return {
      candidateId: mpcArtworkCandidateId(asset.id, side),
      source: "mpc",
      identityId: null,
      faceId: side,
      ...(providerAssetId ? { providerAssetId } : {}),
      ...(selectedArtworkId ? { selectedArtworkId } : {}),
    };
  }
  return undefined;
}

function getSelectedByFace(entry: ImportedEntry): WorkingCard["selectedArtworkByFace"] {
  const front = selectedForImportedAsset(sideAsset(entry, "front"), entry.front?.asset ?? entry.faces?.find((face) => face.side === "front")?.asset ?? entry.asset, "front");
  const back = selectedForImportedAsset(sideAsset(entry, "back"), entry.back?.asset ?? entry.faces?.find((face) => face.side === "back")?.asset, "back");
  return {
    ...(front ? { front } : {}),
    ...(back ? { back } : {}),
  };
}

function mpcReferences(entry: ImportedEntry): readonly WorkingCardMpcReference[] {
  const refs: WorkingCardMpcReference[] = [];
  for (const side of ["front", "back"] as const) {
    const imported = sideAsset(entry, side);
    if (!imported) continue;
    const providerAssetId = imported.providerAssetId ?? imported.asset.providerAssetId;
    const selectedArtworkId = imported.selectedArtworkId ?? imported.asset.selectedArtworkId;
    if (!providerAssetId && !selectedArtworkId && imported.asset.originalFormat !== "mpc-reference") continue;
    refs.push({
      faceId: side,
      importedAssetId: imported.asset.id,
      ...(providerAssetId ? { providerAssetId } : {}),
      ...(selectedArtworkId ? { selectedArtworkId } : {}),
      slots: [...(imported.slots ?? entry.slots ?? [])],
      availableLocally: imported.asset.originalBytes !== undefined,
    });
  }
  if (!refs.length && entry.asset && (entry.asset.providerAssetId || entry.asset.selectedArtworkId || entry.asset.originalFormat === "mpc-reference")) {
    refs.push({
      faceId: "front",
      importedAssetId: entry.asset.id,
      ...(entry.asset.providerAssetId ? { providerAssetId: entry.asset.providerAssetId } : {}),
      ...(entry.asset.selectedArtworkId ? { selectedArtworkId: entry.asset.selectedArtworkId } : {}),
      slots: [...(entry.slots ?? [])],
      availableLocally: entry.asset.originalBytes !== undefined,
    });
  }
  return refs;
}

function sharedMpcCardback(entry: ImportedEntry): WorkingCard["sharedMpcCardback"] {
  const asset = entry.cardbackAsset;
  if (!asset) return undefined;
  return {
    importedAssetId: asset.id,
    ...(asset.providerAssetId ? { providerAssetId: asset.providerAssetId } : {}),
    ...(asset.selectedArtworkId ? { selectedArtworkId: asset.selectedArtworkId } : {}),
    originalFormat: asset.originalFormat,
    availableLocally: asset.originalBytes !== undefined,
    provenance: {
      sourceId: asset.sourceId,
      ...(asset.sourceFilename ? { sourceFilename: asset.sourceFilename } : {}),
    },
  };
}

export function createWorkingSet(result: ImportResult, options: CreateWorkingSetOptions = {}): WorkingCard[] {
  return result.entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.order - b.entry.order || a.index - b.index)
    .map(({ entry, index }) => {
      const hint = entry.cardHint;
      const query = hint?.name ?? entry.nameSuggestion;
      const isCustom = entry.kind === "custom-card" || entry.kind === "asset";
      const identityResolution: WorkingCard["identityResolution"] = {
        status: isCustom ? "custom" : "unresolved",
        ...(query ? { query } : {}),
        candidates: [],
        confirmed: false,
      };
      return {
        id: options.idFactory?.(entry, index) ?? randomUUID(),
        quantity: entry.quantity,
        order: entry.order,
        ...(entry.section ?? hint?.section ? { section: entry.section ?? hint?.section } : {}),
        importSource: {
          sourceId: entry.sourceId,
          ...(entry.sourceFilename ? { filename: entry.sourceFilename } : {}),
          importKind: typeof entry.metadata?.parser === "string" ? entry.metadata.parser : entry.kind,
          entryKind: entry.kind,
        },
        identityHints: {
          ...(hint?.name ? { name: hint.name } : query ? { name: query } : {}),
          ...(hint?.setCode ? { setCode: hint.setCode } : {}),
          ...(hint?.collectorNumber ? { collectorNumber: hint.collectorNumber } : {}),
          ...(hint?.scryfallId ? { scryfallId: hint.scryfallId } : {}),
          ...(hint?.language ? { language: hint.language } : {}),
        },
        identity: null,
        identityResolution,
        faces: createFaces(entry),
        selectedArtworkByFace: getSelectedByFace(entry),
        localArtworkIds: [...new Set(allImportedAssets(entry).filter((asset) => asset.originalBytes).map((asset) => asset.id))],
        mpcReferences: mpcReferences(entry),
        ...(entry.cardbackAsset ? { sharedMpcCardback: sharedMpcCardback(entry) } : {}),
        faceAssociations: [
          ...(entry.faceAssociations ?? []).map((association) => ({ ...association })),
          ...result.report.pairings
            .filter((pairing) => pairing.frontAssetId === entry.asset?.id)
            .map((pairing) => ({
              slot: "folder-pair",
              frontAssetId: pairing.frontAssetId,
              backAssetId: pairing.backAssetId,
              confidence: pairing.confidence,
              reason: pairing.reason,
              accepted: pairing.accepted,
            })),
        ],
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      } satisfies WorkingCard;
    });
}

export function selectArtwork(card: WorkingCard, side: CardFaceSide, artwork: SelectedArtwork): WorkingCard {
  if (artwork.faceId !== side) throw new Error(`Artwork face ${artwork.faceId} does not match selected face ${side}.`);
  if (!card.faces.some((face) => face.side === side)) throw new Error(`Working card ${card.id} has no ${side} face.`);
  return {
    ...card,
    selectedArtworkByFace: { ...card.selectedArtworkByFace, [side]: artwork },
  };
}
