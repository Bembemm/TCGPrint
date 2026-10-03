import { describe, expect, it, vi } from "vitest";
import type { ImportResult, ImportedEntry } from "../../../import-engine/types";
import { createWorkingSet } from "../../../core/cards/working-set";
import { IdentityResolver, confirmIdentity, keepCustom, selectDefaultArtwork, selectDefaultArtworkForFace } from "../../../core/cards/identity-resolver";
import * as identityResolver from "../../../core/cards/identity-resolver";
import { DEFAULT_ARTWORK_POLICY_ID } from "../../../core/cards/identity-policy";
import type { ArtworkCandidate, CardIdentity } from "../../../core/cards/types";
import type { ScryfallCard } from "../../../providers/scryfall/types";
import type { ScryfallClient } from "../../../providers/scryfall/client";

const sol: ScryfallCard = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", oracleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Sol Ring", layout: "normal", setCode: "cmm", collectorNumber: "396", lang: "en", releasedAt: "2023-08-04", digital: false, promo: false, fullArt: false, borderColor: "black", imageStatus: "highres_scan", imageUris: { png: "https://cards.scryfall.io/png/sol.png" }, faces: [], relatedCards: [], metadata: {} };
const island: ScryfallCard = { ...sol, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", oracleId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Island", collectorNumber: "265", setCode: "m21" };
function importResult(entries: readonly ImportedEntry[]): ImportResult {
  return { sources: [], detections: [], entries, report: { summary: { totalInputs: 0, recognizedInputs: 0, recognizedEntries: entries.length, customCards: 0, deckEntries: entries.length, assets: 0, warnings: 0, errors: 0, ambiguousDetections: 0, unknownInputs: 0 }, selectedImporters: [], detections: [], warnings: [], errors: [], mappings: [], pairings: [] } };
}
function card(hint: ImportedEntry["cardHint"], filename = "") {
  const entry: ImportedEntry = { id: "entry", kind: "deck-card", order: 0, quantity: 6, sourceId: "paste", sourceFilename: filename || undefined, cardHint: hint };
  return createWorkingSet(importResult([entry]), { idFactory: () => "working-stable" })[0];
}
function fakeClient(overrides: Partial<Record<"lookupById" | "lookupBySetCollector" | "lookupByName" | "searchCards", (...args: any[]) => any>> = {}) {
  return {
    lookupById: vi.fn(overrides.lookupById ?? (async () => sol)),
    lookupBySetCollector: vi.fn(overrides.lookupBySetCollector ?? (async () => island)),
    lookupByName: vi.fn(overrides.lookupByName ?? (async (name: string) => name.toLowerCase() === "sol ring" ? sol : Promise.reject(Object.assign(new Error("not found"), { kind: "not-found" })))),
    searchCards: vi.fn(overrides.searchCards ?? (async () => [sol])),
  } as unknown as ScryfallClient;
}

const uploadSelection = { front: { candidateId: "upload:hash", source: "upload" as const, identityId: null, faceId: "front" as const } };

