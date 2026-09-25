import type { CardIdentity } from "../core/cards/types";
import type { ArtworkCandidate } from "../core/cards/types";
import { ArtworkStorageError } from "./storage/types";
import type { ArtworkCatalogSearchOptions, ArtworkProvider, ProviderHealth } from "./types";

export class ArtworkCatalog {
  private readonly providers: ReadonlyMap<string, ArtworkProvider>;
  private readonly health = new Map<string, ProviderHealth>();

  constructor(providers: readonly ArtworkProvider[]) {
    this.providers = new Map(providers.map((provider) => [provider.source, provider]));
    for (const provider of providers) this.health.set(provider.source, { available: true, degraded: false });
  }

  async search(identity: CardIdentity, options: ArtworkCatalogSearchOptions): Promise<readonly ArtworkCandidate[]> {
    const selectedProviders = options.source === "all"
      ? [...this.providers.values()]
      : [this.providers.get(options.source)].filter((provider): provider is ArtworkProvider => provider !== undefined);
    const results = await Promise.all(selectedProviders.map(async (provider) => {
      try {
        const candidates = await provider.searchArtwork(identity, options);
        this.health.set(provider.source, provider.getHealth?.() ?? { available: true, degraded: false });
        return candidates;
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError") || (error && typeof error === "object" && (error as { kind?: unknown }).kind === "aborted")) throw error;
        this.health.set(provider.source, { available: false, degraded: true, message: error instanceof Error ? error.message : "Artwork provider failed." });
        return [];
      }
    }));
    return results.flat();
  }

  getProviderHealth(): Readonly<Record<string, ProviderHealth>> {
    return Object.fromEntries(this.health.entries());
  }

  markProviderDegraded(source: "scryfall" | "upload" | "mpc", error: unknown): void {
    this.health.set(source, {
      available: false,
      degraded: true,
      message: error instanceof Error ? error.message.slice(0, 300) : "Artwork provider failed.",
    });
  }

  async getCandidate(candidateId: string): Promise<ArtworkCandidate | undefined> {
    const provider = this.providerFor(candidateId);
    return provider?.getCandidate(candidateId);
  }

  async getPreview(candidateId: string, signal?: AbortSignal) {
    const provider = this.providerFor(candidateId);
    return provider?.getPreview(candidateId, signal);
  }

  async getOriginal(candidateId: string, signal?: AbortSignal) {
    const provider = this.providerFor(candidateId);
    if (!provider) throw new ArtworkStorageError("ARTWORK_MISSING", "No artwork provider recognizes this candidate ID.");
    return provider.getOriginal(candidateId, signal);
  }

  private providerFor(candidateId: string): ArtworkProvider | undefined {
    const source = candidateId.slice(0, candidateId.indexOf(":"));
    return this.providers.get(source);
  }
}
