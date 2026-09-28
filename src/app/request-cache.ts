export interface RequestCache<T> {
  readonly resolved: Map<string, T>;
  readonly inflight: Map<string, Promise<T>>;
}

export function createRequestCache<T>(): RequestCache<T> {
  return { resolved: new Map(), inflight: new Map() };
}

export function clearRequestCache<T>(requests: RequestCache<T>): void {
  requests.resolved.clear();
  requests.inflight.clear();
}

export function getOrCreateCachedRequest<T>(
  requests: RequestCache<T>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (requests.resolved.has(key)) return Promise.resolve(requests.resolved.get(key) as T);

  const inflight = requests.inflight.get(key);
  if (inflight) return inflight;

  const request = Promise.resolve().then(load);
  requests.inflight.set(key, request);
  void request.then(
    (value) => {
      if (requests.inflight.get(key) !== request) return;
      requests.resolved.set(key, value);
      requests.inflight.delete(key);
    },
    () => {
      if (requests.inflight.get(key) === request) requests.inflight.delete(key);
    },
  );
  return request;
}

export function updateResolvedRequestCache<T>(
  requests: RequestCache<T>,
  key: string,
  update: (value: T) => T,
): boolean {
  if (!requests.resolved.has(key)) return false;
  const value = requests.resolved.get(key) as T;
  requests.resolved.set(key, update(value));
  return true;
}