describe("identity resolver", () => {
  it("resolves explicit back modes without borrowing MPC shared cardbacks", () => {
    const helpers = identityResolver as unknown as {
      resolveEffectiveCardBack?: (card: unknown, projectDefault?: { assetId: string; sha256: string; format: "jpeg" | "png" }) => unknown;
      isDoubleFacedIdentity?: (identity: CardIdentity | null) => boolean;
    };
    expect(helpers.isDoubleFacedIdentity).toBeTypeOf("function");
    expect(helpers.resolveEffectiveCardBack).toBeTypeOf("function");
    if (!helpers.isDoubleFacedIdentity || !helpers.resolveEffectiveCardBack) return;

    const identity: CardIdentity = {
      id: "scryfall:oracle:dfc",
      provider: "scryfall",
      name: "Front // Back",
      resolutionMethod: "scryfall-id",
      confidence: 1,
      metadata: { layout: "transform", faces: [{ name: "Front" }, { name: "Back" }] },
    };
    const front = card({ name: "Front" });
    const dfc = {
      ...front,
      identity,
      faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }],
      selectedArtworkByFace: {
        back: { candidateId: "scryfall:dfc:back", source: "scryfall" as const, identityId: identity.id, faceId: "back" as const },
      },
      backMode: "auto" as const,
    };
    const generic = { assetId: "back:asset-id", sha256: "a".repeat(64), format: "png" as const };
    const normal = {
      ...front,
      sharedMpcCardback: {
        importedAssetId: "mpc-root-cardback",
        originalFormat: "png",
        availableLocally: true,
        provenance: { sourceId: "order.xml" },
      },
      backMode: "project-default" as const,
    };
    const manual = { ...normal, backMode: "manual" as const, manualBackAsset: generic };
    const noBack = { ...normal, backMode: "none" as const };

    expect(helpers.isDoubleFacedIdentity(identity)).toBe(true);
    expect(helpers.isDoubleFacedIdentity({ ...identity, metadata: { layout: "split", faces: [{ name: "Fire" }, { name: "Ice" }] } })).toBe(false);
    expect(helpers.resolveEffectiveCardBack(dfc)).toMatchObject({ mode: "auto", status: "available", source: "dfc-face", artwork: { candidateId: "scryfall:dfc:back" } });
    expect(helpers.resolveEffectiveCardBack(normal, generic)).toMatchObject({ mode: "project-default", status: "available", source: "project-default", asset: generic });
    expect(helpers.resolveEffectiveCardBack(manual)).toMatchObject({ mode: "manual", status: "available", source: "manual-library", asset: generic });
    expect(helpers.resolveEffectiveCardBack(noBack, generic)).toMatchObject({ mode: "none", status: "intentional-none", source: "none" });
    expect(helpers.resolveEffectiveCardBack(normal)).toMatchObject({ mode: "project-default", status: "missing", source: "project-default" });
  });

  it("resolves an explicit Scryfall ID before weaker textual identity work", async () => {
    const api = fakeClient();
    const resolver = new IdentityResolver(api);
    const result = await resolver.resolve(card({ name: "Island", setCode: "m21", collectorNumber: "265", scryfallId: sol.id }, "Sol Ring.png"));
    expect(result.identity).toMatchObject({ name: "Sol Ring", scryfallId: sol.id, oracleId: sol.oracleId, resolutionMethod: "scryfall-id" });
    expect(api.lookupById).toHaveBeenCalledOnce();
    expect(api.lookupBySetCollector).not.toHaveBeenCalled();
    expect(api.lookupByName).not.toHaveBeenCalled();
    expect(api.searchCards).not.toHaveBeenCalled();
  });

  it("uses set plus collector before an explicit name", async () => {
    const api = fakeClient();
    const resolved = await new IdentityResolver(api).resolve(card({ name: "Sol Ring", setCode: "m21", collectorNumber: "265" }));
    expect(resolved.identity).toMatchObject({ name: "Island", resolutionMethod: "set-collector" });
    expect(api.lookupBySetCollector).toHaveBeenCalledOnce();
    expect(api.lookupByName).not.toHaveBeenCalled();
  });

  it("resolves exact explicit names", async () => {
    const api = fakeClient();
    const resolver = new IdentityResolver(api);
    const named = await resolver.resolve(card({ name: "Sol Ring" }));
    expect(named.identity).toMatchObject({ id: `scryfall:oracle:${sol.oracleId}`, name: "Sol Ring", resolutionMethod: "name" });
  });

  it("uses fuzzy matching for an explicit text hint after exact lookup misses", async () => {
    const api = fakeClient({ lookupByName: async () => Promise.reject(Object.assign(new Error("not found"), { kind: "not-found" })), searchCards: async () => [sol] });
    const result = await new IdentityResolver(api).resolve(card({ name: "Sol Rin" }, "unrelated-upload.png"));
    expect(result.identity).toBeNull();
    expect(result.identityResolution).toMatchObject({ status: "suggested", method: "fuzzy", query: "Sol Rin", candidates: [{ identity: { name: "Sol Ring" } }] });
    expect(api.searchCards).toHaveBeenCalledOnce();
  });

  it("never resolves a custom image from its filename, even when its status is reprocessed", async () => {
    const api = fakeClient();
    const entry: ImportedEntry = {
      id: "island-image", kind: "custom-card", order: 0, quantity: 1, sourceId: "upload",
      sourceFilename: "Island.png", nameSuggestion: "Island", asset: { id: "island-asset", sourceId: "upload", originalFormat: "png", originalBytes: new Uint8Array([1, 2, 3]) },
    };
    const [custom] = createWorkingSet(importResult([entry]));
    const result = await new IdentityResolver(api).resolve({
      ...custom,
      identityResolution: { ...custom.identityResolution, confirmed: false },
    });

    expect(result).toMatchObject({ identity: null, identityResolution: { status: "custom" } });
    expect(api.lookupById).not.toHaveBeenCalled();
    expect(api.lookupBySetCollector).not.toHaveBeenCalled();
    expect(api.lookupByName).not.toHaveBeenCalled();
    expect(api.searchCards).not.toHaveBeenCalled();
  });

  it("uses an explicit cardHint on a custom image and ignores its display label", async () => {
    const api = fakeClient();
    const entry: ImportedEntry = {
      id: "hinted-image", kind: "custom-card", order: 0, quantity: 1, sourceId: "upload",
      sourceFilename: "Island.png", nameSuggestion: "Island", cardHint: { name: "Sol Ring" },
      asset: { id: "hinted-asset", sourceId: "upload", originalFormat: "png", originalBytes: new Uint8Array([1]) },
    };
    const [custom] = createWorkingSet(importResult([entry]));

    const resolved = await new IdentityResolver(api).resolve(custom);

    expect(resolved.identity).toMatchObject({ name: "Sol Ring", resolutionMethod: "name" });
    expect(api.lookupByName).toHaveBeenCalledExactlyOnceWith("Sol Ring", "exact", expect.anything());
  });

  it.each(["filename", "ocr"] as const)("preserves a legacy custom upload resolved by %s without re-running provider lookup", async (method) => {
    const api = fakeClient();
    const entry: ImportedEntry = {
      id: "legacy-image", kind: "custom-card", order: 0, quantity: 1, sourceId: "upload",
      sourceFilename: "Island.png", nameSuggestion: "Island", asset: { id: "legacy-asset", sourceId: "upload", originalFormat: "png" },
    };
    const [custom] = createWorkingSet(importResult([entry]));
    const legacyIdentity = { id: "scryfall:oracle:legacy-island", provider: "scryfall", name: "Island", resolutionMethod: method, confidence: 0.99 } as const;
    const legacy = {
      ...custom,
      identityHints: { name: "Island" },
      identity: legacyIdentity,
      identityResolution: { status: "resolved" as const, method, query: "Island", confirmed: false, candidates: [] },
    };

    const preserved = await new IdentityResolver(api).resolve(legacy);

    expect(preserved).toEqual(legacy);
    expect(api.lookupById).not.toHaveBeenCalled();
    expect(api.lookupBySetCollector).not.toHaveBeenCalled();
    expect(api.lookupByName).not.toHaveBeenCalled();
    expect(api.searchCards).not.toHaveBeenCalled();
  });

  it("does not overwrite an identity or local selection after user confirmation and supports custom", async () => {
    const identified = await new IdentityResolver(fakeClient()).resolve(card({ name: "Sol Ring" }));
    const confirmed = confirmIdentity({ ...identified, selectedArtworkByFace: uploadSelection, localArtworkIds: ["upload:hash"] }, { id: "manual:island", provider: "scryfall", name: "Island", resolutionMethod: "manual", confidence: 1 });
    const rerun = await new IdentityResolver(fakeClient()).resolve(confirmed);
    expect(rerun.identity?.id).toBe("manual:island");
    expect(rerun.selectedArtworkByFace).toEqual(uploadSelection);
    expect(rerun.localArtworkIds).toEqual(["upload:hash"]);
    const custom = keepCustom(confirmed);
    expect(await new IdentityResolver(fakeClient()).resolve(custom)).toMatchObject({ identity: null, identityResolution: { status: "custom", confirmed: true } });
    expect(custom.selectedArtworkByFace).toEqual(confirmed.selectedArtworkByFace);
  });

  it("preserves user-selected faces but invalidates default artwork tied to the previous identity", () => {
    const original = card({ name: "Sol Ring" });
    const oldIdentity: CardIdentity = { id: `scryfall:oracle:${sol.oracleId}`, provider: "scryfall", name: sol.name, scryfallId: sol.id, oracleId: sol.oracleId, resolutionMethod: "name", confidence: 1 };
    const nextIdentity: CardIdentity = { id: `scryfall:oracle:${island.oracleId}`, provider: "scryfall", name: island.name, scryfallId: island.id, oracleId: island.oracleId, resolutionMethod: "manual", confidence: 1 };
    const userFront = { candidateId: `scryfall:${sol.id}:front`, source: "scryfall" as const, identityId: oldIdentity.id, faceId: "front" as const, selectionPolicy: "user-selected" };
    const oldDefaultBack = { candidateId: `scryfall:${sol.id}:back`, source: "scryfall" as const, identityId: oldIdentity.id, faceId: "back" as const, selectionPolicy: DEFAULT_ARTWORK_POLICY_ID };
    const previous = {
      ...original,
      localArtworkIds: ["upload:local-asset"],
      mpcReferences: [{ faceId: "back", importedAssetId: "mpc:reference", slots: ["A1"], availableLocally: false }],
      faceAssociations: [{ slot: "paired", frontAssetId: "upload:local-asset", backAssetId: "mpc:reference", confidence: 0.8, accepted: false }],
      faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }],
      identity: oldIdentity,
      identityResolution: { status: "resolved" as const, method: "name" as const, candidates: [], confirmed: false },
      selectedArtworkByFace: { front: userFront, back: oldDefaultBack },
    };
    const before = structuredClone(previous);

    const changed = confirmIdentity(previous, nextIdentity);

    expect(changed).toMatchObject({
      id: previous.id,
      quantity: previous.quantity,
      order: previous.order,
      importSource: previous.importSource,
      identityHints: previous.identityHints,
      localArtworkIds: previous.localArtworkIds,
      mpcReferences: previous.mpcReferences,
      faceAssociations: previous.faceAssociations,
      identity: nextIdentity,
      identityResolution: { status: "resolved", method: "manual", confirmed: true },
      selectedArtworkByFace: { front: userFront },
    });
    expect(changed.selectedArtworkByFace.back).toBeUndefined();
    expect(previous).toEqual(before);
  });

  it("restores only the requested face and leaves the prior selection intact when no default exists", () => {
    const identity: CardIdentity = { id: "scryfall:oracle:delver", provider: "scryfall", name: "Delver of Secrets // Insectile Aberration", resolutionMethod: "name", confidence: 1, metadata: { layout: "transform", faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] } };
    const original = {
      ...card({ name: "Delver of Secrets // Insectile Aberration" }),
      faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }],
      identity,
      identityResolution: { status: "resolved" as const, method: "name" as const, candidates: [], confirmed: false },
      selectedArtworkByFace: {
        front: { candidateId: "mpc:manual-front", source: "mpc" as const, identityId: identity.id, faceId: "front" as const, selectionPolicy: "user-selected" },
        back: { candidateId: "mpc:manual-back", source: "mpc" as const, identityId: identity.id, faceId: "back" as const, selectionPolicy: "user-selected" },
      },
    };
    const candidates = [
      {
        id: "scryfall:older-print:back",
        source: "scryfall" as const,
        identityId: identity.id,
        faceId: "back" as const,
        scryfallId: "older-print",
        providerAssetId: "older-print",
        originalAvailable: true,
        language: "en",
        releasedAt: "2023-01-01",
        metadata: { digital: false, imageStatus: "highres_scan" },
      },
      {
        id: "scryfall:newer-print:back",
        source: "scryfall" as const,
        identityId: identity.id,
        faceId: "back" as const,
        scryfallId: "newer-print",
        providerAssetId: "newer-print",
        originalAvailable: true,
        language: "en",
        releasedAt: "2025-01-01",
        metadata: { digital: false, imageStatus: "highres_scan" },
      },
    ];
    const selectForFace = (identityResolver as unknown as Record<string, unknown>).selectDefaultArtworkForFace as
      ((workingCard: ReturnType<typeof card>, side: "front" | "back", artwork: readonly ArtworkCandidate[]) => ReturnType<typeof card> | undefined) | undefined;

    expect(selectForFace).toBeTypeOf("function");
    const restored = selectForFace!(original, "back", candidates);
    const restoredWithReversedProviderOrder = selectForFace!(original, "back", [...candidates].reverse());

    expect(restored?.selectedArtworkByFace.front).toEqual(original.selectedArtworkByFace.front);
    expect(restored?.selectedArtworkByFace.back).toMatchObject({
      candidateId: "scryfall:newer-print:back",
      selectionPolicy: DEFAULT_ARTWORK_POLICY_ID,
    });
    expect(restoredWithReversedProviderOrder?.selectedArtworkByFace.back?.candidateId).toBe("scryfall:newer-print:back");
    expect(selectForFace!(original, "back", [])).toBeUndefined();
    expect(original.selectedArtworkByFace.back).toEqual({
      candidateId: "mpc:manual-back",
      source: "mpc",
      identityId: identity.id,
      faceId: "back",
      selectionPolicy: "user-selected",
    });
  });

  it("does not assign a default Back face to a known simple identity", () => {
    const simpleIdentity: CardIdentity = {
      id: "scryfall:oracle:island",
      provider: "scryfall",
      name: "Island",
      resolutionMethod: "name",
      confidence: 1,
      metadata: { layout: "normal", faces: [{ name: "Island" }] },
    };
    const simpleWithForgedBack = {
      ...card({ name: "Island" }),
      identity: simpleIdentity,
      identityResolution: { status: "resolved" as const, method: "name" as const, candidates: [], confirmed: false },
      faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }],
      selectedArtworkByFace: {},
    };
    const candidate: ArtworkCandidate = {
      id: "scryfall:island-print:back",
      source: "scryfall",
      identityId: simpleIdentity.id,
      faceId: "back",
      scryfallId: "island-print",
      originalAvailable: true,
      language: "en",
      releasedAt: "2025-01-01",
      metadata: { digital: false, imageStatus: "highres_scan" },
    };

    expect(selectDefaultArtworkForFace(simpleWithForgedBack, "back", [candidate])).toBeUndefined();
    expect(selectDefaultArtwork(simpleWithForgedBack, [candidate]).selectedArtworkByFace.back).toBeUndefined();
  });

  it("selects deterministic name defaults only after checking existing, Scryfall ID, and set/collector selections", () => {
    const identified = { ...card({ name: "Sol Ring" }), identity: { id: `scryfall:oracle:${sol.oracleId}`, provider: "scryfall", name: "Sol Ring", oracleId: sol.oracleId, resolutionMethod: "name", confidence: 1 } satisfies CardIdentity, identityResolution: { status: "resolved" as const, method: "name" as const, candidates: [], confirmed: false } };
    const candidates = [
      { id: "old", source: "scryfall" as const, identityId: identified.identity.id, faceId: "front" as const, scryfallId: "old", originalAvailable: true, setCode: "abc", collectorNumber: "1", language: "en", releasedAt: "2020-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
      { id: "new", source: "scryfall" as const, identityId: identified.identity.id, faceId: "front" as const, scryfallId: "new", originalAvailable: true, setCode: "def", collectorNumber: "4", language: "en", releasedAt: "2024-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
      { id: "tie-10", source: "scryfall" as const, identityId: identified.identity.id, faceId: "front" as const, scryfallId: "tie-10", originalAvailable: true, setCode: "abc", collectorNumber: "10", language: "en", releasedAt: "2024-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
      { id: "tie-2", source: "scryfall" as const, identityId: identified.identity.id, faceId: "front" as const, scryfallId: "tie-2", originalAvailable: true, setCode: "abc", collectorNumber: "2", language: "en", releasedAt: "2024-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
      { id: "not-english", source: "scryfall" as const, identityId: identified.identity.id, faceId: "front" as const, scryfallId: "not-english", originalAvailable: true, setCode: "aaa", collectorNumber: "1", language: "ja", releasedAt: "2025-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
      { id: "digital", source: "scryfall" as const, identityId: identified.identity.id, faceId: "front" as const, scryfallId: "digital", originalAvailable: true, setCode: "aaa", collectorNumber: "2", language: "en", releasedAt: "2025-01-01", metadata: { digital: true, imageStatus: "highres_scan" } },
      { id: "upload", source: "upload" as const, identityId: identified.identity.id, faceId: "front" as const, originalAvailable: true, setCode: "aaa", collectorNumber: "3", language: "en", releasedAt: "2025-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
    ];
    expect(selectDefaultArtwork(identified, candidates).selectedArtworkByFace.front?.candidateId).toBe("tie-2");
    const alreadySelected = { ...identified, selectedArtworkByFace: uploadSelection };
    expect(selectDefaultArtwork(alreadySelected, candidates).selectedArtworkByFace).toEqual(uploadSelection);
    const mpcSelected = { ...identified, selectedArtworkByFace: { front: { candidateId: "mpc:reference", source: "mpc" as const, identityId: identified.identity.id, faceId: "front" as const, selectedArtworkId: "external-choice" } } };
    expect(selectDefaultArtwork(mpcSelected, candidates).selectedArtworkByFace).toEqual(mpcSelected.selectedArtworkByFace);
    const explicitId = { ...identified, identityHints: { scryfallId: "old" } };
    expect(selectDefaultArtwork(explicitId, candidates).selectedArtworkByFace.front?.candidateId).toBe("old");
    const setCollector = { ...identified, identityHints: { setCode: "abc", collectorNumber: "1" } };
    expect(selectDefaultArtwork(setCollector, candidates).selectedArtworkByFace.front?.candidateId).toBe("old");
  });

  it("honors explicit printing hints when the editor resets a face", () => {
    const identified = { ...card({ name: "Sol Ring" }), identity: { id: `scryfall:oracle:${sol.oracleId}`, provider: "scryfall", name: "Sol Ring", oracleId: sol.oracleId, resolutionMethod: "name", confidence: 1 } satisfies CardIdentity };
    const candidates: ArtworkCandidate[] = [
      { id: "old", source: "scryfall", identityId: identified.identity.id, faceId: "front", scryfallId: "old", originalAvailable: true, setCode: "abc", collectorNumber: "1", language: "en", releasedAt: "2020-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
      { id: "new", source: "scryfall", identityId: identified.identity.id, faceId: "front", scryfallId: "new", originalAvailable: true, setCode: "def", collectorNumber: "4", language: "en", releasedAt: "2024-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
    ];
    const selectForFace = (identityResolver as unknown as Record<string, unknown>).selectDefaultArtworkForFace as
      ((workingCard: ReturnType<typeof card>, side: "front" | "back", artwork: readonly ArtworkCandidate[]) => ReturnType<typeof card> | undefined) | undefined;
    const byScryfallId = { ...identified, identityHints: { ...identified.identityHints, scryfallId: "old" } };
    const bySetCollector = { ...identified, identityHints: { setCode: "abc", collectorNumber: "1" } };

    expect(selectForFace).toBeTypeOf("function");
    expect(selectForFace!(byScryfallId, "front", candidates)?.selectedArtworkByFace.front?.candidateId).toBe("old");
    expect(selectForFace!(bySetCollector, "front", candidates)?.selectedArtworkByFace.front?.candidateId).toBe("old");
  });

  it("falls back deterministically when an explicit printing hint has no matching candidate", () => {
    const identified = { ...card({ name: "Sol Ring" }), identity: { id: `scryfall:oracle:${sol.oracleId}`, provider: "scryfall", name: "Sol Ring", oracleId: sol.oracleId, resolutionMethod: "manual", confidence: 1 } satisfies CardIdentity };
    const candidates: ArtworkCandidate[] = [
      { id: "old", source: "scryfall", identityId: identified.identity.id, faceId: "front", scryfallId: "old", originalAvailable: true, setCode: "abc", collectorNumber: "1", language: "en", releasedAt: "2020-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
      { id: "new", source: "scryfall", identityId: identified.identity.id, faceId: "front", scryfallId: "new", originalAvailable: true, setCode: "def", collectorNumber: "4", language: "en", releasedAt: "2024-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
    ];
    const selectForFace = (identityResolver as unknown as Record<string, unknown>).selectDefaultArtworkForFace as
      ((workingCard: ReturnType<typeof card>, side: "front" | "back", artwork: readonly ArtworkCandidate[]) => ReturnType<typeof card> | undefined) | undefined;
    const staleHint = { ...identified, identityHints: { ...identified.identityHints, scryfallId: "missing-printing" } };

    expect(selectForFace).toBeTypeOf("function");
    expect(selectForFace!(staleHint, "front", candidates)?.selectedArtworkByFace.front?.candidateId).toBe("new");
    expect(selectForFace!(staleHint, "front", [...candidates].reverse())?.selectedArtworkByFace.front?.candidateId).toBe("new");
  });

  it("restores the newest eligible default for a confirmed manual identity", () => {
    const identity: CardIdentity = { id: "scryfall:oracle:island", provider: "scryfall", name: "Island", scryfallId: "manual-print", resolutionMethod: "manual", confidence: 1 };
    const manual = {
      ...card({ name: "Island" }),
      identity,
      identityResolution: { status: "resolved" as const, method: "manual" as const, candidates: [], confirmed: true },
    };
    const candidates = [
      { id: "scryfall:new-print:front", source: "scryfall" as const, identityId: identity.id, faceId: "front" as const, scryfallId: "new-print", originalAvailable: true, language: "en", releasedAt: "2025-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
      { id: "scryfall:manual-print:front", source: "scryfall" as const, identityId: identity.id, faceId: "front" as const, scryfallId: "manual-print", originalAvailable: true, language: "en", releasedAt: "2020-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
    ];
    const selectForFace = (identityResolver as unknown as Record<string, unknown>).selectDefaultArtworkForFace as
      ((workingCard: ReturnType<typeof card>, side: "front" | "back", artwork: readonly ArtworkCandidate[]) => ReturnType<typeof card> | undefined) | undefined;

    expect(selectForFace).toBeTypeOf("function");
    expect(selectForFace!(manual, "front", candidates)?.selectedArtworkByFace.front?.candidateId).toBe("scryfall:new-print:front");
    expect(selectDefaultArtwork(manual, candidates).selectedArtworkByFace.front).toBeUndefined();
  });

  it("prefers the other DFC face's Scryfall printing when resetting a face", () => {
    const identity: CardIdentity = { id: "scryfall:oracle:delver", provider: "scryfall", name: "Delver of Secrets // Insectile Aberration", resolutionMethod: "manual", confidence: 1, metadata: { layout: "transform", faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] } };
    const identified = {
      ...card({ name: identity.name }),
      faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }],
      identity,
      identityResolution: { status: "resolved" as const, method: "manual" as const, candidates: [], confirmed: true },
      selectedArtworkByFace: {
        front: { candidateId: "scryfall:old-print:front", source: "scryfall" as const, identityId: identity.id, faceId: "front" as const, providerAssetId: "old-print", selectionPolicy: DEFAULT_ARTWORK_POLICY_ID },
        back: undefined,
      },
    };
    const candidates = [
      { id: "scryfall:new-print:back", source: "scryfall" as const, identityId: identity.id, faceId: "back" as const, scryfallId: "new-print", providerAssetId: "new-print", originalAvailable: true, language: "en", releasedAt: "2025-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
      { id: "scryfall:old-print:back", source: "scryfall" as const, identityId: identity.id, faceId: "back" as const, scryfallId: "old-print", providerAssetId: "old-print", originalAvailable: true, language: "en", releasedAt: "2023-01-01", metadata: { digital: false, imageStatus: "highres_scan" } },
    ];
    const selectForFace = (identityResolver as unknown as Record<string, unknown>).selectDefaultArtworkForFace as
      ((workingCard: ReturnType<typeof card>, side: "front" | "back", artwork: readonly ArtworkCandidate[]) => ReturnType<typeof card> | undefined) | undefined;

    expect(selectForFace).toBeTypeOf("function");
    expect(selectForFace!(identified, "back", candidates)?.selectedArtworkByFace.back?.candidateId).toBe("scryfall:old-print:back");
  });

  it("chooses a single complete printing for automatic DFC faces instead of mixing an incomplete newest printing", () => {
    const identified = {
      ...card({ name: "Delver of Secrets // Insectile Aberration" }),
      faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }],
      identity: { id: "scryfall:oracle:delver", provider: "scryfall", name: "Delver of Secrets // Insectile Aberration", oracleId: "delver", resolutionMethod: "name" as const, confidence: 1, metadata: { layout: "transform", faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] } },
      identityResolution: { status: "resolved" as const, method: "name" as const, candidates: [], confirmed: false },
    };
    const printing = (scryfallId: string, faceId: "front" | "back", releasedAt: string, originalAvailable = true) => ({
      id: `scryfall:${scryfallId}:${faceId}`,
      source: "scryfall" as const,
      identityId: identified.identity.id,
      faceId,
      scryfallId,
      providerAssetId: scryfallId,
      originalAvailable,
      language: "en",
      releasedAt,
      metadata: { digital: false, imageStatus: "highres_scan" },
    });
    const candidates = [
      printing("new-print", "front", "2025-01-01"),
      printing("new-print", "back", "2025-01-01", false),
      printing("old-print", "front", "2023-01-01"),
      printing("old-print", "back", "2023-01-01"),
    ];

    const selected = selectDefaultArtwork(identified, candidates).selectedArtworkByFace;

    expect(selected.front?.providerAssetId).toBe("old-print");
    expect(selected.back?.providerAssetId).toBe("old-print");
    expect(selected.front?.candidateId).toBe("scryfall:old-print:front");
    expect(selected.back?.candidateId).toBe("scryfall:old-print:back");

    const uploadSelection = { candidateId: "upload:local-front", source: "upload" as const, identityId: identified.identity.id, faceId: "front" as const };
    const mixed = selectDefaultArtwork({ ...identified, selectedArtworkByFace: { front: uploadSelection } }, candidates).selectedArtworkByFace;
    expect(mixed.front).toEqual(uploadSelection);
    expect(mixed.back).toMatchObject({ source: "scryfall", providerAssetId: "old-print", candidateId: "scryfall:old-print:back" });

    const explicitFront = { candidateId: "scryfall:old-print:front", source: "scryfall" as const, identityId: identified.identity.id, faceId: "front" as const, providerAssetId: "old-print", selectionPolicy: "user-selected" };
    const explicit = selectDefaultArtwork({ ...identified, selectedArtworkByFace: { front: explicitFront } }, candidates).selectedArtworkByFace;
    expect(explicit.front).toEqual(explicitFront);
    expect(explicit.back?.providerAssetId).toBe("old-print");
  });
});
