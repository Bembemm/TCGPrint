import type { CardIdentity } from "../core/cards/types";
import type { ArtworkCandidate } from "../core/cards/types";
import { ArtworkStorageError } from "./storage/types";
import type { ArtworkCatalogSearchOptions, ArtworkCatalogSearchResult, ArtworkProvider, ProviderHealth } from "./types";
import type { MpcArtworkFilterInput, MpcFilterCatalogs } from "./mpc-contract";
import { MpcArtworkFilterValidationError } from "./mpc-contract";
import type { MpcArtworkProviderDiagnostic, MpcCandidateRevalidationResult } from "./mpc-provider";

interface MpcArtworkProviderExtension extends ArtworkProvider {
  searchArtworkAdvanced(identity: CardIdentity, options: ArtworkCatalogSearchOptions & { readonly filters?: MpcArtworkFilterInput; readonly forceRefresh?: boolean }): Promise<readonly ArtworkCandidate[]>;
  searchArtworkAdvancedWithTotal?(identity: CardIdentity, options: ArtworkCatalogSearchOptions & { readonly filters?: MpcArtworkFilterInput; readonly forceRefresh?: boolean }): Promise<ArtworkCatalogSearchResult>;
  getFilterCatalogs(signal?: AbortSignal): Promise<MpcFilterCatalogs>;
  getDiagnostic(): MpcArtworkProviderDiagnostic;
  refreshCandidate(id: string, signal?: AbortSignal): Promise<ArtworkCandidate | undefined>;
  revalidateCandidates?(ids: readonly string[], signal?: AbortSignal): Promise<readonly MpcCandidateRevalidationResult[]>;
}

const MPC_DEGRADED_MESSAGE = "MPC artwork provider is temporarily degraded.";

function publicProviderHealth(source: string, health: ProviderHealth): ProviderHealth {
  if (source !== "mpc") return health;
  return {
    available: health.available,
    degraded: health.degraded,
    ...(health.degraded ? { message: MPC_DEGRADED_MESSAGE } : {}),
  };
}

