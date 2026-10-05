import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFRawStream } from "@pdfme/pdf-lib";
import { describe, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useReducer: vi.fn(actual.useReducer), useState: vi.fn(actual.useState) };
});

import type { ArtworkCandidate, CardIdentity, WorkingCard } from "../../core/cards/types";
import { createWorkingSet } from "../../core/cards/working-set";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS } from "../../core/geometry";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import { importFiles } from "../../import-engine";
import { BleedEngine, MemoryBleedCache, type BleedResult } from "../../image-engine/bleed";
import { toImportPreview } from "../../import-engine/preview";
import { ArtworkCatalog } from "../../artwork/catalog";
import type { ArtworkProvider } from "../../artwork/types";
import { exportWorkingCardsWithDiagnostics } from "../../services/card-export";
import { LosslessPdfEngine } from "../../pdf-engine/document";
import { readPdfRasterCacheDiagnostics } from "../../pdf-engine/document/raster-resource-policy";
import CardIdentityWorkbench, { editorHistoryReducer, WorkingCardList } from "../../src/app/card-identity-workbench";
import ProjectsPanel from "../../src/app/projects-panel";
import { createEditorHistoryState } from "../../core/cards/editor-history";
import { createPhysicalOrder } from "../../core/cards/physical-instance-order";
import { projectSaveStateValue, projectSessionReducer, projectSnapshotDocument, createProjectSessionState } from "../../src/app/project-session";
import type { ProjectDto } from "../../services/project-api";

interface Metric {
  readonly name: string;
  readonly count?: number;
  readonly wallTimeMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly rssBeforeBytes: number;
  readonly rssPeakSampledBytes: number;
  readonly rssAfterBytes: number;
  readonly heapBeforeBytes: number;
  readonly heapPeakSampledBytes: number;
  readonly heapAfterBytes: number;
  readonly peakEventLoopDelayMs: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

const profileEnabled = process.env.PHASE15_PROFILE === "1";

function decklist(count: number): string {
  return Array.from({ length: count }, (_, index) => `1 Synthetic Card ${String(index + 1).padStart(4, "0")}`).join("\n");
}

function selectedCard(id: string, order: number, candidateId: string): WorkingCard {
  return {
    id,
    quantity: 1,
    order,
    importSource: { sourceId: `synthetic:${id}`, importKind: "synthetic", entryKind: "card" },
    identityHints: { name: `Synthetic Card ${String(order + 1).padStart(4, "0")}` },
    identity: null,
    identityResolution: { status: "unresolved", candidates: [], confirmed: false },
    faces: [{ id: "front", side: "front" }],
    selectedArtworkByFace: {
      front: { candidateId, source: "upload", identityId: null, faceId: "front" },
    },
    backMode: "project-default",
    backModeSelectionPolicy: "automatic",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  };
}

function syntheticProvider(candidates: readonly ArtworkCandidate[]): ArtworkProvider {
  return {
    source: "upload",
    async searchArtwork() { return candidates; },
    async getPreview() { return undefined; },
    async getOriginal() { throw new Error("Synthetic benchmark provider has no stored originals."); },
    async getCandidate(candidateId) { return candidates.find((candidate) => candidate.id === candidateId); },
  };
}

function syntheticProject(index: number): ProjectDto {
  return {
    id: `synthetic-project-${index}`,
    name: `Synthetic Project ${index}`,
    projectSchemaVersion: 2,
    revision: index + 1,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    snapshot: { projectSchemaVersion: 6, cards: [], settings: DEFAULT_PROJECT_SETTINGS, physicalOrder: createPhysicalOrder([]) },
    templateSelection: null,
  };
}

async function syntheticJpeg(index: number, width = 745, height = 1040): Promise<Uint8Array> {
  const color = ((index + 1) * 2_654_435_761) >>> 0;
  const background = color.toString(16).padStart(8, "0").slice(-6);
  const accent = ((color ^ 0x00ffffff) >>> 0).toString(16).padStart(8, "0").slice(-6);
  const svg = width === 745 && height === 1040
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="745" height="1040"><rect width="745" height="1040" fill="#${background}"/><path d="M0 0L745 1040M745 0L0 1040" stroke="#${accent}" stroke-width="13"/><rect x="30" y="30" width="685" height="980" rx="38" fill="none" stroke="#${accent}" stroke-width="9"/><text x="58" y="520" font-size="52" fill="#${accent}">Synthetic ${index}</text></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#${background}"/><path d="M0 0L${width} ${height}M${width} 0L0 ${height}" stroke="#${accent}" stroke-width="${Math.max(1, Math.round(width * 0.017))}"/><rect x="${Math.round(width * 0.04)}" y="${Math.round(height * 0.03)}" width="${Math.round(width * 0.92)}" height="${Math.round(height * 0.94)}" rx="${Math.round(width * 0.05)}" fill="none" stroke="#${accent}" stroke-width="${Math.max(1, Math.round(width * 0.012))}"/><text x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.5)}" font-size="${Math.round(width * 0.07)}" fill="#${accent}">Synthetic ${index}</text></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer());
}

async function imageObjectCount(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes);
  return [...document.context.enumerateIndirectObjects()].filter(([, object]) =>
    object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image",
  ).length;
}

