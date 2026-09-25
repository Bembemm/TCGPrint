import type { ArtworkCandidate, ArtworkSource, CardFaceSide, CardIdentity, WorkingCardMpcReference } from "../core/cards/types";
import type { ArtworkOriginal } from "./storage/types";

export type ArtworkCatalogSource = "all" | ArtworkSource;

export interface ArtworkPreview {
  readonly candidateId: string;
  readonly source: ArtworkSource;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface ProviderHealth {
  readonly available: boolean;
  readonly degraded: boolean;
  readonly message?: string;
}

export interface ArtworkSearchOptions {
  readonly faceId?: CardFaceSide;
  readonly mpcReferences?: readonly WorkingCardMpcReference[];
  readonly signal?: AbortSignal;
}

export interface ArtworkProvider {
  readonly source: "scryfall" | "upload" | "mpc";
  getHealth?(): ProviderHealth;
  searchArtwork(identity: CardIdentity, options?: ArtworkSearchOptions): Promise<readonly ArtworkCandidate[]>;
  getPreview(candidateId: string, signal?: AbortSignal): Promise<ArtworkPreview | undefined>;
  getOriginal(candidateId: string, signal?: AbortSignal): Promise<ArtworkOriginal>;
  getCandidate(candidateId: string): Promise<ArtworkCandidate | undefined>;
}

export interface ArtworkCatalogSearchOptions extends ArtworkSearchOptions {
  readonly source: ArtworkCatalogSource;
}
