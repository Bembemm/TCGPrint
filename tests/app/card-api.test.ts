import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
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
import { postArtworkSelection, postManualBackArtworkSelection } from "../../src/app/artwork-selection-request";
import { BleedEngine } from "../../image-engine/bleed";
import { LosslessPdfEngine } from "../../pdf-engine/document";
import { ScryfallError } from "../../providers/scryfall/errors";
import { FULL_TRIM_GUIDES, NO_CUT_GUIDES } from "../helpers/cut-guides";
import { openProjectDatabase } from "../../persistence/projects/database";
import { ProjectRepository } from "../../persistence/projects/repository";
import { DEFAULT_PROJECT_SETTINGS, deserializeProjectSnapshot, serializeProjectSnapshot } from "../../persistence/projects/serializer";

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
  backMode: "project-default",
  backModeSelectionPolicy: "automatic",
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
    reresolveWorkingCard: vi.fn(async (workingCard: WorkingCard) => workingCard),
    restoreDefaultArtwork: vi.fn(async (workingCard: WorkingCard) => workingCard),
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
  it("returns a ZIP containing independently printable front/back PDFs and pairing metadata", async () => {
    const frontBytes = new Uint8Array(await sharp({ create: { width: 127, height: 178, channels: 3, background: "#bb3344" } }).png().toBuffer());
    const backBytes = new Uint8Array(await sharp({ create: { width: 127, height: 178, channels: 3, background: "#2255aa" } }).png().toBuffer());
    const backHash = createHash("sha256").update(backBytes).digest("hex");
    const projectDefaultBack = { assetId: `back:${backHash}`, sha256: backHash, format: "png" };
    const workbench = testWorkbench({ getArtworkOriginal: vi.fn(async () => ({
      artworkId: "front-original", contentHash: "front-original", extension: "png", format: "png", byteLength: frontBytes.byteLength,
      widthPx: 127, heightPx: 178, createdAt: new Date(0).toISOString(), bytes: frontBytes, provenance: [],
    })) });
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES, exportContentMode: "front-back-separated", projectDefaultBack, pageOrientation: "portrait", layoutRows: 1, layoutColumns: 1 },
    }), workbench, undefined, undefined, {
      resolveOriginal: vi.fn(async () => ({
        artworkId: backHash, contentHash: backHash, extension: "png", format: "png", byteLength: backBytes.byteLength,
        widthPx: 127, heightPx: 178, createdAt: new Date(0).toISOString(), bytes: backBytes, provenance: [],
      })),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain("tcgprint-front-back.zip");
    expect(Buffer.from(await response.arrayBuffer()).readUInt32LE(0)).toBe(0x04034b50);
    expect(JSON.parse(Buffer.from(response.headers.get("x-tcgprint-back-preflight")!, "base64url").toString("utf8"))).toMatchObject({
      totalPhysicalCards: 1,
      backs: { projectDefault: 1 },
    });
  });

  it("rejects Project exports when submitted artwork differs from the exact autosaved revision", async () => {
    const database = openProjectDatabase(":memory:");
    try {
      const projects = new ProjectRepository(database);
      const saved = projects.create(deserializeProjectSnapshot(serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS)));
      const submitted: WorkingCard = {
        ...structuredClone(card),
        selectedArtworkByFace: {
          front: { ...card.selectedArtworkByFace.front!, candidateId: `upload:${"c".repeat(64)}` },
        },
      };
      const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
        cards: [submitted],
        options: { projectId: saved.id, expectedProjectRevision: saved.revision, bleedMm: saved.snapshot.settings.bleedMm, cutGuides: saved.snapshot.settings.cutGuides },
      }), testWorkbench(), projects, {} as never);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "STALE_PROJECT" });
    } finally {
      database.close();
    }
  });

  it("validates registration input and forwards independent orientations and slot skips to PDF export", async () => {
    const malformed = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES, registration: { type: "custom", orientation: "portrait", marks: [], reservedZones: [] } },
    }), testWorkbench());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "INVALID_REGISTRATION" });

    const bytes = new Uint8Array(await sharp({ create: { width: 127, height: 178, channels: 3, background: { r: 48, g: 126, b: 214 } } }).png().toBuffer());
    const workbench = testWorkbench({
      getArtworkOriginal: vi.fn(async () => ({
        artworkId: "a".repeat(64), contentHash: "b".repeat(64), extension: "png", format: "png",
        byteLength: bytes.byteLength, widthPx: 127, heightPx: 178, createdAt: new Date(0).toISOString(), provenance: [], bytes,
      })),
    });
    const generate = vi.spyOn(LosslessPdfEngine.prototype, "generate");
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: {
        bleedMm: 0,
        cutGuides: NO_CUT_GUIDES,
        pageOrientation: "landscape",
        cardOrientation: "landscape",
        paperFormat: { id: "a4-landscape", name: "A4 landscape", widthMm: 297, heightMm: 210 },
        cardFormat: { id: "magic-standard", name: "Magic Standard", widthMm: 63.5, heightMm: 88.9, cornerRadiusMm: 3.175 },
        registration: { type: "three-point", orientation: "landscape" },
        marginsMm: { top: 1, right: 2, bottom: 3, left: 4 },
        horizontalGapMm: 5,
        verticalGapMm: 6,
        layoutRows: 1,
        layoutColumns: 2,
        skippedSlotIndices: [1],
      },
    }), workbench);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      pageOrientation: "landscape",
      cardOrientation: "landscape",
      paperFormat: { name: "A4 landscape", widthMm: 297, heightMm: 210 },
      cardFormat: { id: "magic-standard", name: "Magic Standard", widthMm: 63.5, heightMm: 88.9, cornerRadiusMm: 3.175 },
      registration: expect.objectContaining({ type: "three-point", orientation: "landscape" }),
      marginsMm: { top: 1, right: 2, bottom: 3, left: 4 },
      horizontalGapMm: 5,
      verticalGapMm: 6,
      layoutRows: 1,
      layoutColumns: 2,
      skippedSlotIndices: [1],
    }));
    generate.mockRestore();
  });

  it("forwards safe immutable template geometry through the export API", async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 127, height: 178, channels: 3, background: { r: 48, g: 126, b: 214 } } }).png().toBuffer());
    const workbench = testWorkbench({
      getArtworkOriginal: vi.fn(async () => ({
        artworkId: "a".repeat(64), contentHash: "c".repeat(64), extension: "png", format: "png",
        byteLength: bytes.byteLength, widthPx: 127, heightPx: 178, createdAt: new Date(0).toISOString(), provenance: [], bytes,
      })),
    });
    const templateGeometry = {
      orientation: "portrait",
      cardOrientation: "portrait",
      pageSizeMm: { widthMm: 210, heightMm: 297 },
      cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      rows: 1,
      columns: 1,
      slots: [{ index: 0, row: 0, column: 0, xMm: 73.25, yMm: 104.05 }],
    };
    const generate = vi.spyOn(LosslessPdfEngine.prototype, "generate");
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES, templateGeometry },
    }), workbench);

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ templateGeometry }));
    generate.mockRestore();
  });

  it.each([
    { horizontalGapMm: "2" },
    { verticalGapMm: 2_001 },
    { marginsMm: { top: 1, right: 1, bottom: 1 } },
  ])("rejects invalid physical layout measurements at the API boundary", async (layout) => {
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES, ...layout },
    }), testWorkbench());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_LAYOUT" });
  });

  it("rejects skipped slots without fixed dimensions or versioned template geometry", async () => {
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES, skippedSlotIndices: [0] },
    }), testWorkbench());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_LAYOUT", message: expect.stringMatching(/skipped slots require .*fixed grid/i) });
  });

  it.each(["full", "none"])("rejects legacy cut guide mode %s at the export API boundary", async (cutGuides) => {
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 0, cutGuides },
    }), testWorkbench());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_CUT_GUIDES", message: expect.stringMatching(/legacy/i) });
  });

  it("rejects non-numeric external stroke widths in the export API config", async () => {
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: {
        bleedMm: 0,
        cutGuides: {
          trim: { enabled: false, extentMm: 1, color: "blue" },
          external: { enabled: true, strokeWidthPt: "0.3", color: "black" },
        },
      },
    }), testWorkbench());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_CUT_GUIDES" });
  });

  it("uses immediate-edge extension for export diagnostics and rejects legacy modes", async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 127, height: 178, channels: 3, background: { r: 48, g: 126, b: 214 } } }).png().toBuffer());
    const workbench = testWorkbench({
      getArtworkCandidate: vi.fn(async () => candidate),
      getArtworkOriginal: vi.fn(async () => ({
        artworkId: "a".repeat(64),
        contentHash: "b".repeat(64),
        extension: "png",
        format: "png",
        byteLength: bytes.byteLength,
        widthPx: 127,
        heightPx: 178,
        createdAt: new Date(0).toISOString(),
        provenance: [],
        bytes,
      })),
    });
    const generate = vi.spyOn(BleedEngine.prototype, "generate");

    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 1, cutGuides: NO_CUT_GUIDES },
    }), workbench);

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ mode: "edge-extension" }));
    const encodedDiagnostics = response.headers.get("x-tcgprint-bleed-diagnostics");
    expect(encodedDiagnostics).toBeTruthy();
    const diagnostics = JSON.parse(Buffer.from(encodedDiagnostics!, "base64url").toString("utf8")) as {
      version: number;
      diagnostics: Array<{ source: string; requestedMode: string; resolvedMode: string; effectiveMode: string; sideDiagnostics: Record<string, { strategy: string }> }>;
    };
    expect(diagnostics).toMatchObject({
      version: 1,
      diagnostics: [{ source: "upload", requestedMode: "auto", resolvedMode: "edge-extension", effectiveMode: "edge-extension" }],
    });
    expect(diagnostics.diagnostics[0].sideDiagnostics.top).toEqual({ strategy: "nearest-edge-pixel" });
    generate.mockRestore();
  });

  it("rejects retired bleed modes instead of silently changing their behavior", async () => {
    const workbench = testWorkbench();
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 1, cutGuides: NO_CUT_GUIDES, bleedMode: "legacy-mode" },
    }), workbench);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_BLEED_MODE" });
  });

  it("forwards rounded-corners ON to export even when bleed is zero", async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 127, height: 178, channels: 3, background: { r: 48, g: 126, b: 214 } } }).png().toBuffer());
    const workbench = testWorkbench({
      getArtworkOriginal: vi.fn(async () => ({
        artworkId: "a".repeat(64),
        contentHash: "b".repeat(64),
        extension: "png",
        format: "png",
        byteLength: bytes.byteLength,
        widthPx: 127,
        heightPx: 178,
        createdAt: new Date(0).toISOString(),
        provenance: [],
        bytes,
      })),
    });
    const generate = vi.spyOn(BleedEngine.prototype, "generate");
    const generatePdf = vi.spyOn(LosslessPdfEngine.prototype, "generate");

    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES, roundedCorners: true },
    }), workbench);

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ bleedMm: 0, roundedCorners: true, cornerRadiusMm: 3.175 }));
    const derivative = await generate.mock.results[0].value;
    expect(derivative.status).toBe("derived");
    expect(derivative.roundedCorners).toBe(true);
    expect(generatePdf.mock.calls[0][0].bleedResults?.[0]).toBe(derivative);
  });

  it("rejects non-boolean rounded-corners export options", async () => {
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES, roundedCorners: "true" },
    }), testWorkbench());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_ROUNDED_CORNERS" });
  });

  it("accepts only DTO working cards and rejects byte/path fields from the client", () => {
    expect(parseWorkingCards([card])).toMatchObject([{ id: card.id, identity: { id: identity.id }, quantity: 1 }]);
    expect(() => parseWorkingCards([card, { ...card, order: 1 }])).toThrow(/Card ID .* duplicated/i);
    expect(() => parseWorkingCards([{ ...card, localOriginalPath: "/tmp/card.png" }])).toThrow(/localOriginalPath/);
    expect(() => parseWorkingCards([{ ...card, identityHints: { ...card.identityHints, imageUrl: "https://evil.test/card.png" } }])).toThrow(/imageUrl/);
    expect(() => parseWorkingCards([{ ...card, selectedArtworkByFace: { front: { ...card.selectedArtworkByFace.front, candidateId: "https://evil.test/a.jpg" } } }])).toThrow(/selected artwork reference/);
  });

  it("parses explicit back policy without treating the shared MPC cardback as a card face", () => {
    const generic = parseWorkingCards([{ ...card, sharedMpcCardback: {
      importedAssetId: "shared-mpc-back", originalFormat: "png", availableLocally: true,
      provenance: { sourceId: "mpc-order" },
    } }])[0];
    expect(generic.backMode).toBe("project-default");

    const dfc: WorkingCard = {
      ...card,
      identity: { ...identity, metadata: { layout: "transform", faces: [{ name: "Front" }, { name: "Back" }] } },
      faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
      selectedArtworkByFace: {},
      backMode: "auto",
      backModeSelectionPolicy: "automatic",
    };
    expect(parseWorkingCards([dfc])[0].backMode).toBe("auto");
    const hash = "c".repeat(64);
    const manual = parseWorkingCards([{ ...dfc, backMode: "manual", backModeSelectionPolicy: "explicit", manualBackAsset: { assetId: `back:${hash}`, sha256: hash, format: "png" } }])[0];
    expect(manual).toMatchObject({ backMode: "manual", backModeSelectionPolicy: "explicit", manualBackAsset: { sha256: hash } });
    expect(() => parseWorkingCards([{ ...dfc, backMode: "bogus" }])).toThrow(/backMode is invalid/);
  });

  it("accepts and locks a manual physical artwork back on a simple card", async () => {
    const simpleManual: WorkingCard = {
      ...card,
      backMode: "manual",
      backModeSelectionPolicy: "explicit",
      manualBackArtwork: { candidateId: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front", source: "scryfall", identityId: identity.id, faceId: "front", providerAssetId: "printing", selectionPolicy: "user-selected" },
    };
    expect(parseWorkingCards([simpleManual])[0]).toMatchObject({
      faces: [{ side: "front" }],
      manualBackArtwork: { candidateId: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front", faceId: "front", selectionPolicy: "user-selected" },
      backMode: "manual",
      backModeSelectionPolicy: "explicit",
    });

    const manualCandidate: ArtworkCandidate = { ...candidate, id: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front", source: "scryfall", faceId: "front" };
    const workbench = testWorkbench({
      getArtworkCandidate: vi.fn(async () => manualCandidate),
      selectManualBackArtwork: vi.fn((workingCard: WorkingCard) => ({
        ...workingCard,
        manualBackArtwork: { candidateId: manualCandidate.id, source: "scryfall", identityId: identity.id, faceId: "front", selectionPolicy: "user-selected" },
        backMode: "manual",
        backModeSelectionPolicy: "explicit",
      })),
    });
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "select-manual-back-artwork", card, candidateId: manualCandidate.id,
    }), workbench);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workingCards: [{ faces: [{ side: "front" }], backMode: "manual", manualBackArtwork: { source: "scryfall", faceId: "front" } }] });
  });

  it("keeps the API CardIdentity metadata allowlist and sanitization behavior", () => {
    const withMetadata: WorkingCard = {
      ...card,
      identity: {
        ...identity,
        metadata: {
          layout: "transform",
          digital: false,
          faces: [{ name: "Front", extra: "drop" }, { name: "Back" }, { name: "Ignored" }],
          relatedCards: [{ id: "token-1", name: "Token", component: "token", extra: "drop" }],
          unsupportedMetadata: "drop",
        },
      },
    };

    expect(parseWorkingCards([withMetadata])[0].identity?.metadata).toEqual({
      layout: "transform",
      digital: false,
      faces: [{ name: "Front" }, { name: "Back" }],
      relatedCards: [{ id: "token-1", name: "Token", component: "token" }],
    });
  });

  it("rejects invalid JSON and path-like identity IDs", async () => {
    const workbench = testWorkbench();
    const invalidJson = await handleResolve(new Request("http://localhost/api/cards/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), workbench);
    expect(invalidJson.status).toBe(400);
    const invalidId = await handleIdentityDetails(new Request("http://localhost"), "../etc/passwd", workbench);
    expect(invalidId.status).toBe(400);
  });

  it("re-resolves one WorkingCard through its dedicated mutation action", async () => {
    const reResolved = { ...card, identity: null, identityResolution: { status: "unresolved" as const, candidates: [], confirmed: false } };
    const reresolveWorkingCard = vi.fn(async () => reResolved);
    const workbench = testWorkbench({ reresolveWorkingCard });

    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", { action: "reresolve", card }), workbench);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workingCards: [reResolved] });
    expect(reresolveWorkingCard).toHaveBeenCalledWith(card, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("restores the default artwork for exactly the requested face", async () => {
    const restored = {
      ...card,
      faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }],
      selectedArtworkByFace: {
        front: { candidateId: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front", source: "scryfall" as const, identityId: identity.id, faceId: "front" as const, selectionPolicy: "newest-en-highres-nondigital-v1" },
        back: { candidateId: "mpc:back-reference", source: "mpc" as const, identityId: identity.id, faceId: "back" as const, selectionPolicy: "user-selected" },
      },
    };
    const restoreDefaultArtwork = vi.fn(async () => restored);
    const workbench = testWorkbench({ restoreDefaultArtwork });

    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", { action: "restore-default-artwork", card, faceId: "front" }), workbench);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workingCards: [restored] });
    expect(restoreDefaultArtwork).toHaveBeenCalledWith(card, "front", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("reports when a default artwork is unavailable without returning a mutated card", async () => {
    const restoreDefaultArtwork = vi.fn(async () => undefined);
    const workbench = testWorkbench({ restoreDefaultArtwork });

    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", { action: "restore-default-artwork", card, faceId: "front" }), workbench);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ARTWORK_DEFAULT_UNAVAILABLE" });
  });

  it("returns degraded provider health when default artwork lookup fails upstream", async () => {
    const restoreDefaultArtwork = vi.fn(async () => { throw new ScryfallError("network", "Scryfall network unavailable"); });
    const providerHealth = {
      scryfall: { available: false, degraded: true, message: "Scryfall network unavailable" },
      upload: { available: true, degraded: false },
      mpc: { available: true, degraded: false },
    };
    const workbench = testWorkbench({ restoreDefaultArtwork, getProviderHealth: () => providerHealth });

    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", { action: "restore-default-artwork", card, faceId: "front" }), workbench);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SCRYFALL_NETWORK",
      message: "Scryfall network unavailable",
      providerHealth: { scryfall: { available: false, degraded: true, message: "Scryfall network unavailable" } },
    });
  });

  it("rejects default artwork for custom cards without consulting the provider", async () => {
    const restoreDefaultArtwork = vi.fn(async () => card);
    const workbench = testWorkbench({ restoreDefaultArtwork });
    const custom = {
      ...card,
      identity: null,
      identityResolution: { status: "custom" as const, candidates: [], confirmed: true },
    };

    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", { action: "restore-default-artwork", card: custom, faceId: "front" }), workbench);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NO_RESOLVED_IDENTITY", message: expect.stringContaining("Não há identidade") });
    expect(restoreDefaultArtwork).not.toHaveBeenCalled();
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

  it("preserves MPC online-versus-cached original status in artwork candidate DTOs", async () => {
    const mpcCandidate: ArtworkCandidate = { ...candidate, id: "mpc:opaque", source: "mpc", originalAvailable: true, originalCached: false, metadata: { ...(candidate.metadata ?? {}), localAvailabilityHint: true } };
    const workbench = testWorkbench({ listArtworkCandidates: vi.fn(async () => [mpcCandidate]) });
    const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", { faceId: "front", source: "mpc" }), identity.id, workbench);
    const body = await response.json() as { candidates: Array<Record<string, unknown>> };

    expect(body.candidates[0]).toMatchObject({ source: "mpc", originalAvailable: true, originalCached: false, metadata: { localAvailabilityHint: true } });
  });

  it("includes MPC source-face back references in a simple card's physical-back catalog", async () => {
    const mpcBack: ArtworkCandidate = {
      ...candidate,
      id: `mpc:${"c".repeat(64)}`,
      source: "mpc",
      faceId: "back",
      providerAssetId: "mpc-back-source",
      selectedArtworkId: "selected-back-source",
      originalAvailable: false,
    };
    const listArtworkCandidates = vi.fn(async (_identityId: string, faceId: "front" | "back") => faceId === "back" ? [mpcBack] : [candidate]);
    const workbench = testWorkbench({ listArtworkCandidates });
    const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", {
      faceId: "front", source: "all", physicalBackArtwork: true,
      mpcReferences: [{ faceId: "back", importedAssetId: "imported-back", providerAssetId: "mpc-back-source", selectedArtworkId: "selected-back-source", slots: [], availableLocally: false }],
    }), identity.id, workbench);
    const body = await response.json() as { candidates: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(listArtworkCandidates).toHaveBeenNthCalledWith(1, identity.id, "front", "all", expect.objectContaining({ mpcReferences: expect.any(Array), signal: expect.anything() }));
    expect(listArtworkCandidates).toHaveBeenNthCalledWith(2, identity.id, "back", "mpc", expect.objectContaining({ mpcReferences: expect.any(Array), signal: expect.anything() }));
    expect(body.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ id: mpcBack.id, source: "mpc", faceId: "back" })]));
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

  it("posts the dedicated physical manual back selection action for a simple card", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    const candidate = "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front";
    await postManualBackArtworkSelection(card, candidate, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/cards/resolve", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "select-manual-back-artwork", card, candidateId: candidate }),
    }));
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
    const exportResponse = await handleCardExport(jsonRequest("http://localhost/api/cards/export", { cards: [many], options: { bleedMm: 0.625, cutGuides: FULL_TRIM_GUIDES } }), workbench);
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
