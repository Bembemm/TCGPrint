import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = "artifacts/phase-15-performance";
const baseSha = "18bcad3916b2ff2137ca3f1bfa747236e69c4072";
const baseline = JSON.parse(await readFile(join(directory, "baseline.json"), "utf8"));
const optimized = JSON.parse(await readFile(join(directory, "optimized.json"), "utf8"));
if (baseline.baseSha !== baseSha || optimized.baseSha !== baseSha) {
  throw new Error("Phase 15 benchmark artifacts do not share the required base SHA.");
}

const scenarios = new Map(optimized.scenarios.map((scenario) => [scenario.name, scenario]));
const baselineScenarios = new Map(baseline.scenarios.map((scenario) => [scenario.name, scenario]));
if (scenarios.size !== 52 || baselineScenarios.size !== scenarios.size) {
  throw new Error("Expected 52 paired Phase 15 benchmark scenarios.");
}

const comparison = (name) => {
  const before = baselineScenarios.get(name);
  const after = scenarios.get(name);
  if (!before || !after) throw new Error(`Missing paired benchmark scenario ${name}.`);
  const pair = (metric) => ({
    baseline: before[metric] ?? null,
    optimized: after[metric] ?? null,
    deltaPercent: typeof before[metric] === "number" && before[metric] !== 0 && typeof after[metric] === "number"
      ? Number((((after[metric] - before[metric]) / before[metric]) * 100).toFixed(2))
      : null,
  });
  return {
    name,
    count: before.count ?? null,
    wallTimeMs: pair("wallTimeMs"),
    cpuUserMs: pair("cpuUserMs"),
    cpuSystemMs: pair("cpuSystemMs"),
    rssPeakSampledBytes: pair("rssPeakSampledBytes"),
    heapPeakSampledBytes: pair("heapPeakSampledBytes"),
    peakEventLoopDelayMs: pair("peakEventLoopDelayMs"),
    baselineDetails: before.details ?? {},
    optimizedDetails: after.details ?? {},
  };
};

const scenarioNames = [...scenarios.keys()];
const allComparisons = scenarioNames.map(comparison);
const scaleCoverage = [9, 100, 500, 1000].map((count) => ({
  count,
  import: comparison(`import-decklist-${count}`),
  workingSetBuild: comparison(`working-set-build-${count}`),
  workingSetSSR: comparison(`working-set-server-render-${count}`),
  artworkPickerSSR: comparison(`artwork-gallery-server-render-${count}`),
  projectsSSR: count <= 500 ? comparison(`projects-list-server-render-${count}`) : null,
  pdfRepeated: count <= 500 ? comparison(`pdf-export-${count}-repeated-artwork`) : null,
  pdfUnique: count <= 500 ? comparison(`pdf-export-${count}-unique-artwork`) : null,
  bleedRepeated: count <= 500 ? comparison(`bleed-export-repeated-${count}`) : null,
  bleedUnique: count <= 500 ? comparison(`bleed-export-unique-${count}`) : null,
}));

