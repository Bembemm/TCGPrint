import type { ArtworkCandidate, CardFaceSide, CardIdentity, WorkingCardMpcReference } from "../core/cards/types";
import { mpcArtworkCandidateId } from "../core/cards/ids";
import { ArtworkStorageError } from "./storage/types";
import type { ArtworkPreview, ArtworkProvider, ArtworkSearchOptions } from "./types";

export class MpcReferenceArtworkProvider implements ArtworkProvider {
  readonly source = "mpc" as const;
  private readonly references = new Map<string, ArtworkCandidate>();

  async searchArtwork(identity: CardIdentity, options: ArtworkSearchOptions = {}): Promise<readonly ArtworkCandidate[]> {
    const candidates = (options.mpcReferences ?? [])
      .filter((reference) => !options.faceId || reference.faceId === options.faceId)
      .map((reference) => {
        const candidate: ArtworkCandidate = {
          id: mpcArtworkCandidateId(reference.importedAssetId, reference.faceId as CardFaceSide),
          source: "mpc",
          identityId: identity.id,
          faceId: reference.faceId as CardFaceSide,
          originalAvailable: false,
          ...(reference.providerAssetId ? { providerAssetId: reference.providerAssetId } : {}),
          ...(reference.selectedArtworkId ? { selectedArtworkId: reference.selectedArtworkId } : {}),
          metadata: {
            referenceOnly: true,
            importedAssetId: reference.importedAssetId,
            selectedArtworkId: reference.selectedArtworkId,
            providerAssetId: reference.providerAssetId,
            slots: [...reference.slots],
          },
        };
        this.references.set(candidate.id, candidate);
        return candidate;
      });
    return candidates;
  }

  async getCandidate(id: string): Promise<ArtworkCandidate | undefined> {
    return this.references.get(id);
  }

  async getPreview(_id: string): Promise<ArtworkPreview | undefined> {
    return undefined;
  }

  async getOriginal(id: string): Promise<never> {
    throw new ArtworkStorageError("ARTWORK_MISSING", `MPC reference ${id} has no locally available original artwork.`);
  }
}
