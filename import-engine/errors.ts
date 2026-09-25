export type ImportFailureCode =
  | "CANCELLED"
  | "DETECTION_REQUIRED"
  | "UNSUPPORTED_INPUT"
  | "FORMAT_MISMATCH"
  | "INPUT_TOO_LARGE"
  | "IMAGE_DECODE_FAILED"
  | "INVALID_SVG"
  | "INVALID_DECKLIST"
  | "INVALID_CSV"
  | "INVALID_JSON"
  | "INVALID_XML"
  | "XML_DTD_BLOCKED"
  | "ZIP_INVALID"
  | "ZIP_UNSAFE_PATH"
  | "ZIP_SYMLINK_BLOCKED"
  | "ZIP_ENTRY_LIMIT"
  | "ZIP_SIZE_LIMIT"
  | "ZIP_RATIO_LIMIT"
  | "ZIP_DEPTH_LIMIT"
  | "MAPPING_INVALID"
  | "INVALID_SOURCE_PATH";

export class ImportFailureError extends Error {
  constructor(
    message: string,
    readonly code: ImportFailureCode,
    readonly sourceId?: string,
    readonly sourcePath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ImportFailureError";
  }
}

export class ImportCancelledError extends ImportFailureError {
  constructor(sourceId?: string) {
    super("Import cancelled before a complete result was produced.", "CANCELLED", sourceId);
    this.name = "ImportCancelledError";
  }
}

export class ImportDetectionRequiredError extends ImportFailureError {
  constructor(message: string, sourceId?: string) {
    super(message, "DETECTION_REQUIRED", sourceId);
    this.name = "ImportDetectionRequiredError";
  }
}
