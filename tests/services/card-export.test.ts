import { mkdtemp, readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import normal from "../fixtures/scryfall/normal-card.json";
import { createCardWorkbench, type CardWorkbench } from "../../services/card-workbench";
import { handleCardExport } from "../../services/card-api";
import { exportWorkingCards, exportWorkingCardsByContentMode, exportWorkingCardsWithDiagnostics } from "../../services/card-export";
import { PAPER_FORMATS } from "../../core/geometry";
import { createWorkingCardEditorState, deleteWorkingCard, duplicateWorkingCard, moveWorkingCard, setWorkingCardQuantity } from "../../core/cards/working-card-editor";
import { commitEditorHistory, createEditorHistoryState, redoEditorHistory, undoEditorHistory } from "../../core/cards/editor-history";
import { BleedEngine } from "../../image-engine/bleed";
import { LosslessPdfEngine } from "../../pdf-engine/document";
import type { ArtworkCandidate, WorkingCard } from "../../core/cards/types";
import type { PrinterProfileSnapshot } from "../../core/calibration";
import { FULL_TRIM_GUIDES, NO_CUT_GUIDES } from "../helpers/cut-guides";

const roots: string[] = [];
const workbenches: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const workbench of workbenches.splice(0)) await workbench.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("decklist → identity → Scryfall artwork → PDF", () => {
  it("bounds unique bleed work to two concurrent tasks and preserves card order", async () => {
    const images = new Map<string, Uint8Array>();
    const candidates = new Map<string, ArtworkCandidate>();
    const originals = new Map<string, Awaited<ReturnType<CardWorkbench["getArtworkOriginal"]>>>();
    for (let index = 0; index < 5; index += 1) {
      const id = `upload:bounded-bleed-${index}`;
      const bytes = new Uint8Array(await sharp({
        create: { width: 8, height: 6, channels: 3, background: { r: index * 31, g: 255 - index * 23, b: index * 17 } },
      }).jpeg().toBuffer());
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      images.set(id, bytes);
      candidates.set(id, { id, source: "upload", identityId: null, faceId: "front", originalAvailable: true });
      originals.set(id, {
        artworkId: id, contentHash, extension: "jpg", format: "jpeg", byteLength: bytes.byteLength,
        widthPx: 8, heightPx: 6, createdAt: "2026-10-01T12:00:00.000Z", bytes, provenance: [],
      });
    }
    const catalog = {
      getArtworkCandidate: vi.fn(async (id: string) => candidates.get(id)),
      getArtworkOriginal: vi.fn(async (id: string) => originals.get(id)!),
    };
    const cards = [...images.keys()].map((id, index) => ({
      id: `bounded-bleed-${index}`, quantity: 1, order: index,
      importSource: { sourceId: id, importKind: "synthetic" as const, entryKind: "card" as const },
      identityHints: {}, identity: null,
      identityResolution: { status: "unresolved" as const, candidates: [], confirmed: false },
      faces: [{ id: `${id}-front`, side: "front" as const }],
      selectedArtworkByFace: { front: { candidateId: id, source: "upload" as const, identityId: null, faceId: "front" } },
      backMode: "none" as const, backModeSelectionPolicy: "explicit" as const,
      localArtworkIds: [], mpcReferences: [], faceAssociations: [],
    } satisfies WorkingCard));
    const originalGenerate = BleedEngine.prototype.generate;
    let active = 0;
    let peak = 0;
    const generate = vi.spyOn(BleedEngine.prototype, "generate").mockImplementation(async function (this: BleedEngine, request) {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 8));
        return await originalGenerate.call(this, request);
      } finally {
        active -= 1;
      }
    });

    const result = await exportWorkingCardsWithDiagnostics(catalog, cards, { bleedMm: 0.625, cutGuides: NO_CUT_GUIDES });

    expect(generate).toHaveBeenCalledTimes(5);
    expect(peak).toBe(Math.min(2, availableParallelism()));
    expect(result.bleedDiagnostics.map(({ workingCardId }) => workingCardId)).toEqual(cards.map(({ id }) => id));
  });

  it("does not start queued bleed work or publish a PDF after cancellation", async () => {
    const images = new Map<string, Uint8Array>();
    const candidates = new Map<string, ArtworkCandidate>();
    const originals = new Map<string, Awaited<ReturnType<CardWorkbench["getArtworkOriginal"]>>>();
    for (let index = 0; index < 5; index += 1) {
      const id = `upload:cancel-bleed-${index}`;
      const bytes = new Uint8Array(await sharp({
        create: { width: 8, height: 6, channels: 3, background: { r: index * 31, g: 255 - index * 23, b: index * 17 } },
      }).jpeg().toBuffer());
      candidates.set(id, { id, source: "upload", identityId: null, faceId: "front", originalAvailable: true });
      originals.set(id, {
        artworkId: id, contentHash: createHash("sha256").update(bytes).digest("hex"), extension: "jpg", format: "jpeg",
        byteLength: bytes.byteLength, widthPx: 8, heightPx: 6, createdAt: "2026-10-01T12:00:00.000Z", bytes, provenance: [],
      });
    }
    const controller = new AbortController();
    let lookups = 0;
    const catalog = {
      async getArtworkCandidate(id: string) {
        lookups += 1;
        if (lookups === 4) controller.abort();
        return candidates.get(id);
      },
      async getArtworkOriginal(id: string) { return originals.get(id)!; },
    };
    const cards = [...candidates.keys()].map((id, index) => ({
      id: `cancel-bleed-${index}`, quantity: 1, order: index,
      importSource: { sourceId: id, importKind: "synthetic" as const, entryKind: "card" as const },
      identityHints: {}, identity: null,
      identityResolution: { status: "unresolved" as const, candidates: [], confirmed: false },
      faces: [{ id: `${id}-front`, side: "front" as const }],
      selectedArtworkByFace: { front: { candidateId: id, source: "upload" as const, identityId: null, faceId: "front" } },
      backMode: "none" as const, backModeSelectionPolicy: "explicit" as const,
      localArtworkIds: [], mpcReferences: [], faceAssociations: [],
    } satisfies WorkingCard));
    const originalGenerate = BleedEngine.prototype.generate;
    const generate = vi.spyOn(BleedEngine.prototype, "generate").mockImplementation(async function (this: BleedEngine, request) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      return await originalGenerate.call(this, request);
    });
    const pdfGenerate = vi.spyOn(LosslessPdfEngine.prototype, "generate");

    await expect(exportWorkingCardsWithDiagnostics(catalog, cards, { bleedMm: 0.625, cutGuides: NO_CUT_GUIDES }, controller.signal))
      .rejects.toThrow(/cancelled/i);

    expect(controller.signal.aborted).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(pdfGenerate).not.toHaveBeenCalled();
  });

  it("memoizes repeated candidate metadata and original reads within one export", async () => {
    const bytes = new Uint8Array(await readFile(join(process.cwd(), "tests", "fixtures", "pdf", "synthetic-gradient.jpg")));
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const candidate: ArtworkCandidate = {
      id: "upload:repeated-export",
      source: "upload",
      identityId: null,
      faceId: "front",
      originalAvailable: true,
    };
    const original = {
      artworkId: candidate.id,
      contentHash,
      extension: "jpg",
      format: "jpeg" as const,
      byteLength: bytes.byteLength,
      widthPx: 8,
      heightPx: 6,
      createdAt: "2026-10-01T12:00:00.000Z",
      bytes,
      provenance: [],
    };
    const catalog = {
      getArtworkCandidate: vi.fn(async () => candidate),
      getArtworkOriginal: vi.fn(async () => original),
    };
    const cards: WorkingCard[] = Array.from({ length: 100 }, (_, order) => ({
      id: `repeated-${order}`,
      quantity: 1,
      order,
      importSource: { sourceId: `repeated-${order}`, importKind: "synthetic", entryKind: "card" },
      identityHints: {},
      identity: null,
      identityResolution: { status: "unresolved", candidates: [], confirmed: false },
      faces: [{ id: `repeated-${order}-front`, side: "front" }],
      selectedArtworkByFace: { front: { candidateId: candidate.id, source: "upload", identityId: null, faceId: "front" } },
      backMode: "none",
      backModeSelectionPolicy: "explicit",
      localArtworkIds: [],
      mpcReferences: [],
      faceAssociations: [],
    }));
    const generatePdf = vi.spyOn(LosslessPdfEngine.prototype, "generate");

    await exportWorkingCardsWithDiagnostics(catalog, cards, { bleedMm: 0, cutGuides: NO_CUT_GUIDES });

    expect(catalog.getArtworkCandidate).toHaveBeenCalledTimes(1);
    expect(catalog.getArtworkOriginal).toHaveBeenCalledTimes(1);
    const pdfRequest = generatePdf.mock.calls[0]![0];
    expect(pdfRequest.images).toHaveLength(100);
    expect(pdfRequest.images.every((image) => image === bytes)).toBe(true);
    expect(pdfRequest.imageSha256).toEqual(Array.from({ length: 100 }, () => contentHash));
  });

  it("routes front/back and separate/duplex exports through the selected side corrections", async () => {
    const bytes = new Uint8Array(await readFile(join(process.cwd(), "tests", "fixtures", "pdf", "synthetic-gradient.jpg")));
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const candidate: ArtworkCandidate = { id: "upload:calibration", source: "upload", identityId: null, faceId: "front", originalAvailable: true };
    const catalog = {
      getArtworkCandidate: async () => candidate,
      getArtworkOriginal: async () => ({
        artworkId: candidate.id, contentHash, extension: "jpg", format: "jpeg", byteLength: bytes.byteLength,
        widthPx: 8, heightPx: 6, createdAt: "2026-10-01T12:00:00.000Z", bytes, provenance: [],
      }),
    };
    const card: WorkingCard = {
      id: "calibration-side-card", quantity: 1, order: 0,
      importSource: { sourceId: "calibration-fixture", importKind: "synthetic", entryKind: "card" },
      identityHints: {}, identity: null,
      identityResolution: { status: "unresolved", candidates: [], confirmed: false },
      faces: [{ id: "front", side: "front" }],
      selectedArtworkByFace: { front: { candidateId: candidate.id, source: "upload", identityId: null, faceId: "front" } },
      backMode: "none", backModeSelectionPolicy: "explicit", localArtworkIds: [], mpcReferences: [], faceAssociations: [],
    };
    const profile: PrinterProfileSnapshot = {
      id: "profile-calibration-sides", name: "Side calibration",
      front: { offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 },
      back: { offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1.00012, scaleY: 0.99987 },
      paperSize: "A4", paperWidthMm: 210, paperHeightMm: 297, pageOrientation: "portrait", duplexMode: "manual-long-edge",
      physicalValidationStatus: "software-only", physicalVerification: null, version: 3, profileHash: "c".repeat(64),
    };
    const options = {
      bleedMm: 0, cutGuides: NO_CUT_GUIDES, paperFormat: PAPER_FORMATS.A4, cardFormat: { id: "small", name: "small", widthMm: 20, heightMm: 30 },
      pageOrientation: "portrait" as const, cardOrientation: "portrait" as const,
      printerProfileSelection: profile, duplexFlipMode: "long-edge" as const,
      missingBackPolicy: "warn-and-continue" as const,
    };

    const frontOnly = await exportWorkingCardsByContentMode(catalog, undefined, [card], { ...options, exportContentMode: "front-only" });
    const backOnly = await exportWorkingCardsByContentMode(catalog, undefined, [card], { ...options, exportContentMode: "back-only" });
    const separate = await exportWorkingCardsByContentMode(catalog, undefined, [card], { ...options, exportContentMode: "front-back-separated" });
    const duplex = await exportWorkingCardsByContentMode(catalog, undefined, [card], { ...options, exportContentMode: "duplex" });

    expect(frontOnly.calibration?.effectiveSides).toEqual([{ side: "front", parameters: profile.front }]);
    expect(backOnly.calibration?.effectiveSides).toEqual([{ side: "back", parameters: profile.back }]);
    expect(separate.manifest?.calibration?.effectiveSides).toEqual([
      { side: "front", parameters: profile.front }, { side: "back", parameters: profile.back },
    ]);
    expect(duplex.calibration?.effectiveSides).toEqual([
      { side: "front", parameters: profile.front }, { side: "back", parameters: profile.back },
    ]);
    expect(duplex.pageOrder).toEqual(["front:1", "back:1"]);
    expect((await PDFDocument.load(frontOnly.pdfBytes!)).getPages()).toHaveLength(1);
    expect((await PDFDocument.load(backOnly.pdfBytes!)).getPages()).toHaveLength(1);
    expect((await PDFDocument.load(separate.frontPdfBytes!)).getPages()).toHaveLength(1);
    expect((await PDFDocument.load(separate.backPdfBytes!)).getPages()).toHaveLength(1);
    expect((await PDFDocument.load(duplex.pdfBytes!)).getPages()).toHaveLength(2);

    const nearEdgeOptions = {
      bleedMm: 0, cutGuides: NO_CUT_GUIDES,
      paperFormat: { name: "Custom", widthMm: 100, heightMm: 150 },
      cardFormat: { id: "small", name: "small", widthMm: 20, heightMm: 30 },
      pageOrientation: "portrait" as const,
      templateGeometry: {
        orientation: "portrait" as const, cardOrientation: "portrait" as const,
        pageSizeMm: { widthMm: 100, heightMm: 150 }, cardSizeMm: { widthMm: 20, heightMm: 30 },
        rows: 1, columns: 1,
        slots: [{ index: 0, row: 0, column: 0, xMm: 0.65, yMm: 60 }],
      },
      printCalibration: { offsetXUm: -300, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 },
      calibrationSide: "back" as const,
    };
    const nearEdge = await exportWorkingCardsWithDiagnostics(catalog, [card], nearEdgeOptions);
    expect(nearEdge.calibrationBoundsWarnings).toContainEqual(expect.objectContaining({
      code: "CALIBRATION_NEAR_PAGE_EDGE", side: "back", pageNumber: 1, content: "card 1",
      nearestEdgeClearanceMm: 0.35,
    }));
    const nearEdgeWithTrimGuides = await exportWorkingCardsWithDiagnostics(catalog, [card], {
      ...nearEdgeOptions,
      cutGuides: {
        trim: { enabled: true, extentMm: 1, color: "blue" },
        external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
      },
    });
    expect(nearEdgeWithTrimGuides.calibrationBoundsWarnings).toContainEqual(expect.objectContaining({
      code: "CALIBRATION_NEAR_PAGE_EDGE", side: "back", pageNumber: 1,
      content: expect.stringMatching(/^trim cut guide /),
    }));
    await expect(exportWorkingCardsWithDiagnostics(catalog, [card], {
      ...nearEdgeOptions, printCalibration: { ...nearEdgeOptions.printCalibration, offsetXUm: -1_000 },
    })).rejects.toMatchObject({ code: "CALIBRATED_CONTENT_OUT_OF_BOUNDS" });
  });

  it("shares an edge-extension derivative for identical bytes across sources and metadata", async () => {
    const samples = new Uint8Array(127 * 178 * 3);
    for (let y = 0; y < 178; y += 1) {
      for (let x = 0; x < 127; x += 1) {
        const darkFrame = x < 3 || x >= 124 || y < 3 || y >= 175;
        const offset = (y * 127 + x) * 3;
        samples[offset] = darkFrame ? 3 : 48;
        samples[offset + 1] = darkFrame ? 4 : 126;
        samples[offset + 2] = darkFrame ? 5 : 214;
      }
    }
    const bytes = new Uint8Array(await sharp(samples, { raw: { width: 127, height: 178, channels: 3 } }).png().toBuffer());
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const candidates: Record<string, ArtworkCandidate> = {
      "scryfall:synthetic": { id: "scryfall:synthetic", source: "scryfall", identityId: null, faceId: "front", originalAvailable: true },
      "scryfall:synthetic-full-art": { id: "scryfall:synthetic-full-art", source: "scryfall", identityId: null, faceId: "front", originalAvailable: true, metadata: { fullArt: true, borderColor: "borderless" } },
      "upload:synthetic": { id: "upload:synthetic", source: "upload", identityId: null, faceId: "front", originalAvailable: true },
    };
    const catalog = {
      getArtworkCandidate: async (id: string) => candidates[id],
      getArtworkOriginal: async (id: string) => ({
        artworkId: id,
        contentHash,
        format: "png",
        extension: "png",
        byteLength: bytes.byteLength,
        widthPx: 127,
        heightPx: 178,
        provenance: [],
        createdAt: "2026-09-26T00:00:00.000Z",
        bytes,
      }),
    };
    const card = (id: string, source: "scryfall" | "upload", order: number, candidateId = `${source}:synthetic`): WorkingCard => ({
      id,
      quantity: 1,
      order,
      importSource: { sourceId: id, importKind: "synthetic", entryKind: "card" },
      identityHints: {},
      identity: null,
      identityResolution: { status: "unresolved", candidates: [], confirmed: false },
      faces: [{ id: `${id}-front`, side: "front" }],
      selectedArtworkByFace: { front: { candidateId, source, identityId: null, faceId: "front" } },
      backMode: "project-default" as const,
      backModeSelectionPolicy: "automatic" as const,
      localArtworkIds: [],
      mpcReferences: [],
      faceAssociations: [],
    });
    const generate = vi.spyOn(BleedEngine.prototype, "generate");

    const result = await exportWorkingCardsWithDiagnostics(catalog, [
      card("scryfall-card", "scryfall", 0),
      card("upload-card", "upload", 1),
      card("full-art-card", "scryfall", 2, "scryfall:synthetic-full-art"),
    ], {
      bleedMm: 1,
      cutGuides: NO_CUT_GUIDES,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls.map(([request]) => request.imageBytes)).toEqual([bytes]);
    expect(generate.mock.calls.map(([request]) => request.bleedMm)).toEqual([1]);
    expect(generate.mock.calls[0][0].roundedCorners).toBe(false);
    expect(generate.mock.calls[0][0].mode).toBe("edge-extension");
    expect(result.bleedDiagnostics.map((diagnostic) => diagnostic.resolvedMode)).toEqual(Array(3).fill("edge-extension"));
    expect(result.bleedDiagnostics[2]).toMatchObject({
      requestedMode: "auto",
      resolvedMode: "edge-extension",
      policyId: "edge-extension-v1",
      algorithmVersion: "edge-extension-v1",
    });
  });

  it("returns per-side policy diagnostics for the exact bleed results consumed by PDF export", async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 127, height: 178, channels: 3, background: { r: 42, g: 92, b: 142 } } }).png().toBuffer());
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const candidates: Record<string, ArtworkCandidate> = {
      "scryfall:diagnostic": { id: "scryfall:diagnostic", source: "scryfall", identityId: null, faceId: "front", originalAvailable: true },
      "upload:diagnostic": { id: "upload:diagnostic", source: "upload", identityId: null, faceId: "front", originalAvailable: true },
      "mpc:diagnostic": { id: "mpc:diagnostic", source: "mpc", identityId: null, faceId: "front", originalAvailable: true },
    };
    const catalog = {
      getArtworkCandidate: async (id: string) => candidates[id],
      getArtworkOriginal: async (id: string) => ({
        artworkId: id,
        contentHash,
        format: "png",
        extension: "png",
        byteLength: bytes.byteLength,
        widthPx: 127,
        heightPx: 178,
        provenance: [],
        createdAt: "2026-09-26T00:00:00.000Z",
        bytes,
      }),
    };
    const card = (id: string, source: "scryfall" | "upload" | "mpc", order: number): WorkingCard => ({
      id,
      quantity: 1,
      order,
      importSource: { sourceId: id, importKind: "synthetic", entryKind: "card" },
      identityHints: {},
      identity: null,
      identityResolution: { status: "unresolved", candidates: [], confirmed: false },
      faces: [{ id: `${id}-front`, side: "front" }],
      selectedArtworkByFace: { front: { candidateId: `${source}:diagnostic`, source, identityId: null, faceId: "front" } },
      backMode: "project-default" as const,
      backModeSelectionPolicy: "automatic" as const,
      localArtworkIds: [],
      mpcReferences: [],
      faceAssociations: [],
    });
    const bleedGenerate = vi.spyOn(BleedEngine.prototype, "generate");
    const pdfGenerate = vi.spyOn(LosslessPdfEngine.prototype, "generate");

    const result = await exportWorkingCardsWithDiagnostics(catalog, [
      card("scryfall-diagnostic", "scryfall", 0),
      card("upload-diagnostic", "upload", 1),
      card("mpc-diagnostic", "mpc", 2),
    ], { bleedMm: 1, cutGuides: NO_CUT_GUIDES, roundedCorners: true });

    expect(result.pdfBytes).toBeInstanceOf(Uint8Array);
    expect(result.bleedDiagnostics).toHaveLength(3);
    expect(result.bleedDiagnostics[0]).toMatchObject({
      workingCardId: "scryfall-diagnostic",
      source: "scryfall",
      requestedMode: "auto",
      resolvedMode: "edge-extension",
      effectiveMode: "edge-extension",
      algorithmVersion: "edge-extension-v1",
      roundedCorners: true,
      cornerRadiusMm: 3.175,
      sideDiagnostics: { top: { strategy: "nearest-edge-pixel" } },
    });
    expect(result.bleedDiagnostics[1]).toMatchObject({ source: "upload", resolvedMode: "edge-extension", effectiveMode: "edge-extension" });
    expect(result.bleedDiagnostics[2]).toMatchObject({
      source: "mpc",
      resolvedMode: "edge-extension",
      effectiveMode: "edge-extension",
    });
    const pdfBleeds = pdfGenerate.mock.calls[0][0].bleedResults!;
    const generatedBleeds = await Promise.all(bleedGenerate.mock.results.map((result) => result.value));
    expect(pdfBleeds).toHaveLength(3);
    expect(generatedBleeds).toHaveLength(1);
    expect(generatedBleeds[0].roundedCorners).toBe(true);
    for (const [index, bleed] of pdfBleeds.entries()) {
      expect(bleed).toBeDefined();
      expect(bleed).toBe(generatedBleeds[0]);
      expect(bleed!.preview.bytes).toBe(generatedBleeds[0].preview.bytes);
      expect(createHash("sha256").update(bleed!.preview.bytes).digest("hex")).toBe(result.bleedDiagnostics[index].previewSha256);
    }
  });

  it("exports cached originals offline and composes 9/10 physical copies through existing A4 engines", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcgprint-export-"));
    roots.push(root);
    const original = new Uint8Array(await sharp({ create: { width: 1500, height: 2100, channels: 3, background: { r: 56, g: 83, b: 126 } } }).png().toBuffer());
    const requests: Array<{ url: URL; headers: Headers }> = [];
    let providerOffline = false;
    const fakeFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (providerOffline) throw new Error("offline");
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      requests.push({ url, headers });
      if (url.hostname === "api.scryfall.com" && url.pathname === "/cards/named") return Response.json(normal);
      if (url.hostname === "api.scryfall.com" && url.pathname === "/cards/search") return Response.json({ object: "list", data: [normal], has_more: false });
      if (url.hostname === "cards.scryfall.io") return new Response(original, { headers: { "Content-Type": "image/png" } });
      return new Response("Not found", { status: 404 });
    });
    const workbench = await createCardWorkbench({ dataDirectory: root, fetchImpl: fakeFetch as typeof fetch, minIntervalMs: 0 });
    workbenches.push(workbench);

    const imported = await workbench.importForWorkingSet({ text: "Mainboard\n9 Sol Ring" });
    expect(imported.workingCards).toHaveLength(1);
    expect(imported.workingCards[0]).toMatchObject({ quantity: 9, section: "Mainboard", identity: null });
    const resolved = await workbench.resolveWorkingCards(imported.workingCards);
    const selected = resolved.workingCards[0];
    expect(selected).toMatchObject({ quantity: 9, identity: { name: "Sol Ring", scryfallId: normal.id }, selectedArtworkByFace: { front: { source: "scryfall", candidateId: `scryfall:${normal.id}:front` } } });
    const candidateId = selected.selectedArtworkByFace.front!.candidateId;
    await expect(workbench.getArtworkPreview(candidateId)).resolves.toMatchObject({ source: "scryfall", widthPx: 300 });
    await expect(workbench.getArtworkOriginal(candidateId)).resolves.toMatchObject({ bytes: original });
    const requestsBeforeOfflineExport = requests.length;
    providerOffline = true;

    const exportWithQuantity = async (quantity: number) => handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: [{ ...selected, quantity }], options: { bleedMm: 0.625, cutGuides: FULL_TRIM_GUIDES } }),
    }), workbench);
    const nine = await exportWithQuantity(9);
    expect(nine.status).toBe(200);
    const ninePdf = await PDFDocument.load(await nine.arrayBuffer());
    expect(ninePdf.getPages()).toHaveLength(1);
    expect(ninePdf.getPages()[0].getMediaBox().width).toBeCloseTo(PAPER_FORMATS.A4.widthMm * 72 / 25.4, 6);
    expect(ninePdf.getPages()[0].getMediaBox().height).toBeCloseTo(PAPER_FORMATS.A4.heightMm * 72 / 25.4, 6);

    const ten = await exportWithQuantity(10);
    expect(ten.status).toBe(200);
    const tenPdf = await PDFDocument.load(await ten.arrayBuffer());
    expect(tenPdf.getPages()).toHaveLength(2);
    expect(selected.quantity).toBe(9);
    expect(workbench.getProviderHealth().scryfall).toMatchObject({ available: true, degraded: false });
    expect(requests).toHaveLength(requestsBeforeOfflineExport);
    expect(requests.every(({ headers }) => headers.get("user-agent")?.startsWith("TCGPrint/") && Boolean(headers.get("accept")))).toBe(true);
    expect(requests.filter(({ url }) => url.pathname.endsWith("/png/front/a/a/aaaa.png")).length).toBe(1);
    expect(requests.find(({ url }) => url.pathname.endsWith("/png/front/a/a/aaaa.png"))?.headers.get("accept")).toBe("image/*");
    expect(requests.find(({ url }) => url.pathname.endsWith("/small/front/a/a/aaaa.jpg"))?.headers.get("accept")).toBe("image/*");
    expect(Buffer.from(await readFile(join(root, ".tcgprint", "artwork-cache.sqlite"))).byteLength).toBeGreaterThan(0);
  }, 30_000);

  it("keeps a local JPEG byte-for-byte as the PDF DCT stream on the Phase 5 export route", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcgprint-jpeg-export-"));
    roots.push(root);
    const workbench = await createCardWorkbench({ dataDirectory: root, minIntervalMs: 0 });
    workbenches.push(workbench);
    const jpeg = new Uint8Array(await readFile(join(process.cwd(), "tests", "fixtures", "pdf", "synthetic-gradient.jpg")));
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "original.jpg", bytes: jpeg }] });
    const generateBleed = vi.spyOn(BleedEngine.prototype, "generate");
    const response = await handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: imported.workingCards, options: { bleedMm: 0.625, cutGuides: FULL_TRIM_GUIDES, cardOrientation: "landscape" } }),
    }), workbench);
    expect(response.status).toBe(200);
    expect(generateBleed.mock.calls[0]?.[0].trimSizeMm).toEqual({ widthMm: 63.5, heightMm: 88.9 });
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    const dct = [...pdf.context.enumerateIndirectObjects()].map(([, object]) => object).find((object): object is PDFRawStream =>
      object instanceof PDFRawStream && object.dict.get(PDFName.of("Filter"))?.toString() === "/DCTDecode",
    );
    expect(dct).toBeDefined();
    expect(Buffer.from(dct!.contents)).toEqual(Buffer.from(jpeg));
  }, 20_000);

  it("rejects a reference-only MPC selection without asking for an original", async () => {
    const reference = {
      id: `mpc:${"b".repeat(64)}`,
      source: "mpc" as const,
      identityId: null,
      faceId: "front" as const,
      originalAvailable: false,
      metadata: { referenceOnly: true },
    };
    const card = {
      id: "stable-working-card",
      quantity: 1,
      order: 0,
      importSource: { sourceId: "mpc:1", importKind: "mpc", entryKind: "asset" },
      identityHints: {},
      identity: null,
      identityResolution: { status: "unresolved" as const, candidates: [], confirmed: false },
      faces: [{ id: "front", side: "front" as const }],
      selectedArtworkByFace: { front: { candidateId: reference.id, source: "mpc" as const, identityId: null, faceId: "front" as const } },
      backMode: "project-default" as const,
      backModeSelectionPolicy: "automatic" as const,
      localArtworkIds: [],
      mpcReferences: [],
      faceAssociations: [],
    };
    const catalog = {
      getArtworkCandidate: vi.fn(async () => reference),
      getArtworkOriginal: vi.fn(),
    };

    await expect(exportWorkingCards(catalog, [card], { bleedMm: 0, cutGuides: NO_CUT_GUIDES })).rejects.toMatchObject({ code: "ARTWORK_ORIGINAL_UNAVAILABLE" });
    expect(catalog.getArtworkOriginal).not.toHaveBeenCalled();
  });

  it("exports edited order, keeps quantity compact until composition, and includes/removes duplicated entries", async () => {
    const names = ["A", "B", "C", "B-back", "B-after"] as const;
    const bytesByName = new Map<string, Uint8Array>();
    const candidates: Record<string, ArtworkCandidate> = {};
    for (const [index, name] of names.entries()) {
      const bytes = new Uint8Array(await sharp({ create: { width: 24, height: 36, channels: 3, background: { r: index * 70, g: 30, b: 180 - index * 50 } } }).png().toBuffer());
      bytesByName.set(name, bytes);
      candidates[`scryfall:${name}`] = { id: `scryfall:${name}`, source: "scryfall", identityId: null, faceId: "front", originalAvailable: true };
    }
    const nameByBytes = new Map([...bytesByName].map(([name, bytes]) => [Buffer.from(bytes).toString("base64"), name]));
    const catalog = {
      getArtworkCandidate: vi.fn(async (id: string) => candidates[id]),
      getArtworkOriginal: vi.fn(async (id: string) => {
        const name = id.replace("scryfall:", "");
        const bytes = bytesByName.get(name)!;
        return { artworkId: id, contentHash: createHash("sha256").update(bytes).digest("hex"), format: "png" as const, extension: "png", byteLength: bytes.byteLength, widthPx: 24, heightPx: 36, provenance: [], createdAt: "2026-09-27T00:00:00.000Z", bytes };
      }),
    };
    const card = (name: string, order: number, quantity: number): WorkingCard => ({
      id: `working-${name}`,
      quantity,
      order,
      importSource: { sourceId: `source-${name}`, importKind: "text", entryKind: "deck-card" },
      identityHints: { name },
      identity: null,
      identityResolution: { status: "unresolved", candidates: [], confirmed: false },
      faces: name === "B" ? [{ id: "front", side: "front" }, { id: "back", side: "back" }] : [{ id: "front", side: "front" }],
      selectedArtworkByFace: {
        front: { candidateId: `scryfall:${name}`, source: "scryfall", identityId: null, faceId: "front" },
        ...(name === "B" ? { back: { candidateId: "scryfall:B-back", source: "scryfall" as const, identityId: null, faceId: "back" as const } } : {}),
      },
      backMode: name === "B" ? "auto" : "project-default",
      backModeSelectionPolicy: "automatic",
      localArtworkIds: [],
      mpcReferences: [],
      faceAssociations: [],
    });
    const pdfGenerate = vi.spyOn(LosslessPdfEngine.prototype, "generate").mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    const initial = createWorkingCardEditorState([card("A", 0, 2), card("B", 1, 1), card("C", 2, 1)]);
    const reordered = moveWorkingCard(initial, "working-C", 0);

    expect(reordered.cards.map(({ id, quantity, order }) => [id, quantity, order])).toEqual([
      ["working-C", 1, 0], ["working-A", 2, 1], ["working-B", 1, 2],
    ]);
    await exportWorkingCardsWithDiagnostics(catalog, reordered.cards, { bleedMm: 0, cutGuides: NO_CUT_GUIDES });
    const exportedNames = (images: readonly Uint8Array[]) => images.map((bytes) => nameByBytes.get(Buffer.from(bytes).toString("base64")));
    expect(exportedNames(pdfGenerate.mock.calls[0][0].images)).toEqual(["C", "A", "A", "B"]);
    expect(pdfGenerate.mock.calls[0][0].cutGuides).toEqual(NO_CUT_GUIDES);

    const duplicated = duplicateWorkingCard(reordered, "working-A", "working-A-copy");
    const deleted = deleteWorkingCard(duplicated, "working-B");
    await exportWorkingCardsWithDiagnostics(catalog, deleted.cards, { bleedMm: 0, cutGuides: NO_CUT_GUIDES });
    expect(exportedNames(pdfGenerate.mock.calls[1][0].images)).toEqual(["C", "A", "A", "A", "A"]);
    expect(catalog.getArtworkCandidate.mock.calls.slice(3).map(([id]) => id)).toEqual([
      "scryfall:C", "scryfall:A",
    ]);

    const dfc = createWorkingCardEditorState([card("B", 0, 1)]);
    const duplicatedDfc = duplicateWorkingCard(dfc, "working-B", "working-B-copy");
    const reorderedDfc = moveWorkingCard(duplicatedDfc, "working-B-copy", 0);
    const dfcClone = reorderedDfc.cards.find(({ id }) => id === "working-B-copy")!;
    expect(dfcClone.selectedArtworkByFace).toEqual(dfc.cards[0].selectedArtworkByFace);
    expect(dfcClone.selectedArtworkByFace.back?.candidateId).toBe("scryfall:B-back");
    await exportWorkingCardsWithDiagnostics(catalog, reorderedDfc.cards, { bleedMm: 0, cutGuides: NO_CUT_GUIDES });
    expect(exportedNames(pdfGenerate.mock.calls[2][0].images)).toEqual(["B", "B"]);
    expect(catalog.getArtworkCandidate.mock.calls.slice(5).map(([id]) => id)).toEqual([
      "scryfall:B",
    ]);

    let history = commitEditorHistory(
      createEditorHistoryState({ ...initial, face: "front" }),
      { ...reordered, face: "front" },
    );
    const quantityUpdated = setWorkingCardQuantity({
      cards: history.present.cards,
      selectedCardId: history.present.selectedCardId,
    }, "working-A", 3);
    history = commitEditorHistory(history, { ...quantityUpdated, face: history.present.face });
    const artworkUpdated = history.present.cards.map((item) => item.id === "working-B"
      ? {
        ...item,
        selectedArtworkByFace: {
          ...item.selectedArtworkByFace,
          front: { ...item.selectedArtworkByFace.front!, candidateId: "scryfall:B-after" },
        },
      }
      : item);
    history = commitEditorHistory(history, { ...history.present, cards: artworkUpdated });

    history = undoEditorHistory(undoEditorHistory(undoEditorHistory(history)));
    expect(history.present.cards.map(({ id, quantity, order }) => [id, quantity, order])).toEqual([
      ["working-A", 2, 0], ["working-B", 1, 1], ["working-C", 1, 2],
    ]);
    expect(history.present.cards[1].selectedArtworkByFace.front?.candidateId).toBe("scryfall:B");
    await exportWorkingCardsWithDiagnostics(catalog, history.present.cards, { bleedMm: 0, cutGuides: NO_CUT_GUIDES });
    expect(exportedNames(pdfGenerate.mock.calls[3][0].images)).toEqual(["A", "A", "B", "C"]);

    history = redoEditorHistory(redoEditorHistory(redoEditorHistory(history)));
    expect(history.present.cards.map(({ id, quantity, order }) => [id, quantity, order])).toEqual([
      ["working-C", 1, 0], ["working-A", 3, 1], ["working-B", 1, 2],
    ]);
    expect(history.present.cards[2].selectedArtworkByFace.front?.candidateId).toBe("scryfall:B-after");
    await exportWorkingCardsWithDiagnostics(catalog, history.present.cards, { bleedMm: 0, cutGuides: NO_CUT_GUIDES });
    expect(exportedNames(pdfGenerate.mock.calls[4][0].images)).toEqual(["C", "A", "A", "A", "B-after"]);
  });
});