const pdfDedupe = [9, 100, 500].map((count) => {
  const repeated = comparison(`pdf-export-${count}-repeated-artwork`);
  const unique = comparison(`pdf-export-${count}-unique-artwork`);
  return {
    count,
    repeatedArtwork: {
      uses: count,
      embedsOrImageXObjectsBefore: repeated.baselineDetails.embeddedImageObjects,
      embedsOrImageXObjectsAfter: repeated.optimizedDetails.embeddedImageObjects,
      jpegEmbedCallsBefore: repeated.baselineDetails.jpegEmbedCalls,
      jpegEmbedCallsAfter: repeated.optimizedDetails.jpegEmbedCalls,
      pagesBefore: repeated.baselineDetails.pagesGenerated,
      pagesAfter: repeated.optimizedDetails.pagesGenerated,
      pdfBytesBefore: repeated.baselineDetails.pdfBytes,
      pdfBytesAfter: repeated.optimizedDetails.pdfBytes,
      wallTimeMsBefore: repeated.wallTimeMs.baseline,
      wallTimeMsAfter: repeated.wallTimeMs.optimized,
      drawsAfter: count,
      drawInvariantEvidence: "tests/pdf-engine/pdf-engine.test.ts: repeated JPEG resource keeps all physical draw placements",
    },
    uniqueArtwork: {
      uniqueImagesBefore: unique.baselineDetails.embeddedImageObjects,
      uniqueImagesAfter: unique.optimizedDetails.embeddedImageObjects,
      pdfBytesBefore: unique.baselineDetails.pdfBytes,
      pdfBytesAfter: unique.optimizedDetails.pdfBytes,
      wallTimeMsBefore: unique.wallTimeMs.baseline,
      wallTimeMsAfter: unique.wallTimeMs.optimized,
    },
  };
});

const bleedNames = ["bleed-export-repeated-9", "bleed-export-unique-9", "bleed-export-repeated-100", "bleed-export-unique-100", "bleed-export-repeated-500", "bleed-export-unique-500"];
const bleedExports = bleedNames.map(comparison);
const nativeConcurrency = [1, 2, 4].map((concurrency) => ({
  concurrency,
  baseline: comparison(`bleed-batch-native-concurrency-${concurrency}`).baselineDetails,
  optimized: comparison(`bleed-batch-native-concurrency-${concurrency}`).optimizedDetails,
  baselineWallTimeMs: comparison(`bleed-batch-native-concurrency-${concurrency}`).wallTimeMs.baseline,
  optimizedWallTimeMs: comparison(`bleed-batch-native-concurrency-${concurrency}`).wallTimeMs.optimized,
  productionQueueMaximum: Math.min(2, optimized.runtime.cpuCount),
}));

const memoryScenarioNames = [
  "pdf-export-500-unique-artwork",
  "pdf-export-sequential-500-unique-three-times",
  "pdf-bleed-resource-cache-unique-fullsize-16",
  ...bleedNames,
];
const memoryScenario = (which, name) => {
  const scenario = (which === "baseline" ? baselineScenarios : scenarios).get(name);
  return {
    name,
    wallTimeMs: scenario.wallTimeMs,
    rssBeforeBytes: scenario.rssBeforeBytes,
    rssPeakSampledBytes: scenario.rssPeakSampledBytes,
    rssPeakAboveStartBytes: scenario.rssPeakSampledBytes - scenario.rssBeforeBytes,
    rssAfterBytes: scenario.rssAfterBytes,
    heapBeforeBytes: scenario.heapBeforeBytes,
    heapPeakSampledBytes: scenario.heapPeakSampledBytes,
    heapPeakAboveStartBytes: scenario.heapPeakSampledBytes - scenario.heapBeforeBytes,
    heapAfterBytes: scenario.heapAfterBytes,
    peakEventLoopDelayMs: scenario.peakEventLoopDelayMs,
    details: scenario.details,
    sampling: "5 ms interval; process RSS includes native allocations; short peaks may be missed",
  };
};

