import type { ArtworkCandidate } from "../../core/cards/types";

export type PreparedArtworkCandidate<T extends ArtworkCandidate> = T;

export interface KeyedArtworkCatalogResult<T> {
  readonly requestKey: string;
  readonly candidates: readonly T[];
  readonly catalogTotal: number;
  readonly catalogTotalComplete?: boolean;
}

/** Returns no candidates while UI state still belongs to a previous request. */
export function artworkCatalogForRequest<T>(
  result: KeyedArtworkCatalogResult<T> | null,
  requestKey: string,
): KeyedArtworkCatalogResult<T> {
  return result?.requestKey === requestKey
    ? result
    : { requestKey, candidates: [], catalogTotal: 0, catalogTotalComplete: false };
}

/** A late quality callback cannot modify a different request's catalog. */
export function updateArtworkCatalogCandidate<T extends { readonly id: string }>(
  result: KeyedArtworkCatalogResult<T> | null,
  requestKey: string,
  candidate: T,
): KeyedArtworkCatalogResult<T> | null {
  if (!result || result.requestKey !== requestKey || !result.candidates.some((item) => item.id === candidate.id)) return result;
  return {
    ...result,
    candidates: result.candidates.map((item) => item.id === candidate.id ? candidate : item),
  };
}

interface HydrationGeneration<T extends ArtworkCandidate> {
  readonly requestKey: string;
  readonly controller: AbortController;
  readonly seen: Set<string>;
  readonly checking: Set<string>;
  readonly queue: T[];
  active: number;
}

/** Runs advisory quality preparation for visible Scryfall candidates with a bounded queue. */
export class ArtworkQualityHydrator<T extends ArtworkCandidate> {
  private readonly prepare: (candidate: T, signal: AbortSignal) => Promise<PreparedArtworkCandidate<T>>;
  private readonly onPrepared: (requestKey: string, candidate: PreparedArtworkCandidate<T>) => void;
  private readonly onChecking: (requestKey: string, candidateIds: ReadonlySet<string>) => void;
  private readonly concurrency: number;
  private generation: HydrationGeneration<T> | undefined;

  constructor(
    prepare: (candidate: T, signal: AbortSignal) => Promise<PreparedArtworkCandidate<T>>,
    onPrepared: (requestKey: string, candidate: PreparedArtworkCandidate<T>) => void,
    onChecking: (requestKey: string, candidateIds: ReadonlySet<string>) => void,
    concurrency = 3,
  ) {
    this.prepare = prepare;
    this.onPrepared = onPrepared;
    this.onChecking = onChecking;
    this.concurrency = Math.max(1, Math.min(4, Math.floor(concurrency)));
  }

  reset(requestKey: string): void {
    this.cancel();
    const generation: HydrationGeneration<T> = {
      requestKey,
      controller: new AbortController(),
      seen: new Set(),
      checking: new Set(),
      queue: [],
      active: 0,
    };
    this.generation = generation;
    this.onChecking(requestKey, new Set());
  }

  schedule(requestKey: string, candidates: readonly T[]): void {
    const generation = this.generation;
    if (!generation || generation.requestKey !== requestKey || generation.controller.signal.aborted) return;
    const queued = candidates.filter((candidate) => candidate.source === "scryfall" && candidate.originalAvailable
      && candidate.originalCached !== true && candidate.effectiveDpi === undefined && !generation.seen.has(candidate.id));
    if (queued.length === 0) return;
    for (const candidate of queued) {
      generation.seen.add(candidate.id);
      generation.checking.add(candidate.id);
      generation.queue.push(candidate);
    }
    this.onChecking(requestKey, new Set(generation.checking));
    this.pump(generation);
  }

  cancel(requestKey?: string): void {
    const generation = this.generation;
    if (!generation || (requestKey !== undefined && generation.requestKey !== requestKey)) return;
    generation.controller.abort();
    generation.queue.length = 0;
    this.generation = undefined;
    this.onChecking(generation.requestKey, new Set());
  }

  private pump(generation: HydrationGeneration<T>): void {
    if (this.generation !== generation || generation.controller.signal.aborted) return;
    while (generation.active < this.concurrency && generation.queue.length > 0) {
      const candidate = generation.queue.shift()!;
      generation.active += 1;
      void this.prepare(candidate, generation.controller.signal).then((prepared) => {
        if (this.generation === generation && !generation.controller.signal.aborted) {
          this.onPrepared(generation.requestKey, prepared);
        }
      }).catch(() => {
        // Quality is advisory; an unavailable or failed original remains unknown.
      }).finally(() => {
        generation.active -= 1;
        if (this.generation !== generation) return;
        generation.checking.delete(candidate.id);
        this.onChecking(generation.requestKey, new Set(generation.checking));
        this.pump(generation);
      });
    }
  }
}
