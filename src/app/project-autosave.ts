export const PROJECT_AUTOSAVE_DEBOUNCE_MS = 600;
export const PROJECT_AUTOSAVE_MAX_WAIT_MS = 2_000;
export const PROJECT_AUTOSAVE_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

export interface ProjectAutosaveContext {
  readonly projectId: string;
  readonly revision: number;
  readonly savedSnapshotKey: string;
}

export interface ProjectAutosaveRequest<TSnapshot> {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly snapshotKey: string;
  readonly snapshot: TSnapshot;
}

export interface ProjectAutosaveResult {
  readonly revision: number;
}

export type ProjectAutosaveFailureKind = "error" | "conflict";
export type ProjectAutosaveFlushResult = "saved" | "idle" | "error" | "conflict";

export interface ProjectAutosaveTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface ProjectAutosaveQueueOptions<TSnapshot, TResult extends ProjectAutosaveResult = ProjectAutosaveResult> {
  readonly save: (request: ProjectAutosaveRequest<TSnapshot>) => Promise<TResult>;
  readonly onSaveStarted?: (request: ProjectAutosaveRequest<TSnapshot>) => void;
  readonly onSaveSucceeded?: (request: ProjectAutosaveRequest<TSnapshot>, result: TResult) => void;
  readonly onSaveFailed?: (request: ProjectAutosaveRequest<TSnapshot>, error: unknown, kind: ProjectAutosaveFailureKind) => void;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly isConflict?: (error: unknown) => boolean;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly timers?: ProjectAutosaveTimers;
}

interface PendingSnapshot<TSnapshot> {
  readonly snapshotKey: string;
  readonly snapshot: TSnapshot;
}

type Waiter = (result: ProjectAutosaveFlushResult) => void;

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function defaultConflict(error: unknown): boolean {
  return errorStatus(error) === 409
    || (error !== null && error !== undefined && typeof error === "object" && "code" in error
      && (error as { readonly code?: unknown }).code === "PROJECT_REVISION_CONFLICT");
}

function defaultRetryable(error: unknown): boolean {
  const status = errorStatus(error);
  return status === undefined || status >= 500;
}

/** Serializes autosaves for one active Project and keeps only its newest pending snapshot. */
export class ProjectAutosaveQueue<TSnapshot, TResult extends ProjectAutosaveResult = ProjectAutosaveResult> {
  private readonly save: ProjectAutosaveQueueOptions<TSnapshot, TResult>["save"];
  private readonly onSaveStarted?: ProjectAutosaveQueueOptions<TSnapshot, TResult>["onSaveStarted"];
  private readonly onSaveSucceeded?: ProjectAutosaveQueueOptions<TSnapshot, TResult>["onSaveSucceeded"];
  private readonly onSaveFailed?: ProjectAutosaveQueueOptions<TSnapshot, TResult>["onSaveFailed"];
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly isConflict: (error: unknown) => boolean;
  private readonly isRetryable: (error: unknown) => boolean;
  private readonly timers: ProjectAutosaveTimers;

  private context: ProjectAutosaveContext | null = null;
  private pending: PendingSnapshot<TSnapshot> | null = null;
  private inFlight = false;
  private disposed = false;
  private blocked: { readonly kind: ProjectAutosaveFailureKind; readonly snapshotKey: string } | null = null;
  private forceFlush = false;
  private debounceTimer: unknown;
  private maxWaitTimer: unknown;
  private retryTimer: unknown;
  private hasDebounceTimer = false;
  private hasMaxWaitTimer = false;
  private hasRetryTimer = false;
  private generation = 0;
  private flightSequence = 0;
  private activeFlightId = 0;
  private cancelRetrySleep?: () => void;
  private waiters: Waiter[] = [];

  constructor(options: ProjectAutosaveQueueOptions<TSnapshot, TResult>) {
    this.save = options.save;
    this.onSaveStarted = options.onSaveStarted;
    this.onSaveSucceeded = options.onSaveSucceeded;
    this.onSaveFailed = options.onSaveFailed;
    this.debounceMs = options.debounceMs ?? PROJECT_AUTOSAVE_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? PROJECT_AUTOSAVE_MAX_WAIT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? PROJECT_AUTOSAVE_RETRY_DELAYS_MS;
    this.isConflict = options.isConflict ?? defaultConflict;
    this.isRetryable = options.isRetryable ?? defaultRetryable;
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
  }

  activate(context: ProjectAutosaveContext): void {
    this.generation += 1;
    this.clearScheduledWork();
    this.inFlight = false;
    this.activeFlightId = ++this.flightSequence;
    this.settleWaiters("idle");
    this.context = { ...context };
    this.pending = null;
    this.blocked = null;
    this.forceFlush = false;
    this.disposed = false;
  }

  getContext(): ProjectAutosaveContext | null {
    return this.context ? { ...this.context } : null;
  }

  observe(snapshotKey: string, snapshot: TSnapshot): void {
    if (this.disposed || !this.context) return;
    if (snapshotKey === this.context.savedSnapshotKey && !this.inFlight) {
      this.pending = null;
      this.blocked = null;
      this.clearDebounceTimers();
      this.settleWaiters("idle");
      return;
    }

    if (this.pending?.snapshotKey === snapshotKey) return;
    this.pending = { snapshotKey, snapshot };

    if (this.blocked?.kind === "conflict") return;
    if (this.blocked && this.blocked.snapshotKey !== snapshotKey) this.blocked = null;
    if (this.blocked) return;

    this.scheduleFlush();
  }