const memorySummary = {
  schemaVersion: 1,
  baseSha,
  methodology: "RSS and heap sampled every 5 ms during measured operations in independent Node processes; no forced GC; byte values are retained as recorded.",
  artifacts: { baseline: "baseline.json", optimized: "optimized.json" },
  comparableBaseline: memoryScenarioNames.map((name) => ({
    name,
    baseline: memoryScenario("baseline", name),
    optimized: memoryScenario("optimized", name),
  })),
  sequentialExports: {
    baseline: memoryScenario("baseline", "pdf-export-sequential-500-unique-three-times"),
    optimized: memoryScenario("optimized", "pdf-export-sequential-500-unique-three-times"),
    interpretation: "Three consecutive exports in one process show startup/native allocator growth between exports one and two and only a small change between two and three; heap after each export returns to a similar ~38–40 MB range. This is a three-export observation, not a claim about unbounded runs.",
  },
  uniqueFullSizeBleedResourceCache: {
    baseline: memoryScenario("baseline", "pdf-bleed-resource-cache-unique-fullsize-16"),
    optimized: memoryScenario("optimized", "pdf-bleed-resource-cache-unique-fullsize-16"),
    comparison: comparison("pdf-bleed-resource-cache-unique-fullsize-16"),
    scale: "16 unique 745x1040 source JPEGs with real BleedEngine 761x1056 PNG derivatives; derivatives remain live during LosslessPdfEngine generation; no manual GC. RSS/heap before, sampled peak, and after are medians across three independent processes; peak-above-start is included to account for different process baselines.",
    interpretation: "Baseline snapshot bytes equal unique source plus derivative input bytes. Optimized runtime diagnostics report zero resource-cache entries and zero snapshot bytes when every exact raster occurs once. PDF byte length and XObject count are compared alongside RSS/heap samples.",
  },
  earlierBaselineContext: "An earlier preliminary 500-unique run reported about 434 MiB RSS while synthetic fixtures were generated with unbounded Promise.all in the same process. The comparable artifacts here generate fixtures sequentially and report the isolated export scenario separately from the 3-export scenario; do not compare the preliminary fixture-inclusive peak as if it were the isolated-export peak.",
};

