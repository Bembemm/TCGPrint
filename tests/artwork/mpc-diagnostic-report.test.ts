import { describe, expect, it } from "vitest";
import { createMpcDiagnosticReport, MPC_DIAGNOSTIC_REPORT_MAX_BYTES } from "../../artwork/mpc-diagnostic-report";
import type { MpcArtworkProviderDiagnostic } from "../../artwork/mpc-provider";

describe("MPC diagnostic report", () => {
  it("exports bounded versioned JSON without arbitrary upstream or private fields", () => {
    const diagnostic = {
      available: true,
      degraded: true,
      lastProtocolConfirmed: "v2",
      v3Available: false,
      fallbackV2Used: true,
      lastSuccessfulAt: "2026-10-03T00:00:05.000Z",
      lastSuccessfulContactAt: "2026-10-03T00:00:00.000Z",
      lastFailureType: "https://private.example/path?token=secret",
      catalogCaches: {
        sources: { state: "stale", ageMs: 999_999_999 },
        languages: { state: "unavailable" },
        tags: { state: "empty" },
      },
      searchCacheHits: 5,
      searchCacheMisses: 7,
      capabilities: {
        search: true, preview: true, original: false,
        filters: { dpi: true, sources: true, tags: false, languages: false },
        protocol: { confirmedVersion: "v2", v3Available: false, fallbackV2Used: true },
      },
      metrics: {
        candidateMetadataCache: { hits: 10, misses: 2 }, thumbnailCache: { hits: 0, misses: 1 }, originalCache: { hits: 3, misses: 4 },
        inFlightRequests: { api: 0, images: 0 }, remoteRequestCount: 99, negativeSearchCacheHits: 1, negativeSearchCacheWrites: 2,
        timeouts: 3, httpStatusSummary: { "429": 2, "https://evil.invalid": 999 }, protocolFailures: 4, rateLimits: 2,
        omittedHydrationCount: 5, hydrationBatchCount: 6,
        revalidation: { batches: 2, candidates: 100, outcomes: { unchanged: 50, "remote-unavailable": 2 } },
      },
      recentFailures: Array.from({ length: 100 }, (_, index) => ({ at: new Date(index * 1000).toISOString(), kind: "network", status: 503, url: "https://private.example?token=secret", path: "/private" })),
      filesystemPath: "/private/card.png",
      rawResponse: "<xml>private</xml>",
    } as unknown as MpcArtworkProviderDiagnostic;

    const report = createMpcDiagnosticReport(diagnostic);
    const json = JSON.stringify(report);

    expect(report).toMatchObject({ schemaVersion: 1, provider: "mpc", health: { available: true, degraded: true, lastSuccessfulAt: "2026-10-03T00:00:05.000Z", lastSuccessfulContactAt: "2026-10-03T00:00:00.000Z" }, capabilities: { protocol: { confirmedVersion: "v2" } } });
    expect(report.recentFailures).toHaveLength(20);
    expect(json.length).toBeLessThanOrEqual(MPC_DIAGNOSTIC_REPORT_MAX_BYTES);
    expect(json).not.toContain("private.example");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("filesystemPath");
    expect(json).not.toContain("private/card.png");
    expect(json).not.toContain("<xml>");
  });

  it("returns a minimal safe report when no MPC diagnostic is available", () => {
    expect(createMpcDiagnosticReport(undefined)).toMatchObject({
      schemaVersion: 1,
      provider: "mpc",
      health: { available: false, degraded: true },
      capabilities: { search: false },
      metrics: { remoteRequestCount: 0 },
      recentFailures: [],
    });
  });
});
