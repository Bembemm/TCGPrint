import { describe, expect, it } from "vitest";
import { resolveSmartBorderFillConfig, SMART_BORDER_FILL_CONFIG_VERSION } from "../../image-engine/bleed";
import { resolveBleedSourcePolicy } from "../../image-engine/bleed/policy";

describe("bleed source policy", () => {
  it("selects source defaults, preserves SVG behavior, marks unknown MPC metadata, and honors overrides", () => {
    expect(resolveBleedSourcePolicy({ source: "scryfall", format: "png" })).toMatchObject({
      requestedMode: "auto",
      mode: "smart-border-fill",
      policyId: "scryfall-raster-auto-v1",
    });
    expect(resolveBleedSourcePolicy({ source: "upload", format: "png" })).toMatchObject({
      requestedMode: "auto",
      mode: "subtle-edge-stretch",
      policyId: "local-raster-subtle-v1",
    });
    expect(resolveBleedSourcePolicy({ source: "scryfall", format: "svg" })).toMatchObject({
      mode: "subtle-edge-stretch",
      policyId: "svg-vector-preserved-v1",
    });
    expect(resolveBleedSourcePolicy({ source: "mpc", format: "png" })).toMatchObject({
      mode: "subtle-edge-stretch",
      policyId: "mpc-metadata-unknown-conservative-v1",
      notice: "MPC_BLEED_METADATA_UNKNOWN",
    });
    expect(resolveBleedSourcePolicy({ source: "upload", format: "png", override: "smart-border-fill" })).toMatchObject({
      requestedMode: "smart-border-fill",
      mode: "smart-border-fill",
      policyId: "manual-override-upload-smart-border-fill-v1",
    });
  });

  it("keeps every Scryfall raster on smart policy and lets pixel confidence choose the side fallback", () => {
    expect(resolveBleedSourcePolicy({ source: "scryfall", format: "png", metadata: { fullArt: true } })).toMatchObject({
      mode: "smart-border-fill",
      policyId: "scryfall-raster-auto-v1",
    });
    expect(resolveBleedSourcePolicy({ source: "scryfall", format: "png", metadata: { borderColor: "borderless" } })).toMatchObject({
      mode: "smart-border-fill",
      policyId: "scryfall-raster-auto-v1",
    });
  });

  it("does not assign raster smart fill to an unknown Scryfall format", () => {
    expect(resolveBleedSourcePolicy({ source: "scryfall", format: "application/octet-stream" })).toMatchObject({
      mode: "subtle-edge-stretch",
      policyId: "scryfall-unknown-format-subtle-v1",
    });
  });

  it("keeps the threshold version centralized when applying configurable values", () => {
    const config = resolveSmartBorderFillConfig({ version: "unversioned-override" } as never);

    expect(config.version).toBe(SMART_BORDER_FILL_CONFIG_VERSION);
  });
});