const bleedCache = comparison("bleed-cache-warm");
const bleedCold = comparison("bleed-cache-cold");
const repeatedPdf500 = comparison("pdf-export-500-repeated-artwork");
const repeatedBleed500 = comparison("bleed-export-repeated-500");
const uniqueFullSizeBleedCache = comparison("pdf-bleed-resource-cache-unique-fullsize-16");
const cacheSummary = {
  schemaVersion: 1,
  baseSha,
  policy: {
    pdfRasterResources: "Per PDFDocument only; reuse is enabled only when preflight counts more than one exact byte identity in a SHA-256 bucket. Key includes format, byte length, raster dimensions, PNG bit depth/color type or JPEG precision/components and SHA-256; cache hits still require exact byte equality against the private embedded snapshot. Unique rasters use direct embeds and create no snapshot entry; SHA bucket collisions remain distinct resources.",
    bleed: "Export scoped BleedEngine/MemoryBleedCache, complete key covers algorithm version, original content hash, bleed, trim dimensions, rounded-corner flag and radius/version as applicable; validate metadata and digest before cache lookup; decode only on a miss.",
    repeatedInputs: "Within one export, exact repeated source bytes share the candidate/original lookup when the candidate/context repeats and share bleed work by derivative key plus byte equality. Large unique originals are not stored in the candidate/original memo.",
    artworkStores: "ArtworkOriginalStore remains content-addressed and immutable; ArtworkThumbnailStore and ArtworkMetadataCache retain their existing storage/validation/expiry semantics. No original GC or new persistent cache was added.",
    scopeAndEviction: "No new global cache, cross-PDF reuse, persistent derivative cache, page cache, or destructive cleanup policy. Per-export memo/cache references are operation scoped.",
  },
  measured: {
    bleedCold: { baselineMs: bleedCold.wallTimeMs.baseline, optimizedMs: bleedCold.wallTimeMs.optimized, baselineBytes: bleedCold.baselineDetails.outputBytes, optimizedBytes: bleedCold.optimizedDetails.outputBytes, outputBytesIdentical: bleedCold.baselineDetails.outputBytes === bleedCold.optimizedDetails.outputBytes },
    bleedWarm: { baselineMs: bleedCache.wallTimeMs.baseline, optimizedMs: bleedCache.wallTimeMs.optimized, baselineBytes: bleedCache.baselineDetails.outputBytes, optimizedBytes: bleedCache.optimizedDetails.outputBytes, outputBytesIdentical: bleedCache.baselineDetails.outputBytes === bleedCache.optimizedDetails.outputBytes, cacheHit: bleedCache.optimizedDetails.cacheStatus, unitEvidence: "tests/image-engine/bleed-engine.test.ts asserts the warm hit bypasses decode and returns identical cached PNG bytes" },
    candidateAndOriginal500Repeated: { baselineLookups: repeatedBleed500.baselineDetails.candidateLookups, optimizedLookups: repeatedBleed500.optimizedDetails.candidateLookups, baselineOriginalReads: repeatedBleed500.baselineDetails.originalLookups, optimizedOriginalReads: repeatedBleed500.optimizedDetails.originalLookups },
    pdf500Repeated: { baselineImageEmbeds: repeatedPdf500.baselineDetails.embeddedImageObjects, optimizedImageEmbeds: repeatedPdf500.optimizedDetails.embeddedImageObjects, baselinePdfBytes: repeatedPdf500.baselineDetails.pdfBytes, optimizedPdfBytes: repeatedPdf500.optimizedDetails.pdfBytes },
    uniqueFullSizeBleedRasterResources: {
      scenario: uniqueFullSizeBleedCache.name,
      derivativeBytes: uniqueFullSizeBleedCache.optimizedDetails.derivativeBytes,
      sourceRasterBytes: uniqueFullSizeBleedCache.optimizedDetails.sourceRasterBytes,
      xObjectsBefore: uniqueFullSizeBleedCache.baselineDetails.xObjects,
      xObjectsAfter: uniqueFullSizeBleedCache.optimizedDetails.xObjects,
      pdfBytesBefore: uniqueFullSizeBleedCache.baselineDetails.pdfBytes,
      pdfBytesAfter: uniqueFullSizeBleedCache.optimizedDetails.pdfBytes,
      cacheEntriesBefore: uniqueFullSizeBleedCache.baselineDetails.cacheableResources,
      cacheEntriesAfter: uniqueFullSizeBleedCache.optimizedDetails.cacheableResources,
      snapshotBytesBefore: uniqueFullSizeBleedCache.baselineDetails.resourceCacheSnapshotBytes,
      snapshotBytesAfter: uniqueFullSizeBleedCache.optimizedDetails.resourceCacheSnapshotBytes,
      cacheHitsBefore: uniqueFullSizeBleedCache.baselineDetails.resourceCacheHits,
      cacheHitsAfter: uniqueFullSizeBleedCache.optimizedDetails.resourceCacheHits,
      cacheMissesBefore: uniqueFullSizeBleedCache.baselineDetails.resourceCacheMisses,
      cacheMissesAfter: uniqueFullSizeBleedCache.optimizedDetails.resourceCacheMisses,
    },
  },
  existingCacheOwners: [
    { name: "MemoryBleedCache", module: "image-engine/bleed/cache.ts", phase15Change: "scope at the one-image import PDF route and export operation; no global LRU" },
    { name: "ArtworkThumbnailStore", module: "artwork/storage/thumbnail-store.ts", phase15Change: "preserved; content-addressed bytes continue to be hash and length validated" },
    { name: "ArtworkOriginalStore", module: "artwork/storage/original-store.ts", phase15Change: "preserved; immutable originals are not eligible for eviction/GC" },
    { name: "ArtworkMetadataCache", module: "artwork/storage/metadata-cache.ts", phase15Change: "preserved; existing expiry behavior" },
  ],
};

