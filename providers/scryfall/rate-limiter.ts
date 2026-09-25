import { ScryfallError } from "./errors";

export interface RateLimiterOptions {
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ScryfallError("aborted", "The Scryfall request was cancelled."));
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, milliseconds));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new ScryfallError("aborted", "The Scryfall request was cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Serializes provider requests and observes Retry-After without automatic retrying. */
export class ScryfallRateLimiter {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 125);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  defer(milliseconds: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(0, milliseconds));
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal?.aborted) throw new ScryfallError("aborted", "The Scryfall request was cancelled.");
      const requestAt = Math.max(this.lastRequestAt + this.minIntervalMs, this.blockedUntil, this.now());
      await this.sleep(requestAt - this.now(), signal);
      if (signal?.aborted) throw new ScryfallError("aborted", "The Scryfall request was cancelled.");
      this.lastRequestAt = this.now();
      return await operation();
    } finally {
      release();
    }
  }
}

export const sharedScryfallRateLimiter = new ScryfallRateLimiter();
