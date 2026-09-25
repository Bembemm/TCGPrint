export type ScryfallErrorKind =
  | "not-found"
  | "rate-limited"
  | "server"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "invalid-json"
  | "invalid-payload"
  | "unsafe-url"
  | "invalid-content-type"
  | "invalid-image"
  | "asset-too-large";

export class ScryfallError extends Error {
  readonly kind: ScryfallErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: ScryfallErrorKind, message: string, options: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ScryfallError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isScryfallError(error: unknown): error is ScryfallError {
  return error instanceof ScryfallError;
}
