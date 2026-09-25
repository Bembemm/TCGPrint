import { describe, expect, it, vi } from "vitest";
import type { CardWorkbench } from "../../services/card-workbench";
import {
  handleArtworkDownload,
  handleArtworkList,
  handleArtworkPreview,
  handleArtworkPrepare,
  handleAutocomplete,
  handleCardSearch,
  handleCardExport,
  handleCardImport,
  handleIdentityDetails,
  handleResolve,
  parseWorkingCards,
} from "../../services/card-api";
import type { ArtworkCandidate, CardIdentity, WorkingCard } from "../../core/cards/types";
import type { ArtworkOriginal } from "../../artwork/storage/types";
import { selectArtwork as selectWorkingCardArtwork } from "../../core/cards/working-set";
import { postArtworkSelection } from "../../src/app/artwork-selection-request";

const candidateId = `upload:${"a".repeat(64)}`;
const identity: CardIdentity = { id: "scryfall:oracle:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", provider: "scryfall", name: "Sol Ring", oracleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", resolutionMethod: "manual", confidence: 1 };
const card: WorkingCard = {
  id: "e0b93044-4ab5-4d6c-9d08-305271f20820",
  quantity: 1,
  order: 0,
  section: "Mainboard",
  importSource: { sourceId: "input:7dff", filename: "sol-ring.png", importKind: "image", entryKind: "asset" },
  identityHints: { name: "Sol Ring" },
  identity,
  identityResolution: { status: "resolved", method: "manual", query: "Sol Ring", confidence: 1, candidates: [], confirmed: true },
  faces: [{ id: "front", side: "front", name: "Sol Ring" }],
  selectedArtworkByFace: { front: { candidateId, source: "upload", identityId: identity.id, faceId: "front" } },
  localArtworkIds: [candidateId],
  mpcReferences: [],
  faceAssociations: [],
};
const candidate: ArtworkCandidate = {
  id: candidateId,
  source: "upload",
  identityId: identity.id,
  faceId: "front",
  previewUri: "file:///secret/cache.png",
  originalUri: "https://cards.scryfall.io/png/front/original.png",
  localOriginalPath: "/secret/cache/original.png",
  providerAssetId: "a".repeat(64),
  widthPx: 1500,
  heightPx: 2100,
  effectiveDpi: 600,
  setCode: "cmm",
  collectorNumber: "396",
  language: "en",
  originalAvailable: true,
  metadata: { originalFilename: "../Sol Ring.png", contentHash: "a".repeat(64), referenceOnly: false },
};
const previewBytes = new Uint8Array([1, 2, 3]);
const originalBytes = new Uint8Array([9, 8, 7, 6]);

function testWorkbench(overrides: Record<string, unknown> = {}): CardWorkbench {
  const providerHealth = { scryfall: { available: true, degraded: false }, upload: { available: true, degraded: false }, mpc: { available: true, degraded: false } };
  return {
    autocompleteCards: vi.fn(async () => ["Sol Ring"]),
    searchCardIdentities: vi.fn(async () => [identity]),
    getIdentityDetails: vi.fn(async () => ({ ...identity, layout: "normal", relatedCards: [] })),
    resolveWorkingCards: vi.fn(async (cards: readonly WorkingCard[]) => ({ workingCards: [...cards], providerHealth })),
    confirmWorkingCardIdentity: vi.fn(async (workingCard: WorkingCard) => workingCard),
    keepWorkingCardCustom: vi.fn((workingCard: WorkingCard) => workingCard),
    listArtworkCandidates: vi.fn(async () => [candidate]),
    getArtworkCandidate: vi.fn(async () => candidate),
    getArtworkPreview: vi.fn(async () => ({ candidateId, source: "upload" as const, bytes: previewBytes, contentType: "image/png", widthPx: 30, heightPx: 42 })),
    getArtworkOriginal: vi.fn(async () => ({ artworkId: "a".repeat(64), contentHash: "a".repeat(64), extension: "png", format: "png", byteLength: originalBytes.byteLength, widthPx: 1500, heightPx: 2100, createdAt: new Date(0).toISOString(), bytes: originalBytes, provenance: [{ provider: "upload", originalFilename: "sol-ring.png" }] } satisfies ArtworkOriginal)),
    selectArtwork: vi.fn((workingCard: WorkingCard) => workingCard),
    getProviderHealth: vi.fn(() => providerHealth),
    close: vi.fn(),
    ...overrides,
  } as unknown as CardWorkbench;
}

function jsonRequest(url: string, value: unknown): Request {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}

describe("card APIs", () => {
  it("accepts only DTO working cards and rejects byte/path fields from the client", () => {
    expect(parseWorkingCards([card])).toMatchObject([{ id: card.id, identity: { id: identity.id }, quantity: 1 }]);
    expect(() => parseWorkingCards([{ ...card, localOriginalPath: "/tmp/card.png" }])).toThrow(/localOriginalPath/);
    expect(() => parseWorkingCards([{ ...card, identityHints: { ...card.identityHints, imageUrl: "https://evil.test/card.png" } }])).toThrow(/imageUrl/);
    expect(() => parseWorkingCards([{ ...card, selectedArtworkByFace: { front: { ...card.selectedArtworkByFace.front, candidateId: "https://evil.test/a.jpg" } } }])).toThrow(/selected artwork reference/);
  });

  it("rejects invalid JSON and path-like identity IDs", async () => {
    const workbench = testWorkbench();
    const invalidJson = await handleResolve(new Request("http://localhost/api/cards/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), workbench);
    expect(invalidJson.status).toBe(400);
    const invalidId = await handleIdentityDetails(new Request("http://localhost"), "../etc/passwd", workbench);
    expect(invalidId.status).toBe(400);
  });

  it("serves autocomplete, card search and normalized card details through workbench methods", async () => {
    const workbench = testWorkbench();
    const autocomplete = await handleAutocomplete(new Request("http://localhost/api/cards/autocomplete?q=Sol"), workbench);
    expect(await autocomplete.json()).toEqual({ names: ["Sol Ring"] });
    const search = await handleCardSearch(new Request("http://localhost/api/cards/search?q=Sol%20Ring"), workbench);
    expect(await search.json()).toMatchObject({ identities: [{ id: identity.id, name: "Sol Ring" }] });
    const details = await handleIdentityDetails(new Request("http://localhost"), identity.id, workbench);
    expect(await details.json()).toMatchObject({ identity: { id: identity.id, layout: "normal", relatedCards: [] } });
    expect(workbench.autocompleteCards).toHaveBeenCalledWith("Sol", expect.anything());
    expect(workbench.searchCardIdentities).toHaveBeenCalledWith("Sol Ring", expect.anything());
  });

  it("returns candidate DTOs with server preview routes and no internal/external original paths", async () => {
    const workbench = testWorkbench();
    const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", { faceId: "front", source: "all" }), identity.id, workbench);
    const body = await response.json() as { candidates: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(body.candidates[0]).toMatchObject({ previewUri: `/api/cards/artworks/${encodeURIComponent(candidateId)}/preview`, effectiveDpi: 600, resolutionQuality: "excellent" });
    expect(body.candidates[0]).not.toHaveProperty("originalUri");
    expect(body.candidates[0]).not.toHaveProperty("localOriginalPath");
    expect(body.candidates[0]).toMatchObject({ metadata: { originalFilename: "Sol Ring.png" } });
  });

  it("keeps preview and original separate and exposes validated original provenance", async () => {
    const workbench = testWorkbench();
    const preview = await handleArtworkPreview(new Request("http://localhost"), candidateId, workbench);
    expect(preview.headers.get("x-tcgprint-artwork-role")).toBe("preview");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(previewBytes);

    const prepared = await handleArtworkPrepare(new Request("http://localhost", { method: "POST" }), candidateId, workbench);
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({ candidate: { widthPx: 1500, heightPx: 2100, effectiveDpi: 600 }, resolutionQuality: "excellent" });
    const download = await handleArtworkDownload(new Request("http://localhost"), candidateId, workbench);
    expect(download.headers.get("x-tcgprint-asset-role")).toBe("validated-original");
    expect(download.headers.get("x-tcgprint-sha256")).toBe("a".repeat(64));
    expect(download.headers.get("content-disposition")).toContain("a".repeat(64));
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(originalBytes);
    expect(workbench.getArtworkPreview).toHaveBeenCalledTimes(1);
    expect(workbench.getArtworkOriginal).toHaveBeenCalledTimes(2);
  });

  it("selects a front candidate from the Artwork Picker through /api/cards/resolve", async () => {
    const frontCandidate: ArtworkCandidate = { ...candidate, id: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front", source: "scryfall", originalUri: undefined, localOriginalPath: undefined, previewUri: "https://cards.scryfall.io/small/front.png" };
    const workbench = testWorkbench({
      getArtworkCandidate: vi.fn(async () => frontCandidate),
      selectArtwork: (workingCard: WorkingCard, faceId: "front" | "back", item: ArtworkCandidate) => selectWorkingCardArtwork(workingCard, faceId, { candidateId: item.id, source: item.source, identityId: workingCard.identity?.id ?? null, faceId }),
    });
    const pickerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/cards/resolve");
      return handleResolve(new Request(new URL(String(input), "http://localhost"), init), workbench);
    });

    const response = await postArtworkSelection(card, "front", frontCandidate.id, pickerFetch);
    const body = await response.json() as { workingCards: WorkingCard[] };

    expect(response.status).toBe(200);
    expect(JSON.parse(String(pickerFetch.mock.calls[0][1]?.body))).toMatchObject({ action: "select", faceId: "front", candidateId: frontCandidate.id });
    expect(body.workingCards[0].selectedArtworkByFace.front).toMatchObject({ candidateId: frontCandidate.id, source: "scryfall", faceId: "front" });
    expect(body.workingCards[0].id).toBe(card.id);
    expect(body.workingCards[0].identity?.id).toBe(identity.id);
  });

  it("selects the back candidate from the Artwork Picker for a DFC", async () => {
    const backCandidate: ArtworkCandidate = { ...candidate, id: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:back", source: "scryfall", faceId: "back", originalUri: undefined, localOriginalPath: undefined, previewUri: "https://cards.scryfall.io/small/back.png" };
    const dfcCard: WorkingCard = { ...card, faces: [{ id: "front", side: "front", name: "Front Face" }, { id: "back", side: "back", name: "Back Face" }] };
    const workbench = testWorkbench({
      getArtworkCandidate: vi.fn(async () => backCandidate),
      selectArtwork: (workingCard: WorkingCard, faceId: "front" | "back", item: ArtworkCandidate) => selectWorkingCardArtwork(workingCard, faceId, { candidateId: item.id, source: item.source, identityId: workingCard.identity?.id ?? null, faceId }),
    });
    const pickerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/cards/resolve");
      return handleResolve(new Request(new URL(String(input), "http://localhost"), init), workbench);
    });

    const response = await postArtworkSelection(dfcCard, "back", backCandidate.id, pickerFetch);
    const body = await response.json() as { workingCards: WorkingCard[] };

    expect(response.status).toBe(200);
    expect(JSON.parse(String(pickerFetch.mock.calls[0][1]?.body))).toMatchObject({ action: "select", faceId: "back", candidateId: backCandidate.id });
    expect(body.workingCards[0].selectedArtworkByFace.back).toMatchObject({ candidateId: backCandidate.id, source: "scryfall", faceId: "back" });
    expect(body.workingCards[0].id).toBe(dfcCard.id);
    expect(body.workingCards[0].identity?.id).toBe(identity.id);
  });

  it("preserves MPC reference candidates without inventing an original or preview", async () => {
    const mpc: ArtworkCandidate = { id: `mpc:${"b".repeat(64)}`, source: "mpc", identityId: identity.id, faceId: "front", providerAssetId: "provider-ref", selectedArtworkId: "selected-ref", originalAvailable: false, metadata: { referenceOnly: true, importedAssetId: "imported-id" } };
    const workbench = testWorkbench({ listArtworkCandidates: vi.fn(async () => [mpc]), getArtworkCandidate: vi.fn(async (id: string) => id === mpc.id ? mpc : candidate) });
    const response = await handleArtworkList(jsonRequest("http://localhost", { faceId: "front", source: "mpc", mpcReferences: [{ faceId: "front", importedAssetId: "imported-id", providerAssetId: "provider-ref", selectedArtworkId: "selected-ref", slots: ["A1"], availableLocally: false }] }), identity.id, workbench);
    const body = await response.json() as { candidates: Array<Record<string, unknown>> };
    expect(body.candidates[0]).toMatchObject({ source: "mpc", providerAssetId: "provider-ref", selectedArtworkId: "selected-ref", originalAvailable: false, metadata: { referenceOnly: true } });
    expect(body.candidates[0]).not.toHaveProperty("previewUri");
    expect((await handleArtworkDownload(new Request("http://localhost"), mpc.id, workbench)).status).toBe(404);
  });

  it("rejects filesystem paths at the import boundary and bounds physical PDF composition only", async () => {
    const workbench = testWorkbench();
    const form = new FormData();
    form.set("filePaths", JSON.stringify(["/etc/passwd"]));
    const importResponse = await (await import("../../services/card-api")).handleCardImport(new Request("http://localhost/api/cards/import", { method: "POST", body: form }), workbench);
    expect(importResponse.status).toBe(400);

    const many = { ...card, quantity: 501 };
    expect(parseWorkingCards([many])[0].quantity).toBe(501);
    const exportResponse = await handleCardExport(jsonRequest("http://localhost/api/cards/export", { cards: [many], options: { bleedMm: 0.625, cutGuides: "full" } }), workbench);
    expect(exportResponse.status).toBe(413);
    expect(await exportResponse.json()).toMatchObject({ code: "EXPORT_TOO_LARGE" });
  });

  it("accepts sanitized relative folder paths as import metadata parallel to uploaded files", async () => {
    let captured: { files?: readonly { filename: string; sourcePath?: string; kind?: string }[] } | undefined;
    const workbench = testWorkbench({
      importForWorkingSet: vi.fn(async (request: { files?: readonly { filename: string; sourcePath?: string; kind?: string }[] }) => {
        captured = request;
        return { workingCards: [], report: {}, providerHealth: {} };
      }),
    });
    const form = new FormData();
    form.append("files", new File([new Uint8Array([1, 2, 3])], "Card-Front.png"));
    form.set("filePaths", JSON.stringify(["Deck\\Card-Front.png"]));

    const response = await handleCardImport(new Request("http://localhost/api/cards/import", { method: "POST", body: form }), workbench);

    expect(response.status).toBe(200);
    expect(captured?.files).toMatchObject([{ filename: "Card-Front.png", sourcePath: "Deck/Card-Front.png", kind: "folder-file" }]);
  });

  it.each(["/etc/passwd", "../outside.png", "Deck/../outside.png", "C:\\Users\\secret.png", "Deck/\u0000bad.png", `Deck/${"x".repeat(1024)}.png`])(
    "rejects unsafe folder path metadata %s",
    async (filePath) => {
      const workbench = testWorkbench();
      const form = new FormData();
      form.append("files", new File([new Uint8Array([1])], "card.png"));
      form.set("filePaths", JSON.stringify([filePath]));
      const response = await handleCardImport(new Request("http://localhost/api/cards/import", { method: "POST", body: form }), workbench);
      expect(response.status).toBe(400);
    },
  );
});
