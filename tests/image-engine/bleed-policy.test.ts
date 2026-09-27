import { describe, expect, it } from "vitest";
import { resolveBleedSourcePolicy } from "../../image-engine/bleed/policy";

describe("bleed source policy", () => {
  it.each([
    ["Scryfall classic black border", "scryfall", "png", { fullArt: false, borderColor: "black" }],
    ["Scryfall full-art", "scryfall", "png", { fullArt: true }],
    ["Scryfall borderless", "scryfall", "png", { borderColor: "borderless" }],
    ["local upload", "upload", "png", undefined],
    ["MPC", "mpc", "png", undefined],
  ] as const)("uses the same immediate-edge policy for %s", (_label, source, format, metadata) => {
    expect(resolveBleedSourcePolicy({ source, format, metadata })).toMatchObject({
      requestedMode: "auto",
      mode: "edge-extension",
      policyId: "edge-extension-v1",
    });
  });

  it("does not let full-art metadata change the automatic raster algorithm", () => {
    const classic = resolveBleedSourcePolicy({ source: "scryfall", format: "png", metadata: { fullArt: false, borderColor: "black" } });
    const fullArt = resolveBleedSourcePolicy({ source: "scryfall", format: "png", metadata: { fullArt: true, borderColor: "borderless" } });
    expect(resolveBleedSourcePolicy({ source: "scryfall", format: "application/octet-stream" })).toMatchObject({
      mode: "edge-extension",
      policyId: "edge-extension-v1",
    });
    expect(fullArt).toEqual(classic);
  });

  it("uses the single edge-extension policy for an explicit matching override", () => {
    expect(resolveBleedSourcePolicy({ source: "upload", format: "png", override: "edge-extension" })).toMatchObject({
      requestedMode: "edge-extension",
      mode: "edge-extension",
      policyId: "edge-extension-v1",
    });
  });
});
