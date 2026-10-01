export type ArtworkSource = "scryfall" | "upload" | "mpc" | "url" | "custom";
export type CardFaceSide = "front" | "back";
export type WorkingCardBackMode = "auto" | "project-default" | "manual" | "none";
export type WorkingCardBackModeSelectionPolicy = "automatic" | "explicit";
export type IdentityResolutionStatus = "resolved" | "suggested" | "ambiguous" | "unresolved" | "custom";
export type IdentityResolutionMethod = "scryfall-id" | "set-collector" | "name" | "filename" | "ocr" | "fuzzy" | "manual" | "custom";

/** A logical card identity. Printing and artwork selection are modeled separately. */
export interface CardIdentity {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly scryfallId?: string;
  readonly oracleId?: string;
  readonly setCode?: string;
  readonly collectorNumber?: string;
  readonly lang?: string;
  readonly resolutionMethod: IdentityResolutionMethod;
  readonly confidence: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CardFace {
  readonly id: string;
  readonly side: CardFaceSide;
  readonly name?: string;
  readonly importedAssetId?: string;
  readonly slots?: readonly string[];
}

export interface ArtworkCandidate {
  readonly id: string;
  readonly source: ArtworkSource;
  readonly identityId: string | null;
  readonly faceId: string;
  readonly faceName?: string;
  readonly previewUri?: string;
  readonly originalUri?: string;
  readonly localOriginalPath?: string;
  readonly providerAssetId?: string;
  readonly selectedArtworkId?: string;
  readonly scryfallId?: string;
  readonly oracleId?: string;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly effectiveDpi?: number;
  readonly setCode?: string;
  readonly collectorNumber?: string;
  readonly language?: string;
  readonly releasedAt?: string;
  readonly originalAvailable: boolean;
  /** True only when validated original bytes exist in the local content-addressed store. */
  readonly originalCached?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SelectedArtwork {
  readonly candidateId: string;
  readonly source: ArtworkSource;
  readonly identityId: string | null;
  readonly faceId: string;
  readonly providerAssetId?: string;
  readonly selectedArtworkId?: string;
  readonly selectionPolicy?: string;
}

/** Immutable, path-free reference to a validated generic cardback in Back Library. */
export interface BackLibraryAssetReference {
  readonly assetId: string;
  readonly sha256: string;
  readonly format: "jpeg" | "png";
}

export interface IdentityResolutionCandidate {
  readonly identity: CardIdentity;
  readonly score: number;
  readonly reason: string;
}

export interface IdentityResolution {
  readonly status: IdentityResolutionStatus;
  readonly method?: IdentityResolutionMethod;
  readonly query?: string;
  readonly confidence?: number;
  readonly candidates: readonly IdentityResolutionCandidate[];
  readonly confirmed: boolean;
}

export interface WorkingCardImportSource {
  readonly sourceId: string;
  readonly filename?: string;
  readonly importKind: string;
  readonly entryKind: string;
}

export interface WorkingCardMpcReference {
  readonly faceId: string;
  readonly importedAssetId: string;
  readonly providerAssetId?: string;
  readonly selectedArtworkId?: string;
  readonly referenceOrigin?: "order-import" | "gallery-selection";
  readonly slots: readonly string[];
  readonly availableLocally: boolean;
}

/** Shared MPC order cardback reference; it is independent from the card's DFC back face. */
export interface WorkingCardSharedMpcCardback {
  readonly importedAssetId: string;
  readonly providerAssetId?: string;
  readonly selectedArtworkId?: string;
  readonly originalFormat: string;
  readonly availableLocally: boolean;
  readonly provenance: {
    readonly sourceId: string;
    readonly sourceFilename?: string;
  };
}

/** One imported entry. Copies stay represented by quantity until PDF composition. */
export interface WorkingCard {
  readonly id: string;
  readonly quantity: number;
  readonly order: number;
  readonly section?: string;
  readonly importSource: WorkingCardImportSource;
  readonly identityHints: {
    readonly name?: string;
    readonly setCode?: string;
    readonly collectorNumber?: string;
    readonly scryfallId?: string;
    readonly language?: string;
  };
  readonly identity: CardIdentity | null;
  readonly identityResolution: IdentityResolution;
  readonly faces: readonly CardFace[];
  readonly selectedArtworkByFace: Readonly<Partial<Record<CardFaceSide, SelectedArtwork>>>;
  /** Explicit source policy for this card's effective physical back. */
  readonly backMode: WorkingCardBackMode;
  /** Explicit user/import choice remains stable when identity metadata is refreshed. */
  readonly backModeSelectionPolicy: WorkingCardBackModeSelectionPolicy;
  /** Only used when backMode is manual and the cardback is a generic library asset. */
  readonly manualBackAsset?: BackLibraryAssetReference;
  /** Provider artwork assigned to the physical back. Its faceId records the artwork's source face; it does not add an identity face. */
  readonly manualBackArtwork?: SelectedArtwork;
  readonly localArtworkIds: readonly string[];
  readonly mpcReferences: readonly WorkingCardMpcReference[];
  readonly sharedMpcCardback?: WorkingCardSharedMpcCardback;
  readonly faceAssociations: readonly {
    readonly slot: string;
    readonly frontAssetId?: string;
    readonly backAssetId?: string;
    readonly confidence?: number;
    readonly reason?: string;
    readonly accepted?: boolean;
  }[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}
