interface SharedRequest<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  consumers: number;
  settled: boolean;
}

export interface CoalescedRequestRegistry<T> {
  readonly size: number;
  run(key: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>, abortError?: () => Error): Promise<T>;
}

interface SemaphoreWaiter {
  readonly signal?: AbortSignal;
  readonly abortError: () => Error;
  readonly reject: (error: unknown) => void;
  readonly resolve: (release: () => void) => void;
  readonly onAbort: () => void;
}

export interface BoundedSemaphore {
  readonly active: number;
  readonly peak: number;
  readonly limit: number;
  run<T>(operation: () => Promise<T>, signal?: AbortSignal, abortError?: () => Error): Promise<T>;
}

export function createBoundedSemaphore(limit: number): BoundedSemaphore {
  const maximum = Math.max(1, Math.floor(limit));
  let active = 0;
  let peak = 0;
  const queue: SemaphoreWaiter[] = [];
  const defaultAbortError = () => Object.assign(new Error("The request was cancelled."), { name: "AbortError" });
  const releasePermit = (): (() => void) => {
    active += 1;
    peak = Math.max(peak, active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      while (queue.length) {
        const waiter = queue.shift()!;
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal?.aborted) {
          waiter.reject(waiter.abortError());
          continue;
        }
        waiter.resolve(releasePermit());
        break;
      }
    };
  };
  const acquire = (signal: AbortSignal | undefined, abortError: () => Error) => {
    if (signal?.aborted) return Promise.reject(abortError());
    if (active < maximum) return Promise.resolve(releasePermit());
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        signal,
        abortError,
        resolve,
        reject,
        onAbort: () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(abortError());
        },
      };
      queue.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  };
  return {
    get active() { return active; },
    get peak() { return peak; },
    limit: maximum,
    async run<T>(operation: () => Promise<T>, signal?: AbortSignal, abortError: () => Error = defaultAbortError) {
      const release = await acquire(signal, abortError);
      try {
        if (signal?.aborted) throw abortError();
        return await operation();
      } finally { release(); }
    },
  };
}

export function createCoalescedRequestRegistry<T>(): CoalescedRequestRegistry<T> {
  const requests = new Map<string, SharedRequest<T>>();
  const defaultAbortError = () => Object.assign(new Error("The request was cancelled."), { name: "AbortError" });
  return {
    get size() { return requests.size; },
    run(key, signal, operation, abortError = defaultAbortError) {
      if (signal?.aborted) return Promise.reject(abortError());
      let request = requests.get(key);
      if (!request) {
        const controller = new AbortController();
        const created: SharedRequest<T> = {
          controller,
          consumers: 0,
          settled: false,
          promise: Promise.resolve().then(() => {
            if (controller.signal.aborted) throw abortError();
            return operation(controller.signal);
          }).finally(() => {
            created.settled = true;
            if (requests.get(key) === created) requests.delete(key);
          }),
        };
        request = created;
        requests.set(key, created);
      }
      request.consumers += 1;
      const shared = request;
      return new Promise<T>((resolve, reject) => {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          signal?.removeEventListener("abort", onAbort);
          shared.consumers -= 1;
          if (!shared.settled && shared.consumers === 0) shared.controller.abort();
        };
        const onAbort = () => {
          release();
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        shared.promise.then((value) => {
          if (released) return;
          release();
          resolve(value);
        }, (error: unknown) => {
          if (released) return;
          release();
          reject(error);
        });
      });
    },
  };
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const maximum = Math.max(1, Math.min(items.length || 1, Math.floor(concurrency)));
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: maximum }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index]!, index);
    }
  }));
  return results;
}
