export type ArtworkSource = "scryfall" | "upload" | "mpc" | "url" | "custom";
export type CardFaceSide = "front" | "back";
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
