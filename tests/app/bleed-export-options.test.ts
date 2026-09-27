import { describe, expect, it } from "vitest";
import { buildBleedExportOptions, decodeBleedDiagnostics } from "../../src/app/bleed-export-options";
import { encodeBleedDiagnostics } from "../../services/card-api";
import type { CardExportBleedDiagnostic } from "../../services/card-export";
import { BLEED_ALGORITHM_VERSION } from "../../image-engine/bleed";

describe("bleed export options", () => {
  it("sends edge-extension settings with rounded corners disabled by default", () => {
    const options = buildBleedExportOptions("0.625", true);
    expect(options).toEqual({
      bleedMm: 0.625,
      cutGuides: "full",
      roundedCorners: false,
    });
    expect(Object.keys(options)).not.toContain("bleedMode");
  });

  it("sends the explicit rounded-corners choice independently of bleed", () => {
    expect(buildBleedExportOptions("0", false, true)).toEqual({
      bleedMm: 0,
      cutGuides: "none",
      roundedCorners: true,
    });
    expect(buildBleedExportOptions("1", true, false).roundedCorners).toBe(false);
  });

  it("decodes the per-side diagnostics report returned with PDF export", () => {
    const report = { version: 1, mode: "full", diagnostics: [{ workingCardId: "card-1", policyId: "edge-extension-v1", sideDiagnostics: { top: { strategy: "nearest-edge-pixel" } } }] };
    const encoded = Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
    expect(decodeBleedDiagnostics(encoded)).toEqual(report);
    expect(decodeBleedDiagnostics("not-base64-json")).toBeNull();
  });

  it("keeps the single effective algorithm in summary headers", () => {
    const diagnostic: CardExportBleedDiagnostic = {
      workingCardId: "card-1",
      identityId: "identity-1",
      cardName: "Sol Ring",
      source: "mpc",
      requestedMode: "auto",
      resolvedMode: "edge-extension",
      effectiveMode: "edge-extension",
      algorithmVersion: BLEED_ALGORITHM_VERSION,
      policyId: "edge-extension-v1",
      bleedMm: 1,
      trimSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      roundedCorners: false,
      previewSha256: "a".repeat(64),
      sideDiagnostics: {
        top: { strategy: "nearest-edge-pixel" },
        right: { strategy: "nearest-edge-pixel" },
        bottom: { strategy: "nearest-edge-pixel" },
        left: { strategy: "nearest-edge-pixel" },
      },
    };

    const header = encodeBleedDiagnostics([diagnostic], 1);
    expect(header.mode).toBe("summary");
    expect(decodeBleedDiagnostics(header.value)).toMatchObject({ mode: "summary", effectiveModeCounts: { "edge-extension": 1 } });
  });
});
