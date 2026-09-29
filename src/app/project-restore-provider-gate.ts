export type ProjectRestoreLookup = "artwork" | "identity";

export interface ProjectRestoreLookupGate {
  readonly version: number;
  readonly pending: Set<ProjectRestoreLookup>;
}

export function createProjectRestoreLookupGate(version: number): ProjectRestoreLookupGate {
  return { version, pending: new Set(["artwork", "identity"]) };
}

function shouldSkip(gate: ProjectRestoreLookupGate, version: number, lookup: ProjectRestoreLookup): boolean {
  if (gate.version !== version || !gate.pending.has(lookup)) return false;
  queueMicrotask(() => {
    if (gate.version === version) gate.pending.delete(lookup);
  });
  return true;
}

export async function runProjectRestoreProviderLookup<T>(
  gate: ProjectRestoreLookupGate,
  version: number,
  lookup: ProjectRestoreLookup,
  load: () => Promise<T>,
): Promise<{ readonly skipped: true } | { readonly skipped: false; readonly value: T }> {
  if (shouldSkip(gate, version, lookup)) return { skipped: true };
  return { skipped: false, value: await load() };
}