async function measure<T>(
  name: string,
  count: number | undefined,
  run: () => Promise<{ readonly value: T; readonly details?: Readonly<Record<string, unknown>> }>,
): Promise<{ readonly metric: Metric; readonly value: T }> {
  const before = process.memoryUsage();
  let rssPeak = before.rss;
  let heapPeak = before.heapUsed;
  let eventLoopDelayPeak = 0;
  let previousTick = performance.now();
  const monitor = setInterval(() => {
    const memory = process.memoryUsage();
    rssPeak = Math.max(rssPeak, memory.rss);
    heapPeak = Math.max(heapPeak, memory.heapUsed);
    const now = performance.now();
    eventLoopDelayPeak = Math.max(eventLoopDelayPeak, now - previousTick - 5);
    previousTick = now;
  }, 5);
  monitor.unref();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  try {
    const result = await run();
    const wallTimeMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const after = process.memoryUsage();
    rssPeak = Math.max(rssPeak, after.rss);
    heapPeak = Math.max(heapPeak, after.heapUsed);
    return {
      metric: {
        name,
        ...(count !== undefined ? { count } : {}),
        wallTimeMs,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        rssBeforeBytes: before.rss,
        rssPeakSampledBytes: rssPeak,
        rssAfterBytes: after.rss,
        heapBeforeBytes: before.heapUsed,
        heapPeakSampledBytes: heapPeak,
        heapAfterBytes: after.heapUsed,
        peakEventLoopDelayMs: eventLoopDelayPeak,
        ...(result.details ? { details: result.details } : {}),
      },
      value: result.value,
    };
  } finally {
    clearInterval(monitor);
  }
}

async function makeCatalog(images: ReadonlyMap<string, Uint8Array>, counters: { candidates: number; originals: number }) {
  const candidates = new Map([...images.keys()].map((id) => [id, {
    id,
    source: "upload" as const,
    identityId: null,
    faceId: "front",
    originalAvailable: true,
    originalCached: true,
  }]));
  const contentHashes = new Map([...images].map(([id, bytes]) => [id, createHash("sha256").update(bytes).digest("hex")]));
  return {
    async getArtworkCandidate(id: string) {
      counters.candidates += 1;
      return candidates.get(id);
    },
    async getArtworkOriginal(id: string) {
      counters.originals += 1;
      const bytes = images.get(id);
      if (!bytes) throw new Error(`No synthetic image for ${id}`);
      return {
        artworkId: id,
        contentHash: contentHashes.get(id)!,
        extension: "jpg",
        format: "jpeg" as const,
        byteLength: bytes.byteLength,
        widthPx: 745,
        heightPx: 1040,
        createdAt: "2026-10-03T00:00:00.000Z",
        bytes,
        provenance: [],
      };
    },
  };
}

const noCutGuides = {
  trim: { enabled: false, extentMm: 1, color: "blue" as const },
  external: { enabled: false, strokeWidthPt: 0.3, color: "black" as const },
};

