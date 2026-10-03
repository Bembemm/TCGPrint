# ADR 0018: Phase 15 performance boundaries

- Status: accepted
- Date: 2026-10-03
- Base: `18bcad3916b2ff2137ca3f1bfa747236e69c4072`

## Context

Profiling identified repeated PDF image embedding, repeated candidate/original reads for repeated selections, bleed decoding before cache lookup, and a process-wide bleed cache in the single-image PDF endpoint. The required PDF quality invariant is exact: optimization may reuse work or validated resources, but must not alter source bytes, decoded samples, vector artwork, print geometry, or output fidelity.

## Decisions

### PDF raster resources

Share raster resources only inside one `PDFDocument`. The key includes format, byte length, raster dimensions, PNG bit depth/color type or JPEG precision/component count, and SHA-256. A candidate cache hit is confirmed with byte equality against the private byte snapshot passed to `embedJpg`/`embedPng`, not a mutable caller view. A collision or caller-buffer mutation therefore creates a distinct resource.

Retain a resource snapshot only after a preflight count proves that the exact bytes occur more than once in that document. A supplied source digest is reused; otherwise a digest is computed once per raster index. Bleed derivatives use their own per-document digest counts. Digest buckets are split by exact byte equality before enabling reuse, and the cache still confirms equality against the private embedded snapshot. Single-use resources are embedded directly and never enter the reuse map.

The 16-item full-size unique-bleed benchmark reduced resource-cache snapshots from 5,268,633 bytes to zero while preserving all 32 XObjects and the exact 5,125,155-byte PDF. The sampled process RSS/heap did not decrease in that run, so no total-process memory reduction is claimed; the retained implementation is justified by removing cache entries with no possible hit while preserving resource reuse for repeated rasters.

Every physical position still emits its own draw and transform. JPEG resources use `embedJpg` with the exact source JPEG bytes. PNG stays lossless. The PNG16 path reuses its 16-bit color and alpha PDF references without changing samples. SVG continues through the existing validation and vector drawing path and is not rasterized or resource-deduplicated.

The resource map is created in `LosslessPdfEngine.generate()` and released with that document. It is never shared across PDF documents.

### Candidate and original lookups

Candidate metadata and originals are memoized only for repeated candidate IDs and only during one export. Candidate keys include selected source, identity context, and MPC references. Unique candidates do not enter the original-byte memo. SHA digests use a `WeakMap` for repeated byte objects. Bleed work maps and diagnostic staging are cleared before PDF assembly; candidate/original memo entries remain operation-local until the export settles, then become unreachable on success, failure, or cancellation.

### Bleed work and caches

After existing request, MIME, raster metadata, dimension, and complete pixel-affecting key validation, a cache hit can return before decoding source pixels or applying the rounded-corner mask. The cache key still includes algorithm version, source digest, bleed, trim size, corner flag/version, and radius when enabled.

Within an export, identical bleed inputs are deduplicated by derivative key plus byte equality. Unique work runs in an in-process queue capped at two active operations when more than one effective CPU is available, and one otherwise. Cancellation stops queued work. Already-started Sharp work may finish; its result is discarded and never reaches PDF generation. No Worker Threads are used.

`MemoryBleedCache` remains available and scoped to an export/request. The one-image PDF route now creates its engine per request because a process-wide cache there had no intra-request reuse and retained unrelated upload derivatives. No original artwork is automatically evicted or deleted. No persistent cache, global LRU, or destructive GC policy is introduced.

### Cancellation

The UI passes `AbortSignal` through artwork preparation/selection, resolution, and export routes. The export queue models queued, running, cancelling, cancelled, completed, and failed work. A cancelled resolution/export does not update the client Working Set with a partial result. A cancelled export does not create a download URL. The import API and parser already accept signals, but no import cancel button was added: upload originals and database rows are registered file-by-file after parsing, so the current persistence boundary cannot promise batch-atomic cancellation. Provider downloads and OCR already accept signals; started Tesseract/Sharp native work is allowed to finish where it cannot be interrupted safely.

No new progress protocol was added. Current import timings are short at tested local decklist sizes, and the PDF response API has no end-to-end page progress channel.

## Rejected or deferred

- Worker Threads: the measured gain at two native operations is available without the extra serialization, lifecycle, transfer, and shutdown complexity. Two remains bounded; four is rejected because its small additional throughput gain raises event-loop delay substantially.
- Concurrency four: rejected by the measured event-loop delay and no sufficient additional throughput benefit.
- Global bleed LRU/cache GC: not introduced. Per-operation scopes bound new export retention; no evidence supports a persistent global derivative cache. Originals remain immutable and are never GC candidates.
- PDF page cache: not introduced because page layout/order is inexpensive to rebuild and cached page PDFs would add invalidation and memory risks.
- Incremental Project serialization/cache: deferred. The 500-card snapshot measurement serializes all entries after one card changes, but the observed time is not enough to justify changing serializer semantics or Project identity keys.
- Virtualizer/library: deferred because this environment has neither Chromium nor Playwright. SSR timings do not measure scrolling, focus, keyboard, drag/drop, or paint. Working Set, artwork picker, and Projects remain unchanged.
- Progress protocol: deferred because there is no reliable end-to-end stage-count channel for PDF response generation and current import measurements do not show a perceptibly long local operation.
- JPEG recompression, image resizing/downsampling, PNG conversion or depth reduction, alpha changes, SVG rasterization, thumbnail export, geometry simplification, or any lossy quality tradeoff: rejected as incompatible with the mandatory PDF fidelity invariant.

## Verification

See [`artifacts/phase-15-performance/README.md`](../../artifacts/phase-15-performance/README.md) and the baseline/optimized JSON for the reproducible harness, measured results, resource counts, bytes, timings, and memory samples. The full-size unique-bleed scenario records source/derivative cache snapshots and verifies that unique inputs retain zero snapshot bytes. Fidelity tests assert JPEG stream passthrough, exact PNG16 color/alpha samples, repeated-resource draw counts, bleed trim/edge pixels, and existing SVG/geometry/duplex/calibration behavior.