const benchmarkSummary = {
  schemaVersion: 1,
  baseSha,
  branch: "feature/fase-15-performance",
  baselineRecordedAt: baseline.recordedAt,
  optimizedRecordedAt: optimized.recordedAt,
  runtime: optimized.runtime,
  methodology: {
    runsPerScenario: 3,
    aggregation: "Median across three independent Node/Vitest processes; raw runs remain in baseline.json and optimized.json.",
    fixtures: "Synthetic decklists, projects, JPEGs and PNGs only; offline; no copyrighted images and no real internet requests.",
    memory: "RSS/heap sampled at 5 ms while an asynchronous scenario runs; event-loop delay is sampled, not an absolute CI gate.",
    uiLimitation: "Only React server rendering was measured. Chromium and Playwright are unavailable in this environment; browser scroll, focus, keyboard, drag/drop, paint and interaction timings are unmeasured.",
    importLimitation: "Import scenarios exercise the local Universal Import parser/preview/Working Set path and do not include file selection, filesystem persistence or remote catalog access.",
  },
  scaleCoverage,
  pdfResourceDedupe: pdfDedupe,
  bleedExports,
  bleedCache: {
    cold: comparison("bleed-cache-cold"),
    warm: comparison("bleed-cache-warm"),
  },
  nativeConcurrency,
  sequentialExports: comparison("pdf-export-sequential-500-unique-three-times"),
  projectIncrementalCandidate: comparison("project-snapshot-single-card-change-500"),
  cancellation: [comparison("import-cancellation-after-first-root"), comparison("pdf-export-cancellation-after-first-card")],
  uiBrowser: { available: false, browserFound: false, playwrightFound: false, virtualizationImplemented: false, note: "No browser virtualizer was added; SSR results were not used as a browser benchmark substitute." },
  allScenarioComparisons: allComparisons,
};

await writeFile(join(directory, "benchmark-summary.json"), `${JSON.stringify(benchmarkSummary, null, 2)}\n`);
await writeFile(join(directory, "memory-summary.json"), `${JSON.stringify(memorySummary, null, 2)}\n`);
await writeFile(join(directory, "cache-summary.json"), `${JSON.stringify(cacheSummary, null, 2)}\n`);

const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const artifactNames = ["README.md", "baseline.json", "optimized.json", "benchmark-summary.json", "memory-summary.json", "cache-summary.json"];
const sourceNames = [
  "scripts/phase-15-benchmark.mjs",
  "scripts/phase-15-summarize.mjs",
  "tests/performance/phase-15-performance.test.ts",
  "tests/pdf-engine/pdf-engine.test.ts",
  "tests/services/card-export.test.ts",
  "tests/image-engine/bleed-engine.test.ts",
  "tests/app/card-api.test.ts",
  "services/card-export.ts",
  "pdf-engine/document/index.ts",
  "pdf-engine/document/raster-resource-policy.ts",
  "image-engine/bleed/index.ts",
  "src/app/api/import/pdf/route.ts",
  "src/app/artwork-selection-request.ts",
  "src/app/card-identity-workbench.tsx",
  "package.json",
  "docs/decisions/0018-phase-15-performance.md",
];
const trackedFiles = {};
for (const path of [...artifactNames.map((name) => join(directory, name)), ...sourceNames]) trackedFiles[path] = await sha256File(path);
const manifest = {
  schemaVersion: 1,
  phase: 15,
  sourceBaseSha: baseSha,
  featureBranch: "feature/fase-15-performance",
  benchmarkRuntime: optimized.runtime,
  baselineRecordedAt: baseline.recordedAt,
  optimizedRecordedAt: optimized.recordedAt,
  scenarioCount: optimized.scenarios.length,
  benchmarkRunsPerScenario: optimized.methodology.runsPerScenario,
  fixturePolicy: "Synthetic fixtures only; no copyrighted card images; no real network access.",
  generatedInFeatureWorktree: true,
  filesSha256: trackedFiles,
};
manifest.filesSha256[join(directory, "manifest.json")] = null;
manifest.manifestChecksumNote = "manifest.json is self-listed with null because a file cannot contain its own stable SHA-256 checksum.";
await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(`Wrote benchmark, memory, cache summaries and manifest for ${optimized.scenarios.length} scenarios.\n`);
