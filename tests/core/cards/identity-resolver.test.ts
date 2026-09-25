import { describe, expect, it, vi } from "vitest";
import type { ImportResult, ImportedEntry } from "../../../import-engine/types";
import { createWorkingSet } from "../../../core/cards/working-set";
import { IdentityResolver, confirmIdentity, keepCustom, selectDefaultArtwork } from "../../../core/cards/identity-resolver";
import type { CardIdentity } from "../../../core/cards/types";
import type { ScryfallCard } from "../../../providers/scryfall/types";
import type { ScryfallClient } from "../../../providers/scryfall/client";
import type { OcrRecognizer } from "../../../providers/ocr/types";

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
  it("resolves explicit Scryfall ID before set, name, filename, OCR, or fuzzy work", async () => {
    const api = fakeClient();
    const resolver = new IdentityResolver(api);
    const result = await resolver.resolve(card({ name: "Island", setCode: "m21", collectorNumber: "265", scryfallId: sol.id }, "Sol Ring.png"), { imageBytes: new Uint8Array([1]) });
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

  it("resolves exact explicit names and exact normalized filenames after stronger metadata", async () => {
    const api = fakeClient();
    const resolver = new IdentityResolver(api);
    const named = await resolver.resolve(card({ name: "Sol Ring" }));
    expect(named.identity).toMatchObject({ id: `scryfall:oracle:${sol.oracleId}`, name: "Sol Ring", resolutionMethod: "name" });
    const uploaded = card(undefined, "Sol_Ring_custom.png");
    const filename = await resolver.resolve(uploaded);
    expect(filename.identity).toMatchObject({ name: "Sol Ring", resolutionMethod: "filename" });
    expect(filename.identityResolution.status).toBe("resolved");
  });

  it("runs filename before OCR and fuzzy, and keeps uncertain OCR/fuzzy matches as suggestions", async () => {
    const api = fakeClient({ lookupByName: async () => Promise.reject(Object.assign(new Error("not found"), { kind: "not-found" })), searchCards: async () => [sol] });
    const recognizer: OcrRecognizer = { recognizeName: vi.fn(async () => "Sol Ring") };
    const resolver = new IdentityResolver(api);
    const result = await resolver.resolve(card(undefined, "unknown upload.png"), { imageBytes: new Uint8Array([1, 2, 3]), recognizer });
    expect(recognizer.recognizeName).toHaveBeenCalledOnce();
    expect(result.identity).toBeNull();
    expect(result.identityResolution).toMatchObject({ status: "suggested", method: "ocr", candidates: [{ identity: { name: "Sol Ring" } }] });
    expect(api.searchCards).toHaveBeenCalledOnce();
  });

  it("keeps OCR failure isolated and continues to deterministic name suggestions", async () => {
    const api = fakeClient({ lookupByName: async () => Promise.reject(Object.assign(new Error("not found"), { kind: "not-found" })), searchCards: async () => [sol] });
    const recognizer: OcrRecognizer = { recognizeName: vi.fn(async () => { throw new Error("local OCR model unavailable"); }) };
    const result = await new IdentityResolver(api).resolve(card(undefined, "Sol Rng custom.png"), { imageBytes: new Uint8Array([1]), recognizer });
    expect(result.identity).toBeNull();
    expect(result.identityResolution.status).toBe("suggested");
    expect(api.searchCards).toHaveBeenCalledOnce();
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

  it("chooses a single complete printing for automatic DFC faces instead of mixing an incomplete newest printing", () => {
    const identified = {
      ...card({ name: "Delver of Secrets // Insectile Aberration" }),
      faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }],
      identity: { id: "scryfall:oracle:delver", provider: "scryfall", name: "Delver of Secrets // Insectile Aberration", oracleId: "delver", resolutionMethod: "name" as const, confidence: 1, metadata: { layout: "transform" } },
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
