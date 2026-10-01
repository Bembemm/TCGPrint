import { createHash } from "node:crypto";
import { PDFDocument } from "@pdfme/pdf-lib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { ArtworkCandidate, BackLibraryAssetReference, WorkingCard } from "../../core/cards/types";
import { exportWorkingCardsByContentMode } from "../../services/card-export";
import type { CardWorkbench } from "../../services/card-workbench";
import { NO_CUT_GUIDES } from "../helpers/cut-guides";

async function png(color: string) {
  return new Uint8Array(await sharp({ create: { width: 42, height: 63, channels: 3, background: color } }).png().toBuffer());
}

function candidate(id: string, identityId: string | null = null, faceId: "front" | "back" = "front"): ArtworkCandidate {
  return { id, source: "upload", identityId, faceId, originalAvailable: true };
}

function original(id: string, bytes: Uint8Array) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { artworkId: sha256, contentHash: sha256, format: "png" as const, extension: "png", byteLength: bytes.byteLength, widthPx: 42, heightPx: 63, provenance: [], createdAt: "2026-01-01T00:00:00.000Z", bytes, id };
}

function card(id: string, order: number, quantity: number, opts: { dfc?: boolean; back?: string; mode?: WorkingCard["backMode"] } = {}): WorkingCard {
  const identityId = opts.dfc ? `scryfall:oracle:${id}` : null;
  return {
    id,
    quantity,
    order,
    importSource: { sourceId: `source:${id}`, importKind: "fixture", entryKind: "card" },
    identityHints: { name: id },
    identity: opts.dfc ? {
      id: identityId!, provider: "scryfall", name: `${id} // ${id} back`, resolutionMethod: "manual", confidence: 1,
      metadata: { layout: "transform", faces: [{ name: id }, { name: `${id} back` }] },
    } : null,
    identityResolution: { status: opts.dfc ? "resolved" : "unresolved", candidates: [], confirmed: opts.dfc === true },
    faces: opts.dfc
      ? [{ id: "front", side: "front", name: id }, { id: "back", side: "back", name: `${id} back` }]
      : [{ id: "front", side: "front", name: id }],
    selectedArtworkByFace: {
      front: { candidateId: `upload:${id}-front`, source: "upload", identityId, faceId: "front" },
      ...(opts.back ? { back: { candidateId: opts.back, source: "upload" as const, identityId, faceId: "back" as const } } : {}),
    },
    backMode: opts.mode ?? (opts.dfc ? "auto" : "project-default"),
    backModeSelectionPolicy: "automatic",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  };
}

