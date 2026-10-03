import type {
  BackLibraryAssetReference,
  ArtworkCandidate,
  CardIdentity,
  SelectedArtwork,
  WorkingCard,
  WorkingCardBackMode,
} from "./types";

const DOUBLE_FACED_LAYOUTS = new Set([
  "transform",
  "modal_dfc",
  "double_faced_token",
  "reversible_card",
]);

export type EffectiveCardBack =
  | {
      readonly mode: "auto" | "manual" | "project-default";
      readonly status: "available";
      readonly source: "dfc-face" | "manual-artwork" | "manual-library" | "project-default";
      readonly artwork?: SelectedArtwork;
      readonly asset?: BackLibraryAssetReference;
    }
  | {
      readonly mode: "auto" | "manual" | "project-default";
      readonly status: "missing";
      readonly source: "dfc-face" | "manual-artwork" | "manual-library" | "project-default";
    }
  | {
      readonly mode: "none";
      readonly status: "intentional-none";
      readonly source: "none";
    };

/** Uses Scryfall's semantic layout as well as exactly two named provider faces. */
export function isDoubleFacedIdentity(identity: CardIdentity | null | undefined): boolean {
  if (!identity) return false;
  const layout = identity.metadata?.layout;
  const faces = identity.metadata?.faces;
  if (typeof layout !== "string" || !DOUBLE_FACED_LAYOUTS.has(layout) || !Array.isArray(faces) || faces.length !== 2) return false;
  return faces.every((face) => Boolean(face && typeof face === "object"
    && typeof (face as { name?: unknown }).name === "string"
    && (face as { name: string }).name.trim().length > 0));
}

/** A known non-DFC identity has no real back face; custom two-face entries remain selectable. */
export function isEligibleIdentityFaceSelection(card: WorkingCard, faceId: "front" | "back"): boolean {
  return faceId !== "back" || card.identity === null || isDoubleFacedIdentity(card.identity);
}

/** A generic physical back must be an MPC cardback document, never an ordinary card face. */
export function isEligibleGenericPhysicalBack(card: WorkingCard, candidate: ArtworkCandidate): boolean {
  return !isDoubleFacedIdentity(card.identity)
    && candidate.source === "mpc"
    && candidate.faceId === "back"
    && candidate.metadata?.cardType === "CARDBACK"
    && typeof candidate.providerAssetId === "string"
    && /^[A-Za-z0-9_-]{1,200}$/.test(candidate.providerAssetId);
}

export class BackSelectionPolicyError extends Error {
  constructor(message = "Only a verified MPC cardback can be selected as a generic physical back on a simple card.") {
    super(message);
    this.name = "BackSelectionPolicyError";
  }
}

/** Resolves mode and origin explicitly. MPC's shared order cardback is never an implicit source. */
export function resolveEffectiveCardBack(
  card: WorkingCard,
  projectDefault?: BackLibraryAssetReference | null,
): EffectiveCardBack {
  if (isDoubleFacedIdentity(card.identity)) {
    const artwork = card.faces.some((face) => face.side === "back") ? card.selectedArtworkByFace.back : undefined;
    return artwork
      ? { mode: "auto", status: "available", source: "dfc-face", artwork }
      : { mode: "auto", status: "missing", source: "dfc-face" };
  }
  if (card.backMode === "none") return { mode: "none", status: "intentional-none", source: "none" };
  if (card.backMode === "project-default") {
    return projectDefault
      ? { mode: "project-default", status: "available", source: "project-default", asset: projectDefault }
      : { mode: "project-default", status: "missing", source: "project-default" };
  }
  if (card.backMode === "manual") {
    if (card.manualBackAsset) return { mode: "manual", status: "available", source: "manual-library", asset: card.manualBackAsset };
    if (card.manualBackArtwork) return { mode: "manual", status: "available", source: "manual-artwork", artwork: card.manualBackArtwork };
    const artwork = card.selectedArtworkByFace.back;
    if (artwork && card.faces.some((face) => face.side === "back")) {
      return { mode: "manual", status: "available", source: "dfc-face", artwork };
    }
    return { mode: "manual", status: "missing", source: "manual-library" };
  }
  return { mode: "auto", status: "missing", source: "dfc-face" };
}