export interface AdvancedArtworkCatalogSearchOptions extends ArtworkCatalogSearchOptions {
  readonly mpcFilters?: MpcArtworkFilterInput;
  readonly forceMpcRefresh?: boolean;
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
  private readonly healthOverrides = new Set<string>();
  private readonly providerReportedDegraded = new Set<string>();

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
          ...(options.offset !== undefined ? { offset: options.offset } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        };
        const extension = mpcExtension(provider);
        const candidates = extension
          ? await extension.searchArtworkAdvanced(identity, { ...standardOptions, filters: options.mpcFilters ?? {}, ...(options.forceMpcRefresh ? { forceRefresh: true } : {}) })
          : await provider.searchArtwork(identity, standardOptions);
        this.healthOverrides.delete(provider.source);
        this.providerReportedDegraded.delete(provider.source);
        this.health.set(provider.source, publicProviderHealth(provider.source, provider.getHealth?.() ?? { available: true, degraded: false }));
        return candidates;
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError") || (error && typeof error === "object" && (error as { kind?: unknown }).kind === "aborted")) throw error;
        if (error instanceof MpcArtworkFilterValidationError) throw error;
        this.healthOverrides.add(provider.source);
        if (provider.getHealth?.().degraded) this.providerReportedDegraded.add(provider.source);
        this.health.set(provider.source, {
          available: false,
          degraded: true,
          message: provider.source === "mpc" ? MPC_DEGRADED_MESSAGE : error instanceof Error ? error.message : "Artwork provider failed.",
        });
        return [];
      }
    }));
    return results.flat();
  }

  async searchWithTotal(identity: CardIdentity, options: AdvancedArtworkCatalogSearchOptions): Promise<ArtworkCatalogSearchResult> {
    const selectedProviders = options.source === "all"
      ? [...this.providers.values()]
      : [this.providers.get(options.source)].filter((provider): provider is ArtworkProvider => provider !== undefined);
    const results = await Promise.all(selectedProviders.map(async (provider): Promise<ArtworkCatalogSearchResult> => {
      try {
        const standardOptions: ArtworkCatalogSearchOptions = {
          source: options.source,
          ...(options.faceId ? { faceId: options.faceId } : {}),
          ...(options.mpcReferences ? { mpcReferences: options.mpcReferences } : {}),
          ...(options.offset !== undefined ? { offset: options.offset } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        };
        const extension = mpcExtension(provider);
        let result: ArtworkCatalogSearchResult;
        if (extension?.searchArtworkAdvancedWithTotal) {
          result = await extension.searchArtworkAdvancedWithTotal(identity, {
            ...standardOptions,
            filters: options.mpcFilters ?? {},
            ...(options.forceMpcRefresh ? { forceRefresh: true } : {}),
          });
        } else {
          const candidates = extension
            ? await extension.searchArtworkAdvanced(identity, {
              ...standardOptions,
              filters: options.mpcFilters ?? {},
              ...(options.forceMpcRefresh ? { forceRefresh: true } : {}),
            })
            : await provider.searchArtwork(identity, standardOptions);
          result = { candidates, catalogTotal: candidates.length };
        }
        this.healthOverrides.delete(provider.source);
        this.providerReportedDegraded.delete(provider.source);
        this.health.set(provider.source, publicProviderHealth(provider.source, provider.getHealth?.() ?? { available: true, degraded: false }));
        return { ...result, catalogTotalComplete: result.catalogTotalComplete !== false };
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError") || (error && typeof error === "object" && (error as { kind?: unknown }).kind === "aborted")) throw error;
        if (error instanceof MpcArtworkFilterValidationError) throw error;
        this.healthOverrides.add(provider.source);
        if (provider.getHealth?.().degraded) this.providerReportedDegraded.add(provider.source);
        this.health.set(provider.source, {
          available: false,
          degraded: true,
          message: provider.source === "mpc" ? MPC_DEGRADED_MESSAGE : error instanceof Error ? error.message : "Artwork provider failed.",
        });
        return { candidates: [], catalogTotal: 0, catalogTotalComplete: false };
      }
    }));
    return {
      candidates: results.flatMap(({ candidates }) => candidates),
      catalogTotal: results.reduce((total, result) => total + result.catalogTotal, 0),
      catalogTotalComplete: results.every((result) => result.catalogTotalComplete !== false),
    };
  }

  getProviderHealth(): Readonly<Record<string, ProviderHealth>> {
    for (const provider of this.providers.values()) {
      const providerHealth = provider.getHealth?.();
      if (providerHealth) {
        if (providerHealth.degraded) this.providerReportedDegraded.add(provider.source);
        else if (this.healthOverrides.has(provider.source) && this.providerReportedDegraded.has(provider.source)) {
          this.healthOverrides.delete(provider.source);
          this.providerReportedDegraded.delete(provider.source);
        }
        if (!this.healthOverrides.has(provider.source)) this.health.set(provider.source, publicProviderHealth(provider.source, providerHealth));
      }
    }
    return Object.fromEntries(this.health.entries());
  }

  async getMpcFilterCatalogs(signal?: AbortSignal): Promise<MpcFilterCatalogs> {
    const provider = mpcExtension(this.providers.get("mpc"));
    if (!provider) throw new Error("MPC filter catalogs are unavailable.");
    const catalogs = await provider.getFilterCatalogs(signal);
    this.healthOverrides.delete(provider.source);
    this.providerReportedDegraded.delete(provider.source);
    this.health.set(provider.source, publicProviderHealth(provider.source, provider.getHealth?.() ?? { available: true, degraded: false }));
    return catalogs;
  }

  getMpcDiagnostic(): MpcArtworkProviderDiagnostic | undefined {
    return mpcExtension(this.providers.get("mpc"))?.getDiagnostic();
  }

  async refreshMpcCandidate(candidateId: string, signal?: AbortSignal): Promise<ArtworkCandidate | undefined> {
    const provider = mpcExtension(this.providers.get("mpc"));
    return provider?.refreshCandidate(candidateId, signal);
  }

  async revalidateMpcCandidates(candidateIds: readonly string[], signal?: AbortSignal): Promise<readonly MpcCandidateRevalidationResult[]> {
    const provider = mpcExtension(this.providers.get("mpc"));
    return provider?.revalidateCandidates?.(candidateIds, signal) ?? [];
  }

  markProviderDegraded(source: "scryfall" | "upload" | "mpc", error: unknown): void {
    this.healthOverrides.add(source);
    if (this.providers.get(source)?.getHealth?.().degraded) this.providerReportedDegraded.add(source);
    this.health.set(source, {
      available: false,
      degraded: true,
      message: source === "mpc" ? MPC_DEGRADED_MESSAGE : error instanceof Error ? error.message.slice(0, 300) : "Artwork provider failed.",
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
