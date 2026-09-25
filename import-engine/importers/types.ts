import type { ImportMapping, ImportWarning, ImportedEntry } from "../types";

export interface ImporterOutput {
  readonly entries: readonly ImportedEntry[];
  readonly warnings: readonly ImportWarning[];
  readonly mappings?: readonly ImportMapping[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SingleEntryImporterOutput {
  readonly entry: ImportedEntry;
  readonly warnings: readonly ImportWarning[];
}