/** Applies the explicit missing-back fallback without replacing DFC faces, manual locks, or intentional blanks. */
export function fallbackToProjectDefaultBack(
  card: WorkingCard,
  effective: EffectiveCardBack,
  projectDefault?: BackLibraryAssetReference | null,
): EffectiveCardBack {
  if (!projectDefault || effective.status !== "missing" || effective.mode === "manual"
    || isDoubleFacedIdentity(card.identity)) return effective;
  return { mode: "project-default", status: "available", source: "project-default", asset: projectDefault };
}

/** Marks an explicit mode choice; selecting a print mode never changes artwork. */
export function setWorkingCardBackMode(card: WorkingCard, mode: WorkingCardBackMode): WorkingCard {
  if (isDoubleFacedIdentity(card.identity) && mode !== "auto") {
    throw new BackSelectionPolicyError("A double-faced card uses its real back face and cannot select a generic physical back mode.");
  }
  if (mode === "auto") return restoreAutomaticBackSelection(card);
  if (mode === "manual") {
    return { ...card, backMode: mode, backModeSelectionPolicy: "explicit" };
  }
  const { manualBackAsset: _manualBackAsset, manualBackArtwork: _manualBackArtwork, ...rest } = card;
  return { ...rest, backMode: mode, backModeSelectionPolicy: "explicit" };
}

export function selectManualBackLibraryAsset(
  card: WorkingCard,
  asset: BackLibraryAssetReference,
): WorkingCard {
  if (isDoubleFacedIdentity(card.identity)) {
    throw new BackSelectionPolicyError("A Back Library asset cannot replace a double-faced card's real back face.");
  }
  const { manualBackArtwork: _manualBackArtwork, ...withoutArtwork } = card;
  return {
    ...withoutArtwork,
    backMode: "manual",
    backModeSelectionPolicy: "explicit",
    manualBackAsset: asset,
  };
}

/** Assigns only a semantically verified MPC cardback to a simple card's physical back. */
export function selectManualBackArtwork(card: WorkingCard, candidate: ArtworkCandidate): WorkingCard {
  if (!isEligibleGenericPhysicalBack(card, candidate)) throw new BackSelectionPolicyError();
  const artwork: SelectedArtwork = {
    candidateId: candidate.id,
    source: "mpc",
    identityId: null,
    faceId: "back",
    ...(candidate.providerAssetId ? { providerAssetId: candidate.providerAssetId } : {}),
    ...(candidate.selectedArtworkId ? { selectedArtworkId: candidate.selectedArtworkId } : {}),
    selectionPolicy: "user-selected",
  };
  const { manualBackAsset: _manualBackAsset, ...withoutLibraryAsset } = card;
  return {
    ...withoutLibraryAsset,
    manualBackArtwork: artwork,
    backMode: "manual",
    backModeSelectionPolicy: "explicit",
  };
}

/** Explicitly clears a manual lock and returns to the face or Project default policy. */
export function restoreAutomaticBackSelection(card: WorkingCard): WorkingCard {
  if (isDoubleFacedIdentity(card.identity)) {
    return { ...card, backMode: "auto", backModeSelectionPolicy: "automatic" };
  }
  const selectedArtworkByFace = { ...card.selectedArtworkByFace };
  if (card.backMode === "manual" || selectedArtworkByFace.back?.selectionPolicy === "user-selected") delete selectedArtworkByFace.back;
  const { manualBackAsset: _manualBackAsset, manualBackArtwork: _manualBackArtwork, ...rest } = card;
  const isDfc = isDoubleFacedIdentity(card.identity);
  return {
    ...rest,
    backMode: isDfc ? "auto" : "project-default",
    backModeSelectionPolicy: "automatic",
    selectedArtworkByFace,
  };
}
