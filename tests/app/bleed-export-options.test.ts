import { describe, expect, it } from "vitest";
import { buildBleedExportOptions, decodeBleedDiagnostics } from "../../src/app/bleed-export-options";
import { encodeBleedDiagnostics } from "../../services/card-api";
import type { CardExportBleedDiagnostic } from "../../services/card-export";
import { BLEED_ALGORITHM_VERSION } from "../../image-engine/bleed";

describe("bleed export options", () => {
  it("sends the selected mode with the existing bleed and cut-guide settings", () => {
    expect(buildBleedExportOptions("0.625", true, "smart-border-fill")).toEqual({
      bleedMm: 0.625,
      cutGuides: "full",
      bleedMode: "smart-border-fill",
    });
  });

  it("decodes the per-side diagnostics report returned with PDF export", () => {
    const report = { version: 1, mode: "full", diagnostics: [{ workingCardId: "card-1", policyId: "scryfall-raster-auto-v1", sideDiagnostics: { top: { effectiveMode: "smart-border-fill", sourceOffsetPx: 4 } } }] };
    const encoded = Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
    expect(decodeBleedDiagnostics(encoded)).toEqual(report);
    expect(decodeBleedDiagnostics("not-base64-json")).toBeNull();
  });

  it("keeps effective modes, fallback sides, and notices in summary headers", () => {
    const diagnostic: CardExportBleedDiagnostic = {
      workingCardId: "card-1",
      identityId: "identity-1",
      cardName: "Sol Ring",
      source: "mpc",
      requestedMode: "auto",
      resolvedMode: "subtle-edge-stretch",
      effectiveMode: "subtle-edge-stretch",
      algorithmVersion: BLEED_ALGORITHM_VERSION,
      smartBorderFillConfigVersion: "smart-border-fill-config-v1",
      policyId: "mpc-metadata-unknown-v1",
      policyNotice: "MPC_BLEED_METADATA_UNKNOWN",
      bleedMm: 1,
      trimSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      previewSha256: "a".repeat(64),
      sideDiagnostics: {
        top: { requestedMode: "smart-border-fill", effectiveMode: "subtle-edge-stretch", classification: "outer-band-not-dark-uniform", sourceOffsetPx: 0, sourceStripPx: 0, fallbackReason: "outer-band-not-dark-uniform" },
        right: { requestedMode: "smart-border-fill", effectiveMode: "subtle-edge-stretch", classification: "outer-band-not-dark-uniform", sourceOffsetPx: 0, sourceStripPx: 0, fallbackReason: "outer-band-not-dark-uniform" },
        bottom: { requestedMode: "smart-border-fill", effectiveMode: "subtle-edge-stretch", classification: "outer-band-not-dark-uniform", sourceOffsetPx: 0, sourceStripPx: 0, fallbackReason: "outer-band-not-dark-uniform" },
        left: { requestedMode: "smart-border-fill", effectiveMode: "subtle-edge-stretch", classification: "outer-band-not-dark-uniform", sourceOffsetPx: 0, sourceStripPx: 0, fallbackReason: "outer-band-not-dark-uniform" },
      },
    };

    const header = encodeBleedDiagnostics([diagnostic], 1);
    expect(header.mode).toBe("summary");
    expect(decodeBleedDiagnostics(header.value)).toMatchObject({
      mode: "summary",
      effectiveModeCounts: { "subtle-edge-stretch": 1 },
      fallbackCounts: {
        "top:outer-band-not-dark-uniform": 1,
        "right:outer-band-not-dark-uniform": 1,
        "bottom:outer-band-not-dark-uniform": 1,
        "left:outer-band-not-dark-uniform": 1,
      },
      noticeCounts: { MPC_BLEED_METADATA_UNKNOWN: 1 },
    });
  });
});
