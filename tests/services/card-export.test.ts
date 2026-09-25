import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import normal from "../fixtures/scryfall/normal-card.json";
import { createCardWorkbench } from "../../services/card-workbench";
import { handleCardExport } from "../../services/card-api";
import { exportWorkingCards } from "../../services/card-export";
import { PAPER_FORMATS } from "../../core/geometry";

const roots: string[] = [];
const workbenches: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const workbench of workbenches.splice(0)) await workbench.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("decklist → identity → Scryfall artwork → PDF", () => {
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
