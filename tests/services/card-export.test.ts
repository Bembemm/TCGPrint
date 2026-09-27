import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import normal from "../fixtures/scryfall/normal-card.json";
import { createCardWorkbench } from "../../services/card-workbench";
import { handleCardExport } from "../../services/card-api";
import { exportWorkingCards, exportWorkingCardsWithDiagnostics } from "../../services/card-export";
import { PAPER_FORMATS } from "../../core/geometry";
import { BleedEngine } from "../../image-engine/bleed";
import { LosslessPdfEngine } from "../../pdf-engine/document";
import type { ArtworkCandidate, WorkingCard } from "../../core/cards/types";

const roots: string[] = [];
const workbenches: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const workbench of workbenches.splice(0)) await workbench.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("decklist → identity → Scryfall artwork → PDF", () => {
  it("does not de-duplicate identical bytes at the same bleed when effective modes differ", async () => {
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
      cutGuides: "none",
      bleedMode: "auto",
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls.map(([request]) => request.imageBytes)).toEqual([bytes, bytes]);
    expect(generate.mock.calls.map(([request]) => request.bleedMm)).toEqual([1, 1]);
    expect(generate.mock.calls.map(([request]) => request.mode)).toEqual(["smart-border-fill", "subtle-edge-stretch"]);
    expect(result.bleedDiagnostics[2]).toMatchObject({
      requestedMode: "auto",
      resolvedMode: "subtle-edge-stretch",
      policyId: "scryfall-full-art-auto-subtle-v1",
      algorithmVersion: "reflected-corners-v2-smart-border-fill-v3",
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
    ], { bleedMm: 1, cutGuides: "none", bleedMode: "auto" });

    expect(result.pdfBytes).toBeInstanceOf(Uint8Array);
    expect(result.bleedDiagnostics).toHaveLength(3);
    expect(result.bleedDiagnostics[0]).toMatchObject({
      workingCardId: "scryfall-diagnostic",
      source: "scryfall",
      requestedMode: "auto",
      resolvedMode: "smart-border-fill",
      effectiveMode: "subtle-edge-stretch",
      algorithmVersion: expect.any(String),
      sideDiagnostics: { top: expect.objectContaining({ effectiveMode: "subtle-edge-stretch", fallbackReason: "outer-band-not-dark-uniform" }) },
    });
    expect(result.bleedDiagnostics[1]).toMatchObject({ source: "upload", resolvedMode: "subtle-edge-stretch", effectiveMode: "subtle-edge-stretch" });
    expect(result.bleedDiagnostics[2]).toMatchObject({
      source: "mpc",
      policyNotice: "MPC_BLEED_METADATA_UNKNOWN",
      resolvedMode: "subtle-edge-stretch",
      effectiveMode: "subtle-edge-stretch",
    });
    const pdfBleeds = pdfGenerate.mock.calls[0][0].bleedResults!;
    const generatedBleeds = await Promise.all(bleedGenerate.mock.results.map((result) => result.value));
    expect(pdfBleeds).toHaveLength(3);
    expect(generatedBleeds).toHaveLength(2);
    for (const [index, bleed] of pdfBleeds.entries()) {
      const generatedIndex = index === 2 ? 1 : index;
      expect(bleed).toBeDefined();
      expect(bleed).toBe(generatedBleeds[generatedIndex]);
      expect(bleed!.preview.bytes).toBe(generatedBleeds[generatedIndex].preview.bytes);
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
      body: JSON.stringify({ cards: [{ ...selected, quantity }], options: { bleedMm: 0.625, cutGuides: "full" } }),
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
    const response = await handleCardExport(new Request("http://localhost/api/cards/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: imported.workingCards, options: { bleedMm: 0.625, cutGuides: "full" } }),
    }), workbench);
    expect(response.status).toBe(200);
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
      localArtworkIds: [],
      mpcReferences: [],
      faceAssociations: [],
    };
    const catalog = {
      getArtworkCandidate: vi.fn(async () => reference),
      getArtworkOriginal: vi.fn(),
    };

    await expect(exportWorkingCards(catalog, [card], { bleedMm: 0, cutGuides: "none" })).rejects.toMatchObject({ code: "ARTWORK_ORIGINAL_UNAVAILABLE" });
    expect(catalog.getArtworkOriginal).not.toHaveBeenCalled();
  });
});