describe("duplex export modes", () => {
  const projectCards = [card("A", 0, 2), card("B", 1, 1, { dfc: true, back: "upload:B-back" })];

  async function fixture() {
    const defaultBytes = await png("#e0c020");
    const manualBytes = await png("#8830c0");
    const defaultHash = createHash("sha256").update(defaultBytes).digest("hex");
    const manualHash = createHash("sha256").update(manualBytes).digest("hex");
    const defaultBack: BackLibraryAssetReference = { assetId: `back:${defaultHash}`, sha256: defaultHash, format: "png" };
    const manualBack: BackLibraryAssetReference = { assetId: `back:${manualHash}`, sha256: manualHash, format: "png" };
    const sources = new Map([
      ["upload:A-front", original("upload:A-front", await png("#d03030"))],
      ["upload:B-front", original("upload:B-front", await png("#20b060"))],
      ["upload:B-back", original("upload:B-back", await png("#2050d0"))],
      [defaultBack.assetId, original("project-default", defaultBytes)],
      [manualBack.assetId, original("manual-back", manualBytes)],
    ]);
    const candidateMap = new Map<string, ArtworkCandidate>([
      ["upload:A-front", candidate("upload:A-front")],
      ["upload:B-front", candidate("upload:B-front", "scryfall:oracle:B")],
      ["upload:B-back", candidate("upload:B-back", "scryfall:oracle:B", "back")],
    ]);
    const getArtworkCandidate = vi.fn(async (id: string) => candidateMap.get(id));
    const getArtworkOriginal = vi.fn(async (id: string) => {
      const item = sources.get(id);
      if (!item) throw new Error(`missing fixture ${id}`);
      return item;
    });
    const catalog = { getArtworkCandidate, getArtworkOriginal } as unknown as Pick<CardWorkbench, "getArtworkCandidate" | "getArtworkOriginal">;
    const backLibrary = {
      resolveOriginal: vi.fn(async (reference: BackLibraryAssetReference) => {
        const item = sources.get(reference.assetId);
        if (!item) throw new Error("missing back fixture");
        return item;
      }),
    };
    return { catalog, backLibrary, getArtworkCandidate, getArtworkOriginal, defaultBack, manualBack };
  }

  const options = (exportContentMode: "front-only" | "back-only" | "front-back-separated" | "duplex", extra: Record<string, unknown> = {}) => ({
    bleedMm: 0,
    cutGuides: NO_CUT_GUIDES,
    pageOrientation: "portrait" as const,
    cardOrientation: "portrait" as const,
    layoutRows: 1,
    layoutColumns: 2,
    exportContentMode,
    duplexFlipMode: "long-edge" as const,
    missingBackPolicy: "use-project-default" as const,
    projectDefaultBack: null,
    projectRevision: 17,
    ...extra,
  });

  it("keeps front-only output as a PDF and reports physical-copy counts without resolving backs", async () => {
    const { catalog, backLibrary } = await fixture();
    const before = structuredClone(projectCards);
    const result = await exportWorkingCardsByContentMode(catalog, backLibrary, projectCards, options("front-only"));

    expect(result.pdfBytes).toBeInstanceOf(Uint8Array);
    expect((await PDFDocument.load(result.pdfBytes!)).getPages()).toHaveLength(2);
    expect(result.preflight).toMatchObject({ totalPhysicalCards: 3, dfcPhysicalCards: 1, simplePhysicalCards: 2 });
    expect(backLibrary.resolveOriginal).not.toHaveBeenCalled();
    expect(projectCards).toEqual(before);
  });

  it("exports back-only using paired page geometry and preserves independent quantity associations", async () => {
    const { catalog, backLibrary, defaultBack } = await fixture();
    const before = structuredClone(projectCards);
    const result = await exportWorkingCardsByContentMode(catalog, backLibrary, projectCards, options("back-only", { projectDefaultBack: defaultBack }));

    expect((await PDFDocument.load(result.pdfBytes!)).getPages()).toHaveLength(2);
    expect(result.pagePairingPlan?.pagePairs.map(({ frontPageNumber, backPageNumber, slots }) => ({
      frontPageNumber,
      backPageNumber,
      copies: slots.filter(({ physicalCardIndex }) => physicalCardIndex !== undefined).map(({ physicalCardIndex }) => physicalCardIndex),
    }))).toEqual([{ frontPageNumber: 1, backPageNumber: 1, copies: [0, 1] }, { frontPageNumber: 2, backPageNumber: 2, copies: [2] }]);
    expect(result.preflight?.backs).toMatchObject({ auto: 1, projectDefault: 2, manual: 0, noneOrMissing: 0 });
    expect(projectCards).toEqual(before);
  });

  it("returns two independent PDFs plus deterministic pairing metadata for separate mode", async () => {
    const { catalog, backLibrary, defaultBack } = await fixture();
    const result = await exportWorkingCardsByContentMode(catalog, backLibrary, projectCards, options("front-back-separated", { projectDefaultBack: defaultBack }));

    expect((await PDFDocument.load(result.frontPdfBytes!)).getPages()).toHaveLength(2);
    expect((await PDFDocument.load(result.backPdfBytes!)).getPages()).toHaveLength(2);
    expect(result.manifest).toMatchObject({
      projectRevision: 17,
      pageOrientation: "portrait",
      flipMode: "long-edge",
      frontPdf: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), pageCount: 2 },
      backPdf: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), pageCount: 2 },
      pagePairs: [
        { frontPageNumber: 1, backPageNumber: 1, physicalSlotReflectionAxis: "x", registrationReflectionAxis: "x", backArtworkRotationDegrees: 0 },
        { frontPageNumber: 2, backPageNumber: 2, physicalSlotReflectionAxis: "x", registrationReflectionAxis: "x", backArtworkRotationDegrees: 0 },
      ],
    });
  });

  it("records the PDF engine's inferred card orientation when a non-Project caller omits it", async () => {
    const { catalog, backLibrary, defaultBack } = await fixture();
    const result = await exportWorkingCardsByContentMode(catalog, backLibrary, [projectCards[0]!], options("front-back-separated", {
      projectDefaultBack: defaultBack,
      cardOrientation: undefined,
      cardFormat: { id: "landscape-fixture", name: "Landscape fixture", widthMm: 30, heightMm: 20 },
    }));

    expect(result.manifest?.cardOrientation).toBe("landscape");
  });

  it("interleaves front 1, back 1, front 2, back 2 in duplex mode", async () => {
    const { catalog, backLibrary, defaultBack } = await fixture();
    const result = await exportWorkingCardsByContentMode(catalog, backLibrary, projectCards, options("duplex", { projectDefaultBack: defaultBack }));

    expect((await PDFDocument.load(result.pdfBytes!)).getPages()).toHaveLength(4);
    expect(result.pageOrder).toEqual(["front:1", "back:1", "front:2", "back:2"]);
    expect(result.preflight?.projectRevision).toBe(17);
  });

  it.each(["blank", "warn-and-continue"] as const)("leaves a missing back slot blank without shifting later copies under %s policy", async (missingBackPolicy) => {
    const { catalog, backLibrary } = await fixture();
    const cards = [card("missing", 0, 1, { mode: "none" }), card("B", 1, 1, { dfc: true, back: "upload:B-back" })];
    const result = await exportWorkingCardsByContentMode(catalog, backLibrary, cards, options("back-only", { projectDefaultBack: null, missingBackPolicy }));

    const pdf = await PDFDocument.load(result.pdfBytes!);
    expect(pdf.getPages()).toHaveLength(1);
    expect(result.preflight?.backs.noneOrMissing).toBe(1);
    expect(result.preflight?.missing[0]).toMatchObject({ cardId: "missing", physicalCardIndex: 0 });
    expect(result.preflight?.warnings.length).toBe(missingBackPolicy === "warn-and-continue" ? 1 : 0);
    const pair = result.pagePairingPlan!.pagePairs[0]!;
    expect(pair.slots.find(({ physicalCardIndex }) => physicalCardIndex === 1)?.backSlotIndex).toBe(0);
  });

  it("keeps an explicit none mode blank even when a Project default exists", async () => {
    const { catalog, backLibrary, defaultBack } = await fixture();
    const result = await exportWorkingCardsByContentMode(catalog, backLibrary, [card("intentional-blank", 0, 1, { mode: "none" })], options("back-only", {
      projectDefaultBack: defaultBack,
      missingBackPolicy: "use-project-default",
    }));
    const pdf = await PDFDocument.load(result.pdfBytes!);

    expect(pdf.getPages()).toHaveLength(1);
    expect(result.preflight?.backs.noneOrMissing).toBe(1);
    expect(backLibrary.resolveOriginal).not.toHaveBeenCalled();
  });

  it("blocks before PDF generation when missing-back policy blocks", async () => {
    const { catalog, backLibrary } = await fixture();
    const generate = vi.spyOn((await import("../../pdf-engine/document")).LosslessPdfEngine.prototype, "generate");

    await expect(exportWorkingCardsByContentMode(catalog, backLibrary, [card("missing", 0, 1, { mode: "none" })], options("duplex", {
      projectDefaultBack: null,
      missingBackPolicy: "block",
    }))).rejects.toMatchObject({ code: "BACK_REQUIRED" });

    expect(generate).not.toHaveBeenCalled();
  });

  it("uses a configured default for missing/automatic backs and leaves manual overrides bound to their own asset", async () => {
    const { catalog, backLibrary, defaultBack, manualBack } = await fixture();
    const manualCard = { ...card("manual", 0, 1, { mode: "manual" }), manualBackAsset: manualBack, backModeSelectionPolicy: "explicit" as const };
    const result = await exportWorkingCardsByContentMode(catalog, backLibrary, [manualCard], options("back-only", { projectDefaultBack: defaultBack }));

    expect(backLibrary.resolveOriginal).toHaveBeenCalledWith(manualBack);
    expect(result.preflight?.backs.manual).toBe(1);
  });

  it("does not substitute a generic Project back for a known DFC with unresolved auto face", async () => {
    const { catalog, backLibrary, defaultBack } = await fixture();
    const missingDfc = card("missing-dfc", 0, 1, { dfc: true });
    const result = await exportWorkingCardsByContentMode(catalog, backLibrary, [missingDfc], options("back-only", {
      projectDefaultBack: defaultBack,
      missingBackPolicy: "use-project-default",
    }));
    const pdf = await PDFDocument.load(result.pdfBytes!);

    expect(pdf.getPages()).toHaveLength(1);
    expect(result.preflight).toMatchObject({
      backs: { auto: 1, projectDefault: 0, manual: 0, noneOrMissing: 0 },
      missing: [{ cardId: "missing-dfc", backMode: "auto" }],
      warnings: [{ cardId: "missing-dfc", backMode: "auto" }],
    });
    expect(backLibrary.resolveOriginal).not.toHaveBeenCalled();
  });

  it("blocks a known DFC without its own back even when a generic Project default exists", async () => {
    const { catalog, backLibrary, defaultBack } = await fixture();
    let caught: unknown;
    try {
      await exportWorkingCardsByContentMode(catalog, backLibrary, [card("blocked-dfc", 0, 1, { dfc: true })], options("duplex", {
        projectDefaultBack: defaultBack,
        missingBackPolicy: "block",
      }));
    } catch (error) { caught = error; }

    expect(caught).toMatchObject({ code: "BACK_REQUIRED" });
    expect((caught as Error & { cause?: { missing?: readonly { cardId: string; reason: string }[] } }).cause?.missing).toEqual([
      expect.objectContaining({ cardId: "blocked-dfc", reason: expect.stringContaining("provider-backed back face is unresolved") }),
    ]);
    expect(backLibrary.resolveOriginal).not.toHaveBeenCalled();
  });

  it("rejects duplicate logical card IDs before back resolution can cross-associate copies", async () => {
    const duplicate = card("same-id", 0, 1);
    await expect(exportWorkingCardsByContentMode({} as Pick<CardWorkbench, "getArtworkCandidate" | "getArtworkOriginal">, undefined, [
      duplicate,
      { ...duplicate, order: 1, backMode: "manual", selectedArtworkByFace: { ...duplicate.selectedArtworkByFace, back: { candidateId: "other-back", source: "upload", identityId: null, faceId: "back" } } },
    ], options("back-only"))).rejects.toMatchObject({ code: "INVALID_CARD_ID" });
  });
});
