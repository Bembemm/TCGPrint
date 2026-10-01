import { describe, expect, it } from "vitest";
import type { BackLibraryAssetReference, WorkingCard } from "../../core/cards/types";
import { createBackValidationSummary, exportModeRequiresFrontArtwork, resolveBackForMissingPolicy } from "../../src/app/back-validation";

const projectBack: BackLibraryAssetReference = { assetId: `back:${"a".repeat(64)}`, sha256: "a".repeat(64), format: "png" };

const unresolvedDfc: WorkingCard = {
  id: "unresolved-dfc", quantity: 1, order: 0,
  importSource: { sourceId: "source:dfc", importKind: "fixture", entryKind: "card" },
  identityHints: { name: "Front // Back" },
  identity: { id: "scryfall:oracle:dfc", provider: "scryfall", name: "Front // Back", resolutionMethod: "manual", confidence: 1,
    metadata: { layout: "transform", faces: [{ name: "Front" }, { name: "Back" }] } },
  identityResolution: { status: "resolved", candidates: [], confirmed: true },
  faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
  selectedArtworkByFace: {},
  backMode: "auto", backModeSelectionPolicy: "automatic", localArtworkIds: [], mpcReferences: [], faceAssociations: [],
};

describe("back validation UI policy", () => {
  it("requires front artwork by export mode while keeping back-only reprints independent", () => {
    expect(exportModeRequiresFrontArtwork("front-only")).toBe(true);
    expect(exportModeRequiresFrontArtwork("back-only")).toBe(false);
    expect(exportModeRequiresFrontArtwork("front-back-separated")).toBe(true);
    expect(exportModeRequiresFrontArtwork("duplex")).toBe(true);
  });

  it("shows an unresolved DFC as missing under use-default and block policies even when Project default exists", () => {
    const useDefault = createBackValidationSummary([unresolvedDfc], projectBack, "use-project-default");
    const block = createBackValidationSummary([unresolvedDfc], projectBack, "block");

    expect(resolveBackForMissingPolicy(unresolvedDfc, projectBack, "use-project-default")).toMatchObject({ mode: "auto", status: "missing" });
    expect(useDefault).toMatchObject({
      dfcPhysicalCards: 1,
      simplePhysicalCards: 0,
      backs: { auto: 1, projectDefault: 0, manual: 0, noneOrMissing: 0 },
      missing: [{ cardId: "unresolved-dfc", reason: "face traseira da carta dupla-face ainda não foi resolvida" }],
      warnings: [{ cardId: "unresolved-dfc" }],
      blockers: [],
    });
    expect(block).toMatchObject({ missing: [{ cardId: "unresolved-dfc" }], warnings: [], blockers: [{ cardId: "unresolved-dfc" }] });
  });

  it("reports a normal card as inheriting the configured Project default", () => {
    const normal: WorkingCard = {
      ...unresolvedDfc,
      id: "normal",
      identity: null,
      identityHints: { name: "Sol Ring" },
      faces: [{ id: "front", side: "front", name: "Sol Ring" }],
      backMode: "project-default",
    };
    const result = createBackValidationSummary([normal], projectBack, "use-project-default");

    expect(resolveBackForMissingPolicy(normal, projectBack, "use-project-default")).toMatchObject({ mode: "project-default", status: "available" });
    expect(result).toMatchObject({ backs: { projectDefault: 1 }, missing: [], warnings: [], blockers: [] });
  });
});
