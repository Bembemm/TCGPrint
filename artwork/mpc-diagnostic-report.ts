import type { MpcArtworkProviderDiagnostic, MpcDiagnosticFailure, MpcProviderCapabilities } from "./mpc-provider";

export const MPC_DIAGNOSTIC_REPORT_MAX_BYTES = 8_192;
const FAILURE_KINDS = new Set(["http", "rate-limited", "protocol", "unsafe-source", "invalid-image", "unsupported-format", "asset-too-large", "timeout", "aborted", "network", "storage"]);

function finiteCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, Math.floor(value))) : 0;
}

function safeCapabilities(value: MpcProviderCapabilities | undefined): MpcProviderCapabilities {
  const protocol = value?.protocol;
  return {
    search: value?.search === true,
    preview: value?.preview === true,
    original: value?.original === true,
    filters: {
      dpi: value?.filters?.dpi === true,
      sources: value?.filters?.sources === true,
      tags: value?.filters?.tags === true,
      languages: value?.filters?.languages === true,
    },
    protocol: {
      confirmedVersion: protocol?.confirmedVersion === "v2" || protocol?.confirmedVersion === "v3" ? protocol.confirmedVersion : null,
      v3Available: typeof protocol?.v3Available === "boolean" ? protocol.v3Available : null,
      fallbackV2Used: protocol?.fallbackV2Used === true,
    },
  };
}

function safeFailures(failures: readonly MpcDiagnosticFailure[] | undefined): MpcDiagnosticFailure[] {
  if (!Array.isArray(failures)) return [];
  return failures.slice(-20).flatMap((failure) => {
    if (!failure || typeof failure !== "object" || typeof failure.at !== "string" || !Number.isFinite(Date.parse(failure.at)) || !FAILURE_KINDS.has(failure.kind)) return [];
    const status = typeof failure.status === "number" && Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599 ? failure.status : undefined;
    return [{ at: new Date(failure.at).toISOString(), kind: failure.kind, ...(status ? { status } : {}) }];
  });
}

function boundedMetrics(diagnostic: MpcArtworkProviderDiagnostic | undefined) {
  const metrics = diagnostic?.metrics;
  const outcomes = metrics?.revalidation?.outcomes ?? {};
  const safeOutcomes: Record<string, number> = {};
  for (const key of ["unchanged", "metadata-updated", "remote-missing", "remote-unavailable", "local-original-valid", "local-original-corrupt", "unsupported"] as const) {
    safeOutcomes[key] = finiteCounter(outcomes[key]);
  }
  const statuses: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics?.httpStatusSummary ?? {}).slice(0, 20)) {
    if (/^[1-5][0-9]{2}$/.test(key)) statuses[key] = finiteCounter(value);
  }
  return {
    catalogCounts: {
      sources: finiteCounter(metrics?.catalogCounts?.sources),
      languages: finiteCounter(metrics?.catalogCounts?.languages),
      tags: finiteCounter(metrics?.catalogCounts?.tags),
    },
    searchCache: { hits: finiteCounter(diagnostic?.searchCacheHits), misses: finiteCounter(diagnostic?.searchCacheMisses) },
    candidateMetadataCache: { hits: finiteCounter(metrics?.candidateMetadataCache?.hits), misses: finiteCounter(metrics?.candidateMetadataCache?.misses) },
    thumbnailCache: { hits: finiteCounter(metrics?.thumbnailCache?.hits), misses: finiteCounter(metrics?.thumbnailCache?.misses) },
    originalCache: { hits: finiteCounter(metrics?.originalCache?.hits), misses: finiteCounter(metrics?.originalCache?.misses) },
    inFlightRequests: { api: finiteCounter(metrics?.inFlightRequests?.api), images: finiteCounter(metrics?.inFlightRequests?.images) },
    remoteConcurrency: {
      limit: finiteCounter(metrics?.remoteConcurrency?.limit),
      active: finiteCounter(metrics?.remoteConcurrency?.active),
      peak: finiteCounter(metrics?.remoteConcurrency?.peak),
    },
    remoteRequestCount: finiteCounter(metrics?.remoteRequestCount),
    negativeSearchCacheHits: finiteCounter(metrics?.negativeSearchCacheHits),
    negativeSearchCacheWrites: finiteCounter(metrics?.negativeSearchCacheWrites),
    timeouts: finiteCounter(metrics?.timeouts),
    httpStatusSummary: statuses,
    protocolFailures: finiteCounter(metrics?.protocolFailures),
    rateLimits: finiteCounter(metrics?.rateLimits),
    omittedHydrationCount: finiteCounter(metrics?.omittedHydrationCount),
    hydrationBatchCount: finiteCounter(metrics?.hydrationBatchCount),
    revalidation: {
      batches: finiteCounter(metrics?.revalidation?.batches),
      candidates: finiteCounter(metrics?.revalidation?.candidates),
      outcomes: safeOutcomes,
    },
  };
}

export function createMpcDiagnosticReport(diagnostic: MpcArtworkProviderDiagnostic | undefined): {
  readonly schemaVersion: 1;
  readonly provider: "mpc";
  readonly health: { readonly available: boolean; readonly degraded: boolean; readonly lastSuccessfulAt?: string; readonly lastSuccessfulContactAt?: string; readonly lastFailureType?: string };
  readonly capabilities: MpcProviderCapabilities;
  readonly metrics: ReturnType<typeof boundedMetrics>;
  readonly recentFailures: readonly MpcDiagnosticFailure[];
} {
  const report = {
    schemaVersion: 1 as const,
    provider: "mpc" as const,
    health: {
      available: diagnostic?.available === true,
      degraded: diagnostic?.degraded !== false,
      ...(diagnostic?.lastSuccessfulAt && Number.isFinite(Date.parse(diagnostic.lastSuccessfulAt)) ? { lastSuccessfulAt: new Date(diagnostic.lastSuccessfulAt).toISOString() } : {}),
      ...(diagnostic?.lastSuccessfulContactAt && Number.isFinite(Date.parse(diagnostic.lastSuccessfulContactAt)) ? { lastSuccessfulContactAt: new Date(diagnostic.lastSuccessfulContactAt).toISOString() } : {}),
      ...(diagnostic?.lastFailureType && FAILURE_KINDS.has(diagnostic.lastFailureType) ? { lastFailureType: diagnostic.lastFailureType } : {}),
    },
    capabilities: safeCapabilities(diagnostic?.capabilities),
    metrics: boundedMetrics(diagnostic),
    recentFailures: safeFailures(diagnostic?.recentFailures),
  };
  while (new TextEncoder().encode(JSON.stringify(report)).byteLength > MPC_DIAGNOSTIC_REPORT_MAX_BYTES && report.recentFailures.length) report.recentFailures.shift();
  return report;
}