describe.skipIf(!profileEnabled)("Phase 15 baseline/optimized benchmark", () => {
  it("profiles import, preview, artwork lookup, Working Set rendering, bleed, and PDF", async () => {
    const scenarios: Metric[] = [];
    const scales = [9, 100, 500, 1000] as const;

    for (const count of scales) {
      const imported = await measure(`import-decklist-${count}`, count, async () => {
        const result = await importFiles({ text: decklist(count), textFilename: "synthetic-decklist.txt" });
        return { value: result, details: { entries: result.entries.length, errors: result.report.errors.length, networkRequests: 0 } };
      });
      scenarios.push(imported.metric);

      const preview = await measure(`preview-json-${count}`, count, async () => {
        const json = JSON.stringify(toImportPreview(imported.value));
        return { value: json.length, details: { responseCharacters: json.length, entries: imported.value.entries.length } };
      });
      scenarios.push(preview.metric);

      const workingSet = await measure(`working-set-build-${count}`, count, async () => {
        const cards = createWorkingSet(imported.value);
        return { value: cards, details: { entries: cards.length, physicalCards: cards.reduce((total, card) => total + card.quantity, 0) } };
      });
      scenarios.push(workingSet.metric);

      if (count <= 500) {
        const snapshot = await measure(`project-snapshot-key-${count}`, count, async () => {
          const document = projectSnapshotDocument(workingSet.value, DEFAULT_PROJECT_SETTINGS);
          const key = projectSaveStateValue(document);
          return { value: key.length, details: { snapshotCharacters: key.length, entries: workingSet.value.length } };
        });
        scenarios.push(snapshot.metric);

        if (count === 500) {
          const changedCards = workingSet.value.map((card, index) => index === 0
            ? { ...card, identityHints: { ...card.identityHints, name: `${card.identityHints.name ?? "Card"} changed` } }
            : card);
          const incremental = await measure("project-snapshot-single-card-change-500", count, async () => {
            const document = projectSnapshotDocument(changedCards, DEFAULT_PROJECT_SETTINGS);
            const key = projectSaveStateValue(document);
            return { value: key.length, details: { snapshotCharacters: key.length, changedEntries: 1, entriesSerialized: changedCards.length } };
          });
          scenarios.push(incremental.metric);
        }
      }

      const render = await measure(`working-set-server-render-${count}`, count, async () => {
        const markup = renderToStaticMarkup(createElement(WorkingCardList, {
          cards: workingSet.value,
          selectedCardId: workingSet.value[0]?.id ?? null,
          physicalCardCount: workingSet.value.reduce((total, card) => total + card.quantity, 0),
          disabled: false,
          onSelect() {},
          onQuantityCommit() {},
          onQuantityAdjust() {},
          onMove() {},
          onDuplicate() {},
          onDelete() {},
        }));
        return { value: markup.length, details: {
          markupCharacters: markup.length,
          renderedRows: [...markup.matchAll(/class="working-card-row/g)].length,
          renderedButtons: [...markup.matchAll(/<button\b/g)].length,
        } };
      });
      scenarios.push(render.metric);

      if (count <= 500) {
        const projects = Array.from({ length: count }, (_, index) => syntheticProject(index));
        const session = projectSessionReducer(createProjectSessionState("synthetic-snapshot"), { type: "projects-loaded", projects });
        const reducerMock = vi.mocked(React.useReducer);
        const originalUseReducer = reducerMock.getMockImplementation() ?? React.useReducer;
        reducerMock.mockImplementation(((reducer: unknown, initial: unknown, initialize?: (value: unknown) => unknown) => {
          if (reducer === projectSessionReducer) return [session, vi.fn()];
          return (originalUseReducer as (...args: unknown[]) => unknown)(reducer, initial, initialize);
        }) as typeof React.useReducer);
        const renderedProjects = await measure(`projects-list-server-render-${count}`, count, async () => {
          const markup = renderToStaticMarkup(createElement(ProjectsPanel, {
            cards: [],
            settings: DEFAULT_PROJECT_SETTINGS,
            onProjectOpen() {},
            selectedCutPageNumber: 1,
            onCutPageNumberChange() {},
            disabled: false,
          }));
          return { value: markup.length, details: {
            markupCharacters: markup.length,
            renderedRows: [...markup.matchAll(/class="project-list-row/g)].length,
            renderedButtons: [...markup.matchAll(/<button\b/g)].length,
          } };
        });
        scenarios.push(renderedProjects.metric);
        reducerMock.mockImplementation(originalUseReducer);
      }
    }

    const importCancellation = await measure("import-cancellation-after-first-root", 2, async () => {
      const controller = new AbortController();
      let progressEvents = 0;
      try {
        await importFiles({ files: [
          { filename: "synthetic-one.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("1 Synthetic One") },
          { filename: "synthetic-two.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("1 Synthetic Two") },
        ] }, {
          signal: controller.signal,
          onProgress(progress) {
            progressEvents += 1;
            if (progress.completed === 1) controller.abort();
          },
        });
        return { value: "completed", details: { cancelled: false, partialResultReturned: true, progressEvents } };
      } catch (error) {
        return { value: "cancelled", details: {
          cancelled: controller.signal.aborted,
          errorName: error instanceof Error ? error.name : "unknown",
          partialResultReturned: false,
          progressEvents,
        } };
      }
    });
    scenarios.push(importCancellation.metric);

    const identity: CardIdentity = {
      id: "synthetic:identity",
      provider: "manual",
      name: "Synthetic Card",
      resolutionMethod: "manual",
      confidence: 1,
    };
    for (const count of scales) {
      const candidates: ArtworkCandidate[] = Array.from({ length: count }, (_, index) => ({
        id: `upload:synthetic-candidate-${index}`,
        source: "upload",
        identityId: identity.id,
        faceId: "front",
        originalAvailable: true,
        previewUri: `http://localhost/synthetic-preview/${index}.jpg`,
      }));
      const catalog = new ArtworkCatalog([syntheticProvider(candidates)]);
      const result = await measure(`artwork-catalog-lookup-${count}`, count, async () => {
        const items = await catalog.search(identity, { source: "upload", faceId: "front" });
        return { value: items.length, details: { candidatesReturned: items.length, networkRequests: 0 } };
      });
      scenarios.push(result.metric);

      const galleryCard: WorkingCard = {
        ...selectedCard("synthetic:artwork-gallery", 0, candidates[0]!.id),
        identity: { ...identity, id: "upload:synthetic-gallery-identity", name: "Synthetic gallery card" },
        identityResolution: { status: "resolved", method: "manual", confidence: 1, confirmed: true, candidates: [] },
        selectedArtworkByFace: { front: { candidateId: candidates[0]!.id, source: "upload", identityId: "upload:synthetic-gallery-identity", faceId: "front" } },
      };
      const editorState = createEditorHistoryState({ cards: [galleryCard], selectedCardId: galleryCard.id, face: "front", physicalOrder: createPhysicalOrder([galleryCard]) });
      const reducerMock = vi.mocked(React.useReducer);
      const originalUseReducer = reducerMock.getMockImplementation() ?? React.useReducer;
      reducerMock.mockImplementation(((reducer: unknown, initial: unknown, initialize?: (value: unknown) => unknown) => {
        if (reducer === editorHistoryReducer) return [editorState, vi.fn()];
        return (originalUseReducer as (...args: unknown[]) => unknown)(reducer, initial, initialize);
      }) as typeof React.useReducer);
      const stateMock = vi.mocked(React.useState);
      const originalUseState = stateMock.getMockImplementation() ?? React.useState;
      let stateCalls = 0;
      stateMock.mockImplementation(((initial: unknown) => {
        stateCalls += 1;
        if (stateCalls === 1) return [candidates, vi.fn()];
        return (originalUseState as (...args: unknown[]) => unknown)(initial);
      }) as typeof React.useState);
      const gallery = await measure(`artwork-gallery-server-render-${count}`, count, async () => {
        const markup = renderToStaticMarkup(createElement(CardIdentityWorkbench, { files: [], text: "", choices: {} }));
        return { value: markup.length, details: {
          markupCharacters: markup.length,
          renderedCandidates: [...markup.matchAll(/class="artwork-candidate/g)].length,
          renderedPreviewImages: [...markup.matchAll(/<img\b/g)].length,
          originalBytesLoaded: 0,
        } };
      });
      scenarios.push(gallery.metric);
      stateMock.mockImplementation(originalUseState);
      reducerMock.mockImplementation(originalUseReducer);
    }

    const coldWarmImage = await syntheticJpeg(1);
    const cache = new MemoryBleedCache();
    const bleedEngine = new BleedEngine({ cache });
    const bleedRequest = { imageBytes: coldWarmImage, bleedMm: 0.625, trimSizeMm: MAGIC_STANDARD_CARD };
    const cold = await measure("bleed-cache-cold", 1, async () => {
      const result = await bleedEngine.generate(bleedRequest);
      return { value: result.cacheStatus, details: { cacheStatus: result.cacheStatus, outputBytes: result.preview.bytes.byteLength } };
    });
    scenarios.push(cold.metric);
    const warm = await measure("bleed-cache-warm", 1, async () => {
      const result = await bleedEngine.generate(bleedRequest);
      return { value: result.cacheStatus, details: { cacheStatus: result.cacheStatus, outputBytes: result.preview.bytes.byteLength } };
    });
    scenarios.push(warm.metric);

    const bleedImages = new Map<string, Uint8Array>();
    for (let index = 0; index < 9; index += 1) bleedImages.set(`upload:bleed-${index}`, await syntheticJpeg(index + 10));

    const concurrencyOrders = [[1, 2, 4], [2, 4, 1], [4, 1, 2]] as const;
    const concurrencyOrder = concurrencyOrders[Number(process.env.PHASE15_RUN_INDEX ?? 0) % concurrencyOrders.length] ?? concurrencyOrders[0];
    for (const concurrency of concurrencyOrder) {
      const engine = new BleedEngine();
      let cursor = 0;
      let active = 0;
      let peakConcurrency = 0;
      let completed = 0;
      const result = await measure(`bleed-batch-native-concurrency-${concurrency}`, 9, async () => {
        const runNext = async (): Promise<void> => {
          while (true) {
            const index = cursor++;
            if (index >= bleedImages.size) return;
            active += 1;
            peakConcurrency = Math.max(peakConcurrency, active);
            try {
              await engine.generate({ imageBytes: bleedImages.get(`upload:bleed-${index}`)!, bleedMm: 0.625, trimSizeMm: MAGIC_STANDARD_CARD });
              completed += 1;
            } finally {
              active -= 1;
            }
          }
        };
        await Promise.all(Array.from({ length: concurrency }, () => runNext()));
        return { value: completed, details: { configuredConcurrency: concurrency, peakConcurrency, sharpConcurrency: sharp.concurrency() } };
      });
      scenarios.push(result.metric);
    }

    for (const count of [9, 100, 500] as const) {
      const rasterSize = count === 9 ? { width: 745, height: 1040 } : { width: 96, height: 134 };
      const uniqueBytes = count === 9
        ? [...bleedImages.values()]
        : await (async () => {
          const bytes: Uint8Array[] = [];
          for (let index = 0; index < count; index += 1) bytes.push(await syntheticJpeg(10_000 + count * 2 + index, rasterSize.width, rasterSize.height));
          return bytes;
        })();
      const sharedBytes = uniqueBytes[0]!;

      for (const distinct of [false, true]) {
        const images = new Map<string, Uint8Array>();
        const cards = Array.from({ length: count }, (_, index) => {
          const id = distinct ? `upload:bleed-${count}-${index}` : `upload:bleed-${count}-shared`;
          if (!images.has(id)) images.set(id, distinct ? uniqueBytes[index]! : sharedBytes);
          return selectedCard(`bleed-${count}-${index}`, index, id);
        });
        const counters = { candidates: 0, originals: 0 };
        const catalog = await makeCatalog(images, counters);
        const originalGenerate = BleedEngine.prototype.generate;
        let active = 0;
        let peakConcurrency = 0;
        const cacheStatuses: Array<"hit" | "miss" | "bypass"> = [];
        const spy = vi.spyOn(BleedEngine.prototype, "generate").mockImplementation(async function (this: BleedEngine, request) {
          active += 1;
          peakConcurrency = Math.max(peakConcurrency, active);
          try {
            const result = await originalGenerate.call(this, request);
            cacheStatuses.push(result.cacheStatus);
            return result;
          }
          finally { active -= 1; }
        });
        const result = await measure(`bleed-export-${distinct ? "unique" : "repeated"}-${count}`, count, async () => {
          const output = await exportWorkingCardsWithDiagnostics(catalog, cards, { bleedMm: 0.625, cutGuides: noCutGuides });
          return { value: output.pdfBytes.byteLength, details: {
            derivedResults: output.bleedDiagnostics.length,
            bleedEngineCalls: spy.mock.calls.length,
            cacheHits: cacheStatuses.filter((item) => item === "hit").length,
            cacheMisses: cacheStatuses.filter((item) => item === "miss").length,
            candidateLookups: counters.candidates,
            originalLookups: counters.originals,
            peakBleedConcurrency: peakConcurrency,
            pdfBytes: output.pdfBytes.byteLength,
            sourceRasterSize: rasterSize,
          } };
        });
        scenarios.push(result.metric);
        spy.mockRestore();
      }
    }

    const fullSizeUniqueBleedCount = 16;
    const fullSizeUniqueImages: Uint8Array[] = [];
    const fullSizeUniqueBleeds: BleedResult[] = [];
    for (let index = 0; index < fullSizeUniqueBleedCount; index += 1) {
      const original = await syntheticJpeg(20_000 + index);
      fullSizeUniqueImages.push(original);
      fullSizeUniqueBleeds.push(await new BleedEngine().generate({
        imageBytes: original,
        bleedMm: 0.625,
        trimSizeMm: MAGIC_STANDARD_CARD,
      }));
    }
    const fullSizeDerivativeBytes = fullSizeUniqueBleeds.reduce((total, bleed) => total + bleed.preview.bytes.byteLength, 0);
    const fullSizeUniqueDerivativeHashes = new Set(fullSizeUniqueBleeds.map((bleed) => createHash("sha256").update(bleed.preview.bytes).digest("hex")));
    const uniqueBleedJpegEmbeds = vi.spyOn(PDFDocument.prototype, "embedJpg");
    const uniqueBleedPngEmbeds = vi.spyOn(PDFDocument.prototype, "embedPng");
    try {
      const result = await measure("pdf-bleed-resource-cache-unique-fullsize-16", fullSizeUniqueBleedCount, async () => {
        const pdfBytes = await new LosslessPdfEngine().generate({
          images: fullSizeUniqueImages,
          bleedResults: fullSizeUniqueBleeds,
          cutGuides: noCutGuides,
        });
        const diagnostics = readPdfRasterCacheDiagnostics(pdfBytes);
        const rasterEmbeds = uniqueBleedJpegEmbeds.mock.calls.length + uniqueBleedPngEmbeds.mock.calls.length;
        const cacheStats = diagnostics ?? {
          rasterEmbeds,
          cacheLookups: rasterEmbeds,
          cacheHits: 0,
          cacheMisses: rasterEmbeds,
          cacheEntries: rasterEmbeds,
          snapshotBytes: fullSizeUniqueImages.reduce((total, image) => total + image.byteLength, 0) + fullSizeDerivativeBytes,
        };
        return { value: pdfBytes, details: {
          pdfBytes: pdfBytes.byteLength,
          pagesGenerated: (await PDFDocument.load(pdfBytes)).getPageCount(),
          xObjects: await imageObjectCount(pdfBytes),
          sourceRasterBytes: fullSizeUniqueImages.reduce((total, image) => total + image.byteLength, 0),
          derivativeBytes: fullSizeDerivativeBytes,
          derivativeDimensions: fullSizeUniqueBleeds[0]?.preview.widthPx && fullSizeUniqueBleeds[0]?.preview.heightPx
            ? { width: fullSizeUniqueBleeds[0].preview.widthPx, height: fullSizeUniqueBleeds[0].preview.heightPx }
            : null,
          derivativeUses: fullSizeUniqueBleeds.length,
          uniqueDerivatives: fullSizeUniqueDerivativeHashes.size,
          rasterEmbeds: cacheStats.rasterEmbeds,
          cacheableResources: cacheStats.cacheEntries,
          resourceCacheLookups: cacheStats.cacheLookups,
          resourceCacheHits: cacheStats.cacheHits,
          resourceCacheMisses: cacheStats.cacheMisses,
          resourceCacheSnapshotBytes: cacheStats.snapshotBytes,
          cacheDiagnosticsSource: diagnostics ? "runtime" : "reconstructed from baseline embed path and unique fixture identities",
        } };
      });
      scenarios.push(result.metric);
    } finally {
      uniqueBleedJpegEmbeds.mockRestore();
      uniqueBleedPngEmbeds.mockRestore();
    }

    for (const count of [9, 100, 500] as const) {
      const sharedBytes = await syntheticJpeg(1000 + count);
      const uniqueBytes: Uint8Array[] = [];
      for (let index = 0; index < count; index += 1) {
        const fixtureIndex = count === 9 ? 2000 : count === 100 ? 3000 : 4000;
        uniqueBytes.push(await syntheticJpeg(fixtureIndex + index));
      }

      for (const distinct of [false, true]) {
        const images = new Map<string, Uint8Array>();
        const cards = Array.from({ length: count }, (_, index) => {
          const id = distinct ? `upload:pdf-${count}-${index}` : `upload:pdf-${count}-shared`;
          if (!images.has(id)) images.set(id, distinct ? uniqueBytes[index]! : sharedBytes);
          return selectedCard(`pdf-${count}-${index}`, index, id);
        });
        const counters = { candidates: 0, originals: 0 };
        const catalog = await makeCatalog(images, counters);
        const jpegEmbeds = vi.spyOn(PDFDocument.prototype, "embedJpg");
        const pngEmbeds = vi.spyOn(PDFDocument.prototype, "embedPng");
        try {
          const result = await measure(`pdf-export-${count}-${distinct ? "unique" : "repeated"}-artwork`, count, async () => {
            const exported = await exportWorkingCardsWithDiagnostics(catalog, cards, { bleedMm: 0, cutGuides: noCutGuides });
            return { value: exported.pdfBytes, details: {
              pdfBytes: exported.pdfBytes.byteLength,
              uniqueArtworkHashes: new Set([...images.values()].map((bytes) => createHash("sha256").update(bytes).digest("hex"))).size,
              candidateLookups: counters.candidates,
              originalLookups: counters.originals,
            } };
          });
          const pages = (await PDFDocument.load(result.value)).getPageCount();
          const imageObjects = await imageObjectCount(result.value);
          scenarios.push({
            ...result.metric,
            details: {
              ...result.metric.details,
              pagesGenerated: pages,
              embeddedImageObjects: imageObjects,
              jpegEmbedCalls: jpegEmbeds.mock.calls.length,
              pngEmbedCalls: pngEmbeds.mock.calls.length,
            },
          });
        } finally {
          jpegEmbeds.mockRestore();
          pngEmbeds.mockRestore();
        }
      }
    }

    const sequentialCount = 500;
    const sequentialImages = new Map<string, Uint8Array>();
    const sequentialCards: WorkingCard[] = [];
    for (let index = 0; index < sequentialCount; index += 1) {
      const id = `upload:sequential-${index}`;
      sequentialImages.set(id, await syntheticJpeg(6000 + index));
      sequentialCards.push(selectedCard(`sequential-${index}`, index, id));
    }
    const sequentialCounters = { candidates: 0, originals: 0 };
    const sequentialCatalog = await makeCatalog(sequentialImages, sequentialCounters);
    const sequentialExports = await measure("pdf-export-sequential-500-unique-three-times", sequentialCount * 3, async () => {
      const pdfBytesPerExport: number[] = [];
      const memoryAfterExport: Array<{ readonly rssBytes: number; readonly heapUsedBytes: number }> = [];
      for (let exportIndex = 0; exportIndex < 3; exportIndex += 1) {
        let pdfByteLength = 0;
        {
          const exported = await exportWorkingCardsWithDiagnostics(sequentialCatalog, sequentialCards, { bleedMm: 0, cutGuides: noCutGuides });
          pdfByteLength = exported.pdfBytes.byteLength;
        }
        pdfBytesPerExport.push(pdfByteLength);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const memory = process.memoryUsage();
        memoryAfterExport.push({ rssBytes: memory.rss, heapUsedBytes: memory.heapUsed });
      }
      return { value: pdfBytesPerExport, details: {
        exports: pdfBytesPerExport.length,
        cardsPerExport: sequentialCount,
        pdfBytesPerExport,
        memoryAfterExport,
        candidateLookups: sequentialCounters.candidates,
        originalLookups: sequentialCounters.originals,
        cacheScope: "each export independently; no shared candidate/original memo buffers",
      } };
    });
    scenarios.push(sequentialExports.metric);

    const cancelImage = await syntheticJpeg(9000);
    const cancelController = new AbortController();
    const cancelCounters = { candidates: 0, originals: 0 };
    const cancelCatalog = await makeCatalog(new Map([["upload:cancel-export", cancelImage]]), cancelCounters);
    const cancelCards = Array.from({ length: 9 }, (_, index) => selectedCard(`cancel-export-${index}`, index, "upload:cancel-export"));
    const originalGetter = cancelCatalog.getArtworkOriginal;
    cancelCatalog.getArtworkOriginal = async (candidateId) => {
      const original = await originalGetter(candidateId);
      cancelController.abort();
      return original;
    };
    const exportCancellation = await measure("pdf-export-cancellation-after-first-card", 9, async () => {
      try {
        const output = await exportWorkingCardsWithDiagnostics(cancelCatalog, cancelCards, { bleedMm: 0, cutGuides: noCutGuides }, cancelController.signal);
        return { value: "completed", details: { cancelled: false, partialPdfReturned: true, pdfBytes: output.pdfBytes.byteLength, candidateLookups: cancelCounters.candidates, originalLookups: cancelCounters.originals } };
      } catch (error) {
        return { value: "cancelled", details: {
          cancelled: cancelController.signal.aborted,
          errorName: error instanceof Error ? error.name : "unknown",
          partialPdfReturned: false,
          candidateLookups: cancelCounters.candidates,
          originalLookups: cancelCounters.originals,
        } };
      }
    });
    scenarios.push(exportCancellation.metric);

    const phase = process.env.PHASE15_OUTPUT ?? "baseline";
    const outputPath = join(process.cwd(), "artifacts", "phase-15-performance", `${phase}.json`);
    await mkdir(join(process.cwd(), "artifacts", "phase-15-performance"), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({
      schemaVersion: 1,
      phase,
      baseSha: process.env.GIT_BASE_SHA ?? "18bcad3916b2ff2137ca3f1bfa747236e69c4072",
      recordedAt: new Date().toISOString(),
      network: false,
      fixtures: { synthetic: true, copyrightedImages: false, rasterSize: { widthPx: 745, heightPx: 1040 }, bleedScaleRasterSize: { widthPx: 96, heightPx: 134 }, jpegQuality: 88 },
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpuCount: cpus().length,
        systemMemoryBytes: totalmem(),
        sharpConcurrency: sharp.concurrency(),
        npmUserAgent: process.env.npm_config_user_agent ?? null,
      },
      methodology: {
        runsPerScenario: 1,
        processCountPerScenario: 3,
        sampleIntervalMs: 5,
        limitsOrGates: "None; measurements are recorded for comparison and are not timing pass/fail gates.",
        memory: "process.memoryUsage sampled every 5 ms during each async operation; event-loop delay is sampled at the same interval.",
        import: "Universal Import synthetic decklist → ImportPreview JSON → Working Set → Project snapshot serialization/key → actual WorkingCardList React server render. Projects allow at most 500 entries.",
        artworkLookup: "ArtworkCatalog with a local synthetic provider; no HTTP requests. Artwork gallery/Projects list are their actual components server-rendered with synthetic state/results.",
        export: "exportWorkingCardsWithDiagnostics with synthetic JPEGs and no external cut guides; repeated and unique bleed are measured at 9/100/500 cards, with 745x1040 assets at 9 and compact 96x134 synthetic assets at 100/500. A separate 16-item 745x1040 LosslessPdfEngine scenario retains real unique BleedEngine outputs while measuring PDF resource-cache retention; PDF bytes/pages/XObjects and cache diagnostics are recorded.",
      },
      scenarios,
    }, null, 2)}\n`, "utf8");
  }, 180_000);
});
