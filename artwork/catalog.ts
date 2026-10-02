import type { CardIdentity } from "../core/cards/types";
import type { ArtworkCandidate } from "../core/cards/types";
import { ArtworkStorageError } from "./storage/types";
import type { ArtworkCatalogSearchOptions, ArtworkProvider, ProviderHealth } from "./types";
import type { MpcArtworkFilterInput, MpcFilterCatalogs } from "./mpc-contract";
import { MpcArtworkFilterValidationError } from "./mpc-contract";
import type { MpcArtworkProviderDiagnostic } from "./mpc-provider";

interface MpcArtworkProviderExtension extends ArtworkProvider {
  searchArtworkAdvanced(identity: CardIdentity, options: ArtworkCatalogSearchOptions & { readonly filters?: MpcArtworkFilterInput }): Promise<readonly ArtworkCandidate[]>;
  getFilterCatalogs(signal?: AbortSignal): Promise<MpcFilterCatalogs>;
  getDiagnostic(): MpcArtworkProviderDiagnostic;
  refreshCandidate(id: string, signal?: AbortSignal): Promise<ArtworkCandidate | undefined>;
}

export interface AdvancedArtworkCatalogSearchOptions extends ArtworkCatalogSearchOptions {
  readonly mpcFilters?: MpcArtworkFilterInput;
}

function mpcExtension(provider: ArtworkProvider | undefined): MpcArtworkProviderExtension | undefined {
  if (!provider || provider.source !== "mpc") return undefined;
  const extension = provider as Partial<MpcArtworkProviderExtension>;
  return typeof extension.searchArtworkAdvanced === "function"
    && typeof extension.getFilterCatalogs === "function"
    && typeof extension.getDiagnostic === "function"
    && typeof extension.refreshCandidate === "function"
    ? extension as MpcArtworkProviderExtension
    : undefined;
}

export class ArtworkCatalog {
  private readonly providers: ReadonlyMap<string, ArtworkProvider>;
  private readonly health = new Map<string, ProviderHealth>();

  constructor(providers: readonly ArtworkProvider[]) {
    this.providers = new Map(providers.map((provider) => [provider.source, provider]));
    for (const provider of providers) this.health.set(provider.source, { available: true, degraded: false });
  }

  async search(identity: CardIdentity, options: AdvancedArtworkCatalogSearchOptions): Promise<readonly ArtworkCandidate[]> {
    const selectedProviders = options.source === "all"
      ? [...this.providers.values()]
      : [this.providers.get(options.source)].filter((provider): provider is ArtworkProvider => provider !== undefined);
    const results = await Promise.all(selectedProviders.map(async (provider) => {
      try {
        const standardOptions: ArtworkCatalogSearchOptions = {
          source: options.source,
          ...(options.faceId ? { faceId: options.faceId } : {}),
          ...(options.mpcReferences ? { mpcReferences: options.mpcReferences } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        };
        const extension = mpcExtension(provider);
        const candidates = extension
          ? await extension.searchArtworkAdvanced(identity, { ...standardOptions, filters: options.mpcFilters ?? {} })
          : await provider.searchArtwork(identity, standardOptions);
        this.health.set(provider.source, provider.getHealth?.() ?? { available: true, degraded: false });
        return candidates;
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError") || (error && typeof error === "object" && (error as { kind?: unknown }).kind === "aborted")) throw error;
        if (error instanceof MpcArtworkFilterValidationError) throw error;
        this.health.set(provider.source, {
          available: false,
          degraded: true,
          message: provider.source === "mpc" ? "MPC artwork provider is temporarily degraded." : error instanceof Error ? error.message : "Artwork provider failed.",
        });
        return [];
      }
    }));
    return results.flat();
  }

  getProviderHealth(): Readonly<Record<string, ProviderHealth>> {
    for (const provider of this.providers.values()) {
      const providerHealth = provider.getHealth?.();
      if (providerHealth?.degraded) this.health.set(provider.source, providerHealth);
    }
    return Object.fromEntries(this.health.entries());
  }

  async getMpcFilterCatalogs(signal?: AbortSignal): Promise<MpcFilterCatalogs> {
    const provider = mpcExtension(this.providers.get("mpc"));
    if (!provider) throw new Error("MPC filter catalogs are unavailable.");
    return provider.getFilterCatalogs(signal);
  }

  getMpcDiagnostic(): MpcArtworkProviderDiagnostic | undefined {
    return mpcExtension(this.providers.get("mpc"))?.getDiagnostic();
  }

  async refreshMpcCandidate(candidateId: string, signal?: AbortSignal): Promise<ArtworkCandidate | undefined> {
    const provider = mpcExtension(this.providers.get("mpc"));
    return provider?.refreshCandidate(candidateId, signal);
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
