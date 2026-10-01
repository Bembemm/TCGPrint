export class CutSourceError extends Error {
  constructor(
    readonly code:
      | "CUT_SOURCE_TOO_LARGE"
      | "CUT_SOURCE_MALFORMED"
      | "CUT_SOURCE_UNSUPPORTED"
      | "CUT_SOURCE_UNITS_AMBIGUOUS"
      | "CUT_SOURCE_DIMENSIONS_MISMATCH"
      | "CUT_SOURCE_COMPLEXITY_LIMIT"
      | "CUT_SOURCE_INTEGRITY_FAILURE"
      | "CUT_LAYOUT_MISMATCH"
      | "CUT_EXPORT_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CutSourceError";
  }
}

export function sourceFailure(
  code: ConstructorParameters<typeof CutSourceError>[0],
  message: string,
  cause?: unknown,
): never {
  throw new CutSourceError(code, message, cause instanceof Error ? { cause } : undefined);
}