  flushNow(): Promise<ProjectAutosaveFlushResult> {
    if (this.disposed || !this.context) return Promise.resolve("idle");
    if (this.blocked?.kind === "conflict") return Promise.resolve("conflict");
    if (!this.pending && !this.inFlight) return Promise.resolve("idle");

    this.blocked = null;
    this.forceFlush = true;
    this.clearDebounceTimers();
    const result = new Promise<ProjectAutosaveFlushResult>((resolve) => this.waiters.push(resolve));
    this.pump();
    return result;
  }

  dispose(): void {
    this.generation += 1;
    this.disposed = true;
    this.inFlight = false;
    this.activeFlightId = ++this.flightSequence;
    this.pending = null;
    this.context = null;
    this.clearScheduledWork();
    this.settleWaiters("idle");
  }

  private scheduleFlush(): void {
    if (!this.hasMaxWaitTimer) {
      this.hasMaxWaitTimer = true;
      this.maxWaitTimer = this.timers.setTimeout(() => {
        this.hasMaxWaitTimer = false;
        this.maxWaitTimer = undefined;
        this.forceFlush = true;
        this.pump();
      }, this.maxWaitMs);
    }
    this.clearDebounceTimer();
    this.hasDebounceTimer = true;
    this.debounceTimer = this.timers.setTimeout(() => {
      this.hasDebounceTimer = false;
      this.debounceTimer = undefined;
      this.forceFlush = true;
      this.pump();
    }, this.debounceMs);
  }

  private pump(): void {
    if (this.disposed || this.inFlight || !this.context || !this.pending || this.blocked) return;
    if (!this.forceFlush) return;

    this.clearDebounceTimers();
    this.forceFlush = false;
    const context = this.context;
    const generation = this.generation;
    const flightId = ++this.flightSequence;
    this.activeFlightId = flightId;
    const pending = this.pending;
    this.pending = null;
    const request: ProjectAutosaveRequest<TSnapshot> = {
      projectId: context.projectId,
      expectedRevision: context.revision,
      snapshotKey: pending.snapshotKey,
      snapshot: pending.snapshot,
    };
    this.inFlight = true;
    this.onSaveStarted?.(request);

    void this.saveWithRetries(request, generation).then((result) => {
      if (generation !== this.generation || this.context?.projectId !== request.projectId) return;
      if (result.revision !== request.expectedRevision + 1) {
        this.fail(request, new Error("Autosave response did not advance the Project revision exactly once."), "conflict");
        return;
      }
      this.context = {
        ...this.context,
        revision: result.revision,
        savedSnapshotKey: request.snapshotKey,
      };
      if (this.pending?.snapshotKey === request.snapshotKey) this.pending = null;
      this.onSaveSucceeded?.(request, result);
      if (!this.pending) this.settleWaiters("saved");
    }).catch((failure: unknown) => {
      if (generation !== this.generation || this.context?.projectId !== request.projectId) return;
      const details = failure as { readonly error?: unknown; readonly kind?: ProjectAutosaveFailureKind };
      this.fail(request, details.error ?? failure, details.kind ?? (this.isConflict(failure) ? "conflict" : "error"));
    }).finally(() => {
      if (this.activeFlightId !== flightId) return;
      this.inFlight = false;
      if (this.disposed) return;
      if (this.pending && this.forceFlush && !this.blocked) this.pump();
      else if (!this.pending) this.settleWaiters(this.blocked?.kind ?? "saved");
    });
  }

  private async saveWithRetries(
    request: ProjectAutosaveRequest<TSnapshot>,
    generation: number,
  ): Promise<TResult> {
    let attempt = 0;
    while (true) {
      try {
        return await this.save(request);
      } catch (error) {
        if (this.isConflict(error)) throw { error, kind: "conflict" as const };
        if (!this.isRetryable(error) || attempt >= this.retryDelaysMs.length || generation !== this.generation) {
          throw { error, kind: "error" as const };
        }
        const delayMs = this.retryDelaysMs[attempt];
        attempt += 1;
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (this.hasRetryTimer) this.timers.clearTimeout(this.retryTimer);
            this.hasRetryTimer = false;
            this.retryTimer = undefined;
            if (this.cancelRetrySleep === finish) this.cancelRetrySleep = undefined;
            resolve();
          };
          this.cancelRetrySleep = finish;
          this.hasRetryTimer = true;
          this.retryTimer = this.timers.setTimeout(finish, delayMs);
        });
        if (generation !== this.generation || this.disposed) throw { error, kind: "error" as const };
      }
    }
  }

  private fail(
    request: ProjectAutosaveRequest<TSnapshot>,
    error: unknown,
    kind: ProjectAutosaveFailureKind,
  ): void {
    if (!this.pending) this.pending = { snapshotKey: request.snapshotKey, snapshot: request.snapshot };
    this.blocked = { kind, snapshotKey: request.snapshotKey };
    this.forceFlush = false;
    this.onSaveFailed?.(request, error, kind);
    this.settleWaiters(kind);
  }

  private clearDebounceTimer(): void {
    if (!this.hasDebounceTimer) return;
    this.timers.clearTimeout(this.debounceTimer);
    this.hasDebounceTimer = false;
    this.debounceTimer = undefined;
  }

  private clearDebounceTimers(): void {
    this.clearDebounceTimer();
    if (this.hasMaxWaitTimer) {
      this.timers.clearTimeout(this.maxWaitTimer);
      this.hasMaxWaitTimer = false;
      this.maxWaitTimer = undefined;
    }
  }

  private clearScheduledWork(): void {
    this.clearDebounceTimers();
    this.cancelRetrySleep?.();
  }

  private settleWaiters(result: ProjectAutosaveFlushResult): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(result);
  }
}
