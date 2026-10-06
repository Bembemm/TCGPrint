import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { CardWorkbench } from "../../services/card-workbench";
import {
  handleArtworkDownload,
  handleArtworkDisplay,
  handleArtworkList,
  handleArtworkPreview,
  handleArtworkPrepare,
  handleMpcArtworkBatchRevalidation,
  handleMpcArtworkCatalogs,
  handleMpcArtworkDiagnostics,
  handleMpcArtworkDiagnosticsReport,
  handleMpcArtworkRefresh,
  handleAutocomplete,
  handleCardSearch,
  handleCardExport,
  handleCardImport,
  handleIdentityDetails,
  handleResolve,
  parseWorkingCards,
} from "../../services/card-api";
import type { ArtworkCandidate, CardIdentity, WorkingCard } from "../../core/cards/types";
import { createPhysicalOrder } from "../../core/cards/physical-instance-order";
import type { ArtworkOriginal } from "../../artwork/storage/types";
import { selectArtwork as selectWorkingCardArtwork } from "../../core/cards/working-set";
import { postArtworkSelection, postManualBackArtworkSelection } from "../../src/app/artwork-selection-request";
import { BleedEngine } from "../../image-engine/bleed";
import { LosslessPdfEngine } from "../../pdf-engine/document";
import { ScryfallError } from "../../providers/scryfall/errors";
import { FULL_TRIM_GUIDES, NO_CUT_GUIDES } from "../helpers/cut-guides";
import { MpcArtworkProviderError } from "../../artwork/mpc-provider";
import { openProjectDatabase } from "../../persistence/projects/database";
import { ProjectRepository } from "../../persistence/projects/repository";
import { DEFAULT_PROJECT_SETTINGS, deserializeProjectSnapshot, serializeProjectSnapshot } from "../../persistence/projects/serializer";
import { BackSelectionPolicyError } from "../../core/cards/back-selection";

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
    listMpcCardbackCandidates: vi.fn(async () => []),
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

    const proofResponse = await handleCardExport(jsonRequest("http://localhost/api/cards/export?proof=final", {
      cards: [card],
      options: { bleedMm: 0, cutGuides: NO_CUT_GUIDES, exportContentMode: "front-back-separated", projectDefaultBack, pageOrientation: "portrait", layoutRows: 1, layoutColumns: 1 },
    }), workbench, undefined, undefined, {
      resolveOriginal: vi.fn(async () => ({
        artworkId: backHash, contentHash: backHash, extension: "png", format: "png", byteLength: backBytes.byteLength,
        widthPx: 127, heightPx: 178, createdAt: new Date(0).toISOString(), bytes: backBytes, provenance: [],
      })),
    });
    const proof = await proofResponse.json() as { frontPdfBase64: string; backPdfBase64: string };

    expect(proofResponse.status).toBe(200);
    expect(proofResponse.headers.get("content-type")).toContain("application/json");
    expect(proofResponse.headers.get("content-type")).not.toContain("application/zip");
    expect(Buffer.from(proof.frontPdfBase64, "base64").subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(Buffer.from(proof.backPdfBase64, "base64").subarray(0, 5).toString("ascii")).toBe("%PDF-");
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

  it("rejects malformed physical-order references before starting PDF artwork work", async () => {
    const workbench = testWorkbench();
    const response = await handleCardExport(jsonRequest("http://localhost/api/cards/export", {
      cards: [card],
      options: {
        physicalOrder: {
          nextInstanceId: 3,
          instances: [
            { id: "instance-1", workingCardId: card.id },
            { id: "instance-2", workingCardId: "missing-working-card" },
          ],
        },
        bleedMm: 0,
        cutGuides: NO_CUT_GUIDES,
      },
    }), workbench);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_PHYSICAL_ORDER" });
    expect(workbench.getArtworkOriginal).not.toHaveBeenCalled();
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
        marginsMm: { top: 40, right: 40, bottom: 40, left: 40 },
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
      marginsMm: { top: 40, right: 40, bottom: 40, left: 40 },
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

  it("enforces generic project-wide back protection in the API and preserves real DFC face selections", async () => {
    const dfcBack = { candidateId: "scryfall:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:back", source: "scryfall" as const, identityId: identity.id, faceId: "back" as const };
    const dfc: WorkingCard = {
      ...card,
      id: "dfc-api", order: 1,
      identity: { ...identity, id: "scryfall:oracle:delver", name: "Delver of Secrets // Insectile Aberration", metadata: { layout: "transform", faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] } },
      faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
      selectedArtworkByFace: { front: card.selectedArtworkByFace.front!, back: dfcBack },
      backMode: "auto", backModeSelectionPolicy: "automatic",
    };
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "apply-generic-back-scope", cards: [{ ...card, quantity: 2 }, dfc], targetCardId: card.id,
      scope: "all-simple-project", choiceMode: "none",
    }), testWorkbench());
    const result = await response.json() as { workingCards: WorkingCard[]; impact: { affectedPhysicalCards: number; preservedDfcPhysicalCards: number } };

    expect(response.status).toBe(200);
    expect(result.impact).toEqual({ affectedEntries: 1, affectedPhysicalCards: 2, preservedDfcEntries: 1, preservedDfcPhysicalCards: 1 });
    expect(result.workingCards[0]).toMatchObject({ backMode: "none", quantity: 2 });
    expect(result.workingCards[1]).toMatchObject({ backMode: "auto", selectedArtworkByFace: { back: dfcBack } });
  });

  it("applies a physical-copy generic back through the API without changing physical sequence", async () => {
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "apply-generic-back-scope", cards: [{ ...card, quantity: 4 }], targetCardId: card.id,
      scope: "physical-copy", physicalCardIndex: 2, choiceMode: "none",
    }), testWorkbench());
    const result = await response.json() as { workingCards: WorkingCard[]; impact: { affectedPhysicalCards: number } };

    expect(response.status).toBe(200);
    expect(result.workingCards.map((item) => item.quantity)).toEqual([2, 1, 1]);
    expect(result.workingCards.map((item) => item.backMode)).toEqual([card.backMode, "none", card.backMode]);
    expect(result.impact.affectedPhysicalCards).toBe(1);
  });

  it("rejects an API request that targets a DFC with a generic physical back choice", async () => {
    const dfc: WorkingCard = {
      ...card,
      id: "dfc-api", identity: { ...identity, metadata: { layout: "transform", faces: [{ name: "Front" }, { name: "Back" }] } },
      faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
      selectedArtworkByFace: { front: card.selectedArtworkByFace.front!, back: { candidateId: "scryfall:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:back", source: "scryfall", identityId: identity.id, faceId: "back" } },
      backMode: "auto", backModeSelectionPolicy: "automatic",
    };
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "apply-generic-back-scope", cards: [dfc], targetCardId: dfc.id,
      scope: "all-simple-project", choiceMode: "none",
    }), testWorkbench());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_PHYSICAL_BACK_SELECTION" });
  });

  it("applies a physical-copy artwork scope through the API as one ordered split", async () => {
    const alternative = { ...candidate, id: `upload:${"d".repeat(64)}` };
    const workbench = testWorkbench({
      listArtworkCandidates: vi.fn(async () => [alternative]),
      getArtworkCandidate: vi.fn(async () => alternative),
      selectArtwork: vi.fn((workingCard: WorkingCard, side: "front" | "back", selected: ArtworkCandidate) => selectWorkingCardArtwork(workingCard, side, {
        candidateId: selected.id, source: selected.source, identityId: workingCard.identity?.id ?? null, faceId: side, selectionPolicy: "user-selected",
      })),
    });
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "apply-artwork-scope", cards: [{ ...card, quantity: 4 }], targetCardId: card.id,
      faceId: "front", candidateId: alternative.id, scope: "physical-copy", physicalCardIndex: 2,
    }), workbench);
    const result = await response.json() as { workingCards: WorkingCard[] };

    expect(response.status).toBe(200);
    expect(result.workingCards.map((item) => item.quantity)).toEqual([2, 1, 1]);
    expect(result.workingCards.map((item) => item.order)).toEqual([0, 1, 2]);
    expect(result.workingCards.map((item) => item.selectedArtworkByFace.front?.candidateId)).toEqual([
      candidateId, alternative.id, candidateId,
    ]);
    expect(result.workingCards[1]?.identity).toEqual(card.identity);
    expect(result.workingCards[1]?.manualBackArtwork).toEqual(card.manualBackArtwork);
    expect(result.workingCards[1]?.mpcReferences).toEqual(card.mpcReferences);
  });

  it("preserves a reordered stable physical instance when M6 splits its artwork through the API", async () => {
    const alternative = { ...candidate, id: `upload:${"e".repeat(64)}` };
    const workbench = testWorkbench({
      listArtworkCandidates: vi.fn(async () => [alternative]),
      getArtworkCandidate: vi.fn(async () => alternative),
      selectArtwork: vi.fn((workingCard: WorkingCard, side: "front" | "back", selected: ArtworkCandidate) => selectWorkingCardArtwork(workingCard, side, {
        candidateId: selected.id, source: selected.source, identityId: workingCard.identity?.id ?? null, faceId: side, selectionPolicy: "user-selected",
      })),
    });
    const otherEntry = { ...card, id: "other-entry", order: 1, quantity: 1 };
    const cards = [{ ...card, quantity: 4 }, otherEntry];
    const initial = createPhysicalOrder(cards);
    const [one, two, three, four, other] = initial.instances;
    const physicalOrder = { ...initial, instances: [one!, other!, two!, three!, four!] };
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "apply-artwork-scope", cards, physicalOrder, targetCardId: card.id,
      faceId: "front", candidateId: alternative.id, scope: "physical-copy", physicalInstanceId: three!.id,
    }), workbench);
    const result = await response.json() as { workingCards: WorkingCard[]; physicalOrder: { instances: Array<{ id: string; workingCardId: string }> }; selectedCardId: string };

    expect(response.status).toBe(200);
    expect(result.workingCards.map(({ quantity }) => quantity)).toEqual([3, 1, 1]);
    expect(result.physicalOrder.instances.map(({ id }) => id)).toEqual([one!.id, other!.id, two!.id, three!.id, four!.id]);
    expect(result.physicalOrder.instances.map(({ workingCardId }) => workingCardId)).toEqual([
      card.id, otherEntry.id, card.id, result.selectedCardId, card.id,
    ]);
    expect(result.workingCards.find(({ id }) => id === result.selectedCardId)?.selectedArtworkByFace.front?.candidateId).toBe(alternative.id);
  });

  it.each([
    {
      label: "legacy select rejects another identity even when its face matches",
      action: "select" as const,
      target: card,
      faceId: "front" as const,
      artwork: { ...candidate, id: "scryfall:other:front", source: "scryfall" as const, identityId: "scryfall:oracle:other" },
    },
    {
      label: "scoped select rejects the same DFC identity's Front as Back",
      action: "apply-artwork-scope" as const,
      target: {
        ...card,
        id: "delver-face-target",
        identity: { ...identity, id: "scryfall:oracle:delver", name: "Delver of Secrets // Insectile Aberration", metadata: { layout: "transform", faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] } },
        faces: [{ id: "front", side: "front" as const, name: "Delver of Secrets" }, { id: "back", side: "back" as const, name: "Insectile Aberration" }],
        selectedArtworkByFace: {},
      },
      faceId: "back" as const,
      artwork: { ...candidate, id: "scryfall:delver:front", source: "scryfall" as const, identityId: "scryfall:oracle:delver", faceId: "front" as const },
    },
    {
      label: "scoped select rejects another identity's Back for a DFC",
      action: "apply-artwork-scope" as const,
      target: {
        ...card,
        id: "delver-other-identity-target",
        identity: { ...identity, id: "scryfall:oracle:delver", name: "Delver of Secrets // Insectile Aberration", metadata: { layout: "transform", faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] } },
        faces: [{ id: "front", side: "front" as const, name: "Delver of Secrets" }, { id: "back", side: "back" as const, name: "Insectile Aberration" }],
        selectedArtworkByFace: {},
      },
      faceId: "back" as const,
      artwork: { ...candidate, id: "scryfall:other:back", source: "scryfall" as const, identityId: "scryfall:oracle:other", faceId: "back" as const },
    },
  ])("$label", async ({ action, target, faceId, artwork }) => {
    const before = structuredClone(target);
    const getArtworkCandidate = vi.fn(async () => artwork);
    const selectArtwork = vi.fn((workingCard: WorkingCard) => workingCard);
    const workbench = testWorkbench({ getArtworkCandidate, selectArtwork });
    const requestBody = action === "select"
      ? { action, card: target, faceId, candidateId: artwork.id }
      : { action, cards: [target], targetCardId: target.id, faceId, candidateId: artwork.id, scope: "entry" };
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", requestBody), workbench);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_ARTWORK_IDENTITY" });
    expect(workbench.selectArtwork).not.toHaveBeenCalled();
    expect(target).toEqual(before);
  });

  it.each([
    { label: "Scryfall", source: "scryfall" as const, id: "scryfall:correct:front", action: "select" as const },
    { label: "MPC", source: "mpc" as const, id: `mpc:${"9".repeat(64)}`, action: "apply-artwork-scope" as const },
  ])("accepts a correctly bound $label candidate", async ({ source, id, action }) => {
    const valid: ArtworkCandidate = { ...candidate, id, source, identityId: identity.id, faceId: "front" };
    const selectArtwork = vi.fn((workingCard: WorkingCard, faceId: "front" | "back", selected: ArtworkCandidate) => selectWorkingCardArtwork(workingCard, faceId, {
      candidateId: selected.id, source: selected.source, identityId: workingCard.identity?.id ?? null, faceId,
    }));
    const workbench = testWorkbench({ getArtworkCandidate: vi.fn(async () => valid), selectArtwork });
    const requestBody = action === "select"
      ? { action, card, faceId: "front", candidateId: id }
      : { action, cards: [card], targetCardId: card.id, faceId: "front", candidateId: id, scope: "entry" };
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", requestBody), workbench);
    const body = await response.json() as { workingCards: WorkingCard[] };

    expect(response.status).toBe(200);
    expect(selectArtwork).toHaveBeenCalledWith(card, "front", valid);
    expect(body.workingCards[0]?.selectedArtworkByFace.front).toMatchObject({ candidateId: id, identityId: identity.id, faceId: "front" });
  });

  it("accepts an upload only after resolving its real identity and face association", async () => {
    const unlinked: ArtworkCandidate = { ...candidate, identityId: null, faceId: "front" };
    const linked: ArtworkCandidate = { ...unlinked, identityId: identity.id, faceId: "front" };
    const listArtworkCandidates = vi.fn(async (identityId: string, faceId: "front" | "back", source: string) =>
      identityId === identity.id && faceId === "front" && source === "upload" ? [linked] : []);
    const selectArtwork = vi.fn((workingCard: WorkingCard, faceId: "front" | "back", selected: ArtworkCandidate) => selectWorkingCardArtwork(workingCard, faceId, {
      candidateId: selected.id, source: selected.source, identityId: workingCard.identity?.id ?? null, faceId,
    }));
    const workbench = testWorkbench({ getArtworkCandidate: vi.fn(async () => unlinked), listArtworkCandidates, selectArtwork });
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "select", card, faceId: "front", candidateId: unlinked.id,
    }), workbench);
    const body = await response.json() as { workingCards: WorkingCard[] };

    expect(response.status).toBe(200);
    expect(listArtworkCandidates).toHaveBeenCalledWith(identity.id, "front", "upload", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(selectArtwork).toHaveBeenCalledWith(card, "front", linked);
    expect(body.workingCards[0]?.selectedArtworkByFace.front).toMatchObject({ candidateId: unlinked.id, identityId: identity.id, faceId: "front" });
  });

  it("rejects an unlinked upload for a resolved identity instead of treating null identity as a wildcard", async () => {
    const unlinked: ArtworkCandidate = { ...candidate, id: `upload:${"c".repeat(64)}`, identityId: null, faceId: "front" };
    const selectArtwork = vi.fn((workingCard: WorkingCard) => workingCard);
    const listArtworkCandidates = vi.fn(async () => []);
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "select", card, faceId: "front", candidateId: unlinked.id,
    }), testWorkbench({ getArtworkCandidate: vi.fn(async () => unlinked), listArtworkCandidates, selectArtwork }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_ARTWORK_IDENTITY" });
    expect(listArtworkCandidates).toHaveBeenCalledWith(identity.id, "front", "upload", expect.any(Object));
    expect(selectArtwork).not.toHaveBeenCalled();
    expect(card.selectedArtworkByFace.front?.candidateId).toBe(candidateId);
  });

  it("preserves M1 custom uploads with a real custom-catalog face association", async () => {
    const custom: WorkingCard = {
      ...card,
      identity: null,
      identityResolution: { status: "custom", method: "custom", candidates: [], confirmed: true },
      faces: [{ id: "front", side: "front", name: "Custom front" }, { id: "back", side: "back", name: "Custom back" }],
      selectedArtworkByFace: {},
      importSource: { sourceId: "custom-import", importKind: "image", entryKind: "custom-card" },
    };
    const unlinked: ArtworkCandidate = { ...candidate, identityId: null, faceId: "front" };
    const customCatalogCandidate: ArtworkCandidate = { ...unlinked, identityId: "custom:artwork-picker", faceId: "back" };
    const selectArtwork = vi.fn((workingCard: WorkingCard, faceId: "front" | "back", selected: ArtworkCandidate) => selectWorkingCardArtwork(workingCard, faceId, {
      candidateId: selected.id, source: selected.source, identityId: workingCard.identity?.id ?? null, faceId,
    }));
    const workbench = testWorkbench({
      getArtworkCandidate: vi.fn(async () => unlinked),
      listArtworkCandidates: vi.fn(async (identityId: string, faceId: "front" | "back", source: string) =>
        identityId === "custom:artwork-picker" && faceId === "back" && source === "upload" ? [customCatalogCandidate] : []),
      selectArtwork,
    });
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "select", card: custom, faceId: "back", candidateId: unlinked.id,
    }), workbench);
    const body = await response.json() as { workingCards: WorkingCard[] };

    expect(response.status).toBe(200);
    expect(selectArtwork).toHaveBeenCalledWith(expect.objectContaining({ id: custom.id, identity: null }), "back", customCatalogCandidate);
    expect(body.workingCards[0]?.selectedArtworkByFace.back).toMatchObject({ candidateId: unlinked.id, identityId: null, faceId: "back" });
  });

  it("rejects a new simple-card Scryfall back through the M6 scoped API before provider lookup", async () => {
    const forbidden = { ...candidate, id: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:back", source: "scryfall" as const, faceId: "back" as const };
    const getArtworkCandidate = vi.fn(async () => forbidden);
    const selectArtwork = vi.fn((workingCard: WorkingCard) => workingCard);
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "apply-artwork-scope", cards: [card], targetCardId: card.id, faceId: "back",
      scope: "entry", candidateId: forbidden.id,
    }), testWorkbench({ getArtworkCandidate, selectArtwork }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_PHYSICAL_BACK_SELECTION" });
    expect(getArtworkCandidate).not.toHaveBeenCalled();
    expect(selectArtwork).not.toHaveBeenCalled();
  });

  it("updates MPC back provenance only on entries included in the chosen scope", async () => {
    const manualCandidate: ArtworkCandidate = {
      id: `mpc:${"f".repeat(64)}`, source: "mpc", identityId: null, faceId: "back",
      providerAssetId: "scoped-cardback", originalAvailable: true, metadata: { cardType: "CARDBACK" },
    };
    const alreadySelectedElsewhere = {
      ...card, id: "outside-scope", order: 1,
      manualBackArtwork: { candidateId: manualCandidate.id, source: "mpc" as const, identityId: null, faceId: "back" as const, providerAssetId: manualCandidate.providerAssetId, selectionPolicy: "user-selected" as const },
      backMode: "manual" as const,
    };
    const selectManualBackArtwork = vi.fn((workingCard: WorkingCard) => ({ ...workingCard, provenanceUpdated: true }));
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "apply-generic-back-scope", cards: [card, alreadySelectedElsewhere], targetCardId: card.id,
      scope: "entry", choiceMode: "mpc", candidateId: manualCandidate.id,
    }), testWorkbench({ getArtworkCandidate: vi.fn(async () => manualCandidate), selectManualBackArtwork }));
    const result = await response.json() as { workingCards: Array<WorkingCard & { provenanceUpdated?: boolean }> };

    expect(response.status).toBe(200);
    expect(selectManualBackArtwork).toHaveBeenCalledTimes(1);
    expect(selectManualBackArtwork).toHaveBeenCalledWith(expect.objectContaining({ id: card.id }), manualCandidate);
    expect(result.workingCards[1]).not.toHaveProperty("provenanceUpdated");
  });

  it("applies all-equal artwork by provider and CardIdentity ID rather than by name", async () => {
    const alternative = { ...candidate, id: `upload:${"e".repeat(64)}` };
    const otherIdentityCard = { ...card, id: "same-name-other-identity", order: 2, identity: { ...identity, id: "scryfall:oracle:different", name: identity.name } };
    const workbench = testWorkbench({
      listArtworkCandidates: vi.fn(async () => [alternative]),
      getArtworkCandidate: vi.fn(async () => alternative),
      selectArtwork: vi.fn((workingCard: WorkingCard, side: "front" | "back", selected: ArtworkCandidate) => selectWorkingCardArtwork(workingCard, side, {
        candidateId: selected.id, source: selected.source, identityId: workingCard.identity?.id ?? null, faceId: side, selectionPolicy: "user-selected",
      })),
    });
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "apply-artwork-scope", cards: [card, { ...card, id: "same-identity-copy", order: 1 }, otherIdentityCard],
      targetCardId: card.id, faceId: "front", candidateId: alternative.id, scope: "same-identity",
    }), workbench);
    const result = await response.json() as { workingCards: WorkingCard[] };

    expect(response.status).toBe(200);
    expect(result.workingCards.map((item) => item.selectedArtworkByFace.front?.candidateId)).toEqual([
      alternative.id, alternative.id, candidateId,
    ]);
  });

  it.each([
    { label: "Scryfall", candidate: { ...candidate, id: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front", source: "scryfall" as const, faceId: "front" } },
    { label: "upload", candidate },
  ])("rejects a new $label physical back selection through the API", async ({ candidate: forbidden }) => {
    const workbench = testWorkbench({ getArtworkCandidate: vi.fn(async () => forbidden), selectManualBackArtwork: vi.fn() });
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "select-manual-back-artwork", card, candidateId: forbidden.id,
    }), workbench);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_PHYSICAL_BACK_SELECTION" });
    expect(workbench.selectManualBackArtwork).not.toHaveBeenCalled();
    expect(card).not.toHaveProperty("manualBackArtwork");
  });

  it.each([
    { label: "Scryfall", candidate: { ...candidate, id: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:back", source: "scryfall" as const, faceId: "back" } },
    { label: "upload", candidate: { ...candidate, faceId: "back" } },
  ])("rejects a forged back-face selection for a simple card through the API ($label)", async ({ candidate: forbidden }) => {
    const workbench = testWorkbench({
      getArtworkCandidate: vi.fn(async () => forbidden),
      selectArtwork: vi.fn((workingCard: WorkingCard) => workingCard),
    });
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "select",
      card: { ...card, faces: [...card.faces, { id: "back", side: "back", name: "Forged face" }] },
      faceId: "back",
      candidateId: forbidden.id,
    }), workbench);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_PHYSICAL_BACK_SELECTION" });
    expect(workbench.getArtworkCandidate).not.toHaveBeenCalled();
    expect(workbench.selectArtwork).not.toHaveBeenCalled();
    expect(card.selectedArtworkByFace.back).toBeUndefined();
  });

  it("rejects restore-default-artwork for a forged Back on a simple identity before provider lookup", async () => {
    const restoreDefaultArtwork = vi.fn(async (workingCard: WorkingCard) => workingCard);
    const workbench = testWorkbench({ restoreDefaultArtwork });
    const simpleWithForgedBack = {
      ...card,
      faces: [...card.faces, { id: "back", side: "back" as const, name: "Forged face" }],
    };
    const before = structuredClone(simpleWithForgedBack);

    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "restore-default-artwork",
      card: simpleWithForgedBack,
      faceId: "back",
    }), workbench);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_PHYSICAL_BACK_SELECTION" });
    expect(restoreDefaultArtwork).not.toHaveBeenCalled();
    expect(simpleWithForgedBack).toEqual(before);
  });

  it("maps a BackSelectionPolicyError from a domain call to a deterministic client error", async () => {
    const manualCandidate: ArtworkCandidate = {
      id: "mpc:cardback-policy-test",
      source: "mpc",
      identityId: null,
      faceId: "back",
      providerAssetId: "mpc-cardback-123",
      originalAvailable: true,
      metadata: { cardType: "CARDBACK" },
    };
    const workbench = testWorkbench({
      getArtworkCandidate: vi.fn(async () => manualCandidate),
      selectManualBackArtwork: vi.fn(() => { throw new BackSelectionPolicyError(); }),
    });

    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "select-manual-back-artwork",
      card,
      candidateId: manualCandidate.id,
    }), workbench);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_PHYSICAL_BACK_SELECTION" });
  });

  it("accepts a hydrated MPC CARDBACK through the API and preserves the explicit lock", async () => {
    const manualCandidate: ArtworkCandidate = {
      id: `mpc:${"e".repeat(64)}`, source: "mpc", identityId: null, faceId: "back", providerAssetId: "mpc-cardback-123",
      originalAvailable: true, metadata: { cardType: "CARDBACK" },
    };
    const workbench = testWorkbench({
      getArtworkCandidate: vi.fn(async () => manualCandidate),
      selectManualBackArtwork: vi.fn((workingCard: WorkingCard) => ({
        ...workingCard,
        manualBackArtwork: { candidateId: manualCandidate.id, source: "mpc", identityId: null, faceId: "back", providerAssetId: manualCandidate.providerAssetId, selectionPolicy: "user-selected" },
        backMode: "manual",
        backModeSelectionPolicy: "explicit",
      })),
    });
    const response = await handleResolve(jsonRequest("http://localhost/api/cards/resolve", {
      action: "select-manual-back-artwork", card, candidateId: manualCandidate.id,
    }), workbench);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workingCards: [{ faces: [{ side: "front" }], backMode: "manual", manualBackArtwork: { source: "mpc", faceId: "back" } }] });
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

  it("returns all 1200 artwork DTOs and distinguishes verified, provider-reported, unknown, and unavailable quality", async () => {
    const candidates: ArtworkCandidate[] = Array.from({ length: 1200 }, (_, index) => ({
      id: `scryfall:printing-${index}:front`, source: index === 1 ? "mpc" : "scryfall", identityId: identity.id,
      faceId: "front", originalAvailable: index !== 3, previewUri: `https://cards.scryfall.io/printing-${index}.jpg`,
      ...(index === 0 ? { widthPx: 1995, heightPx: 2793, effectiveDpi: 798 } : {}),
      ...(index === 1 ? { metadata: { dpi: 800 } } : {}),
      ...(index === 2 ? { widthPx: 1995, heightPx: 2793 } : {}),
    }));
    const workbench = testWorkbench({ listArtworkCandidates: vi.fn(async () => candidates) });

    const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", { faceId: "front", source: "all" }), identity.id, workbench);
    const body = await response.json() as { candidates: Array<Record<string, unknown>> };

    expect(body.candidates).toHaveLength(1200);
    expect(body.candidates.at(-1)?.id).toBe("scryfall:printing-1199:front");
    expect(body.candidates.slice(0, 4).map(({ qualityStatus }) => qualityStatus)).toEqual(["verified", "provider-reported", "unknown", "unavailable"]);
  });

  it("preserves MPC online-versus-cached original status in artwork candidate DTOs", async () => {
    const mpcCandidate: ArtworkCandidate = { ...candidate, id: "mpc:opaque", source: "mpc", originalAvailable: true, originalCached: false, metadata: { ...(candidate.metadata ?? {}), localAvailabilityHint: true } };
    const workbench = testWorkbench({ listArtworkCandidates: vi.fn(async () => [mpcCandidate]) });
    const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", { faceId: "front", source: "mpc" }), identity.id, workbench);
    const body = await response.json() as { candidates: Array<Record<string, unknown>> };

    expect(body.candidates[0]).toMatchObject({ source: "mpc", originalAvailable: true, originalCached: false, metadata: { localAvailabilityHint: true } });
  });

  it("keeps providerRank and freshness while excluding upstream URLs and free-form MPC text from candidate DTOs", async () => {
    const mpcCandidate: ArtworkCandidate = {
      ...candidate,
      id: `mpc:${"a".repeat(64)}`,
      source: "mpc",
      originalAvailable: true,
      metadata: {
        providerRank: 2,
        metadataFreshness: "revalidated",
        sourceName: "https://private.example/?token=secret",
        name: "https://private.example/art.png",
        canonicalArtist: { name: "https://private.example/artist" },
        extension: "png",
      },
    };
    const workbench = testWorkbench({ listArtworkCandidates: vi.fn(async () => [mpcCandidate]) });
    const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", { faceId: "front", source: "mpc" }), identity.id, workbench);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(body).toMatchObject({ candidates: [{ metadata: { providerRank: 2, metadataFreshness: "revalidated", extension: "png" } }] });
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("token=secret");
  });

  it("normalizes the TCGPrint MPC filter contract at the artwork API and rejects raw MPC search payloads", async () => {
    const listArtworkCandidates = vi.fn(async () => []);
    const workbench = testWorkbench({ listArtworkCandidates });
    const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", {
      faceId: "front", source: "mpc",
      mpcFilters: { minimumDpi: 300, maximumDpi: 1200, sources: [42, 41, 42], includeTags: ["Promo"], excludeTags: ["Foil"], languages: ["EN"] },
    }), identity.id, workbench);

    expect(response.status).toBe(200);
    expect(listArtworkCandidates).toHaveBeenCalledWith(identity.id, "front", "mpc", expect.objectContaining({
      mpcFilters: expect.objectContaining({ minimumDpi: 300, maximumDpi: 1200, sources: [41, 42], includeTags: ["promo"], excludeTags: ["foil"], languages: ["en"] }),
    }));
    const unsafe = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", {
      faceId: "front", source: "mpc", mpcFilters: { searchSettings: { arbitrary: true } },
    }), identity.id, workbench);
    expect(unsafe.status).toBe(400);
    expect(await unsafe.json()).toMatchObject({ code: "INVALID_MPC_FILTERS" });
  });

  it("passes an explicit MPC search refresh through the API without changing artwork selection", async () => {
    const listArtworkCandidates = vi.fn(async () => [candidate]);
    const workbench = testWorkbench({ listArtworkCandidates });
    const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", {
      faceId: "front", source: "mpc", forceMpcRefresh: true,
    }), identity.id, workbench);

    expect(response.status).toBe(200);
    expect(listArtworkCandidates).toHaveBeenCalledWith(identity.id, "front", "mpc", expect.objectContaining({ forceMpcRefresh: true }));
    expect(card.selectedArtworkByFace.front?.candidateId).toBe(candidateId);
  });

  it("returns bounded structured MPC batch revalidation results and rejects oversized input", async () => {
    const ids = [`mpc:${"a".repeat(64)}`, `mpc:${"b".repeat(64)}`];
    const result = { candidateId: ids[0]!, providerAssetId: "asset-id-123456", status: "metadata-updated", localOriginal: "valid", candidate };
    const revalidateMpcArtworkCandidates = vi.fn(async () => [result]);
    const workbench = testWorkbench({ revalidateMpcArtworkCandidates });

    const response = await handleMpcArtworkBatchRevalidation(jsonRequest("http://localhost/api/cards/artworks/mpc-revalidation", { candidateIds: ids }), workbench);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ candidateId: ids[0], providerAssetId: "asset-id-123456", status: "metadata-updated", localOriginal: "valid" }] });
    expect(revalidateMpcArtworkCandidates).toHaveBeenCalledWith(ids, expect.anything());

    const tooMany = await handleMpcArtworkBatchRevalidation(jsonRequest("http://localhost/api/cards/artworks/mpc-revalidation", { candidateIds: Array.from({ length: 501 }, () => ids[0]) }), workbench);
    expect(tooMany.status).toBe(400);
  });

  it("maps MPC HTTP 429 to a safe rate-limit response and provides a safe diagnostics report", async () => {
    const mpcDiagnostic = {
      available: false, degraded: true, lastProtocolConfirmed: null, v3Available: null, fallbackV2Used: false,
      lastFailureType: "rate-limited", catalogCaches: { sources: { state: "empty" }, languages: { state: "empty" }, tags: { state: "empty" } },
      searchCacheHits: 0, searchCacheMisses: 0,
      capabilities: { search: false, preview: false, original: false, filters: { dpi: false, sources: false, tags: false, languages: false }, protocol: { confirmedVersion: null, v3Available: null, fallbackV2Used: false } },
      metrics: { candidateMetadataCache: { hits: 0, misses: 0 }, thumbnailCache: { hits: 0, misses: 0 }, originalCache: { hits: 0, misses: 0 }, inFlightRequests: { api: 0, images: 0 }, remoteRequestCount: 1, negativeSearchCacheHits: 0, negativeSearchCacheWrites: 0, timeouts: 0, httpStatusSummary: { "429": 1 }, protocolFailures: 0, rateLimits: 1, omittedHydrationCount: 0, hydrationBatchCount: 0, revalidation: { batches: 0, candidates: 0, outcomes: {} } },
      recentFailures: [{ at: new Date(0).toISOString(), kind: "rate-limited", status: 429 }],
    } as const;
    const workbench = testWorkbench({ getMpcArtworkProviderDiagnostic: () => mpcDiagnostic });

    const mapped = await handleMpcArtworkRefresh(new Request("http://localhost", { method: "POST" }), `mpc:${"a".repeat(64)}`, testWorkbench({ refreshMpcArtworkCandidate: vi.fn(async () => { throw new MpcArtworkProviderError("rate-limited", "https://private.example/?token=secret", 429); }) }));
    expect(mapped.status).toBe(429);
    expect(await mapped.json()).toMatchObject({ code: "MPC_RATE_LIMITED", message: "MPC artwork service is rate limited. Try again shortly." });
    const report = await handleMpcArtworkDiagnosticsReport(workbench);
    const body = await report.json();
    expect(report.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ schemaVersion: 1, provider: "mpc", health: { degraded: true } });
    expect(JSON.stringify(body)).not.toContain("private.example");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("disables intermediary caching for dynamic MPC diagnostics and catalog responses", async () => {
    const workbench = testWorkbench({
      getMpcArtworkProviderDiagnostic: () => undefined,
      getMpcArtworkFilterCatalogs: vi.fn(async () => ({ sources: [], languages: [], tags: [] })),
    });

    const diagnostic = handleMpcArtworkDiagnostics(workbench);
    const catalogs = await handleMpcArtworkCatalogs(new Request("http://localhost/api/cards/artworks/mpc-catalogs"), workbench);

    expect(diagnostic.headers.get("cache-control")).toBe("no-store");
    expect(catalogs.headers.get("cache-control")).toBe("no-store");
  });

  it("lists only dedicated MPC CARDBACK results for a simple card's physical-back catalog", async () => {
    const mpcBack: ArtworkCandidate = {
      ...candidate,
      id: `mpc:${"c".repeat(64)}`,
      source: "mpc",
      faceId: "back",
      providerAssetId: "mpc-back-source",
      selectedArtworkId: "selected-back-source",
      originalAvailable: false,
      metadata: { cardType: "CARDBACK" },
    };
    const listMpcCardbackCandidates = vi.fn(async () => [mpcBack, { ...mpcBack, id: `mpc:${"f".repeat(64)}`, metadata: { cardType: "CARD" } }]);
    const workbench = testWorkbench({ listMpcCardbackCandidates });
    const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", {
      faceId: "front", source: "all", physicalBackArtwork: true,
      mpcReferences: [{ faceId: "back", importedAssetId: "imported-back", providerAssetId: "mpc-back-source", selectedArtworkId: "selected-back-source", slots: [], availableLocally: false }],
    }), identity.id, workbench);
    const body = await response.json() as { candidates: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(listMpcCardbackCandidates).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.anything() }));
    expect(body.candidates).toEqual([expect.objectContaining({ id: mpcBack.id, source: "mpc", faceId: "back", metadata: { cardType: "CARDBACK" } })]);
  });

  it("rejects Scryfall and upload sources from the generic physical-back listing", async () => {
    const listMpcCardbackCandidates = vi.fn(async () => []);
    const workbench = testWorkbench({ listMpcCardbackCandidates });
    for (const source of ["scryfall", "upload"]) {
      const response = await handleArtworkList(jsonRequest("http://localhost/api/cards/id/artworks", { faceId: "front", source, physicalBackArtwork: true }), identity.id, workbench);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_PHYSICAL_BACK_SOURCE" });
    }
    expect(listMpcCardbackCandidates).not.toHaveBeenCalled();
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

  it.each([512, 768, 1024, 1280])("serves compositor display bucket %i with actual image dimensions", async (width) => {
    const displayBytes = new Uint8Array(await sharp({ create: { width: 500, height: 700, channels: 3, background: "#246" } }).png().toBuffer());
    const getArtworkDisplay = vi.fn(async (_id: string, _bucket: number, _signal?: AbortSignal) => ({
      bytes: displayBytes,
      contentType: "image/png" as const,
      widthPx: 500,
      heightPx: 700,
      sourceHash: "a".repeat(64),
      bucket: width as 512 | 768 | 1024 | 1280,
      source: "original" as const,
    }));
    const workbench = testWorkbench({ getArtworkDisplay });

    const response = await handleArtworkDisplay(new Request(`http://localhost/api/cards/artworks/${candidateId}/display?width=${width}`), candidateId, workbench);
    const metadata = await sharp(new Uint8Array(await response.arrayBuffer())).metadata();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tcgprint-artwork-role")).toBe("compositor-display");
    expect(response.headers.get("x-tcgprint-display-bucket")).toBe(String(width));
    expect(response.headers.get("x-tcgprint-display-width")).toBe("500");
    expect(response.headers.get("x-tcgprint-display-height")).toBe("700");
    expect(metadata).toMatchObject({ width: 500, height: 700 });
    expect(getArtworkDisplay).toHaveBeenCalledWith(candidateId, width, expect.anything());
  });

  it.each([undefined, "513", "512&width=768", "1e3", "0512"]) ("rejects invalid compositor display widths (%s)", async (width) => {
    const getArtworkDisplay = vi.fn();
    const workbench = testWorkbench({ getArtworkDisplay });
    const query = width === undefined ? "" : `?width=${width}`;
    const response = await handleArtworkDisplay(new Request(`http://localhost/api/cards/artworks/${candidateId}/display${query}`), candidateId, workbench);
    expect(response.status).toBe(400);
    expect(getArtworkDisplay).not.toHaveBeenCalled();
  });

  it("returns DISPLAY_UNAVAILABLE when no original display derivative can be produced", async () => {
    const getArtworkDisplay = vi.fn(async () => undefined);
    const getArtworkPreview = vi.fn();
    const workbench = testWorkbench({ getArtworkDisplay, getArtworkPreview });

    const response = await handleArtworkDisplay(new Request(`http://localhost/api/cards/artworks/${candidateId}/display?width=512`), candidateId, workbench);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "DISPLAY_UNAVAILABLE" });
    expect(getArtworkDisplay).toHaveBeenCalledWith(candidateId, 512, expect.anything());
    expect(getArtworkPreview).not.toHaveBeenCalled();
  });

  it("revalidates cached display responses with an ETag", async () => {
    const displayBytes = new Uint8Array(await sharp({ create: { width: 500, height: 700, channels: 3, background: "#246" } }).png().toBuffer());
    const workbench = testWorkbench({ getArtworkDisplay: vi.fn(async () => ({
      bytes: displayBytes, contentType: "image/png" as const, widthPx: 500, heightPx: 700,
      sourceHash: "a".repeat(64), bucket: 512 as const, source: "original" as const,
    })) });
    const first = await handleArtworkDisplay(new Request(`http://localhost/api/cards/artworks/${candidateId}/display?width=512`), candidateId, workbench);
    const etag = first.headers.get("etag");
    const second = await handleArtworkDisplay(new Request(`http://localhost/api/cards/artworks/${candidateId}/display?width=512`, { headers: { "If-None-Match": etag! } }), candidateId, workbench);

    expect(etag).toMatch(/^"sha256-[a-f0-9]{64}"$/);
    expect(first.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  it("preserves canonical bleed geometry for compositor display without changing its base source", async () => {
    const sourceBytes = new Uint8Array(await sharp({ create: { width: 127, height: 178, channels: 4, background: { r: 35, g: 115, b: 205, alpha: 1 } } }).png().toBuffer());
    const getArtworkDisplay = vi.fn(async () => ({ bytes: sourceBytes, contentType: "image/png" as const, widthPx: 127, heightPx: 178, sourceHash: "a".repeat(64), bucket: 512 as const, source: "original" as const }));
    const workbench = testWorkbench({ getArtworkDisplay });
    const response = await handleArtworkDisplay(new Request(`http://localhost/api/cards/artworks/${candidateId}/display?width=512&trimWidthMm=63.5&trimHeightMm=88.9&bleedMm=1&roundedCorners=true&cornerRadiusMm=3.175`), candidateId, workbench);
    const outputBytes = new Uint8Array(await response.arrayBuffer());
    const metadata = await sharp(outputBytes).metadata();
    const bleedX = Math.ceil(127 / 63.5);
    const bleedY = Math.ceil(178 / 88.9);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(metadata.width).toBe(127 + bleedX * 2);
    expect(metadata.height).toBe(178 + bleedY * 2);
    expect(workbench.getArtworkOriginal).not.toHaveBeenCalled();
    expect(workbench.getArtworkPreview).not.toHaveBeenCalled();
  });

  it("serves live bleed as a cached-thumbnail derivative without requesting the print original", async () => {
    const sourceBytes = new Uint8Array(await sharp({
      create: { width: 127, height: 178, channels: 4, background: { r: 35, g: 115, b: 205, alpha: 1 } },
    }).png().toBuffer());
    const workbench = testWorkbench({
      getArtworkPreview: vi.fn(async () => ({ candidateId, source: "upload", bytes: sourceBytes, contentType: "image/png", widthPx: 127, heightPx: 178 })),
    });
    const response = await handleArtworkPreview(new Request("http://localhost/api/cards/artworks/preview?bleedMm=1&trimWidthMm=63.5&trimHeightMm=88.9&roundedCorners=false"), candidateId, workbench);
    const outputBytes = new Uint8Array(await response.arrayBuffer());
    const source = await sharp(sourceBytes).raw().toBuffer({ resolveWithObject: true });
    const output = await sharp(outputBytes).raw().toBuffer({ resolveWithObject: true });
    const sourceTopLeft = source.data.subarray(0, source.info.channels);
    const outputTopLeft = output.data.subarray(0, output.info.channels);
    const bleedX = Math.ceil(source.info.width * 1 / 63.5);
    const bleedY = Math.ceil(source.info.height * 1 / 88.9);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tcgprint-artwork-role")).toBe("preview");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(output.info.width).toBe(source.info.width + bleedX * 2);
    expect(output.info.height).toBe(source.info.height + bleedY * 2);
    expect(outputTopLeft).toEqual(sourceTopLeft);
    expect(workbench.getArtworkPreview).toHaveBeenCalledWith(candidateId, expect.anything());
    expect(workbench.getArtworkOriginal).not.toHaveBeenCalled();

    const invalid = await handleArtworkPreview(new Request("http://localhost/api/cards/artworks/preview?bleedMm=4&trimWidthMm=63.5&trimHeightMm=88.9"), candidateId, workbench);
    expect(invalid.status).toBe(400);
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
    const controller = new AbortController();

    const response = await postArtworkSelection(card, "front", frontCandidate.id, pickerFetch, controller.signal);
    const body = await response.json() as { workingCards: WorkingCard[] };

    expect(response.status).toBe(200);
    expect(pickerFetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(JSON.parse(String(pickerFetch.mock.calls[0][1]?.body))).toMatchObject({ action: "select", faceId: "front", candidateId: frontCandidate.id });
    expect(body.workingCards[0].selectedArtworkByFace.front).toMatchObject({ candidateId: frontCandidate.id, source: "scryfall", faceId: "front" });
    expect(body.workingCards[0].id).toBe(card.id);
    expect(body.workingCards[0].identity?.id).toBe(identity.id);
  });

  it("selects the back candidate from the Artwork Picker for a DFC", async () => {
    const backCandidate: ArtworkCandidate = { ...candidate, id: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:back", source: "scryfall", faceId: "back", originalUri: undefined, localOriginalPath: undefined, previewUri: "https://cards.scryfall.io/small/back.png" };
    const dfcCard: WorkingCard = {
      ...card,
      identity: { ...identity, name: "Front Face // Back Face", metadata: { layout: "transform", faces: [{ name: "Front Face" }, { name: "Back Face" }] } },
      faces: [{ id: "front", side: "front", name: "Front Face" }, { id: "back", side: "back", name: "Back Face" }],
    };
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
