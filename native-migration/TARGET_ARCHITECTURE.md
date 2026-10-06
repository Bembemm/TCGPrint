# Target architecture — C++ / Qt Native

## 1. Architectural principle

TCGPrint Native is a local-first desktop application. There is no localhost HTTP API between UI and domain logic.

QML owns presentation state. C++ application services own use cases. Pure C++ domain modules own rules. Infrastructure modules own network, files, SQLite and codecs.

The same canonical models feed compositor and export, but preview assets and final-export assets remain intentionally separate.

## 2. Proposed repository layout

```text
TCGPrint-Native/
├─ CMakeLists.txt
├─ CMakePresets.json
├─ cmake/
├─ app/
│  ├─ main.cpp
│  ├─ qml/
│  │  ├─ App.qml
│  │  ├─ workspace/
│  │  ├─ cards/
│  │  ├─ picker/
│  │  ├─ compositor/
│  │  ├─ projects/
│  │  ├─ settings/
│  │  ├─ calibration/
│  │  └─ export/
│  └─ resources/
├─ src/
│  ├─ domain/
│  │  ├─ cards/
│  │  ├─ artwork/
│  │  ├─ geometry/
│  │  ├─ duplex/
│  │  ├─ calibration/
│  │  └─ projects/
│  ├─ application/
│  │  ├─ ProjectController
│  │  ├─ WorkingSetController
│  │  ├─ ArtworkPickerController
│  │  ├─ CompositorController
│  │  ├─ ImportController
│  │  └─ ExportController
│  ├─ providers/
│  │  ├─ scryfall/
│  │  ├─ mpc/
│  │  └─ local/
│  ├─ import/
│  ├─ storage/
│  │  ├─ sqlite/
│  │  ├─ projects/
│  │  ├─ artwork/
│  │  ├─ backs/
│  │  └─ cache/
│  ├─ image/
│  │  ├─ validation/
│  │  ├─ preview/
│  │  ├─ bleed/
│  │  ├─ color/
│  │  └─ codecs/
│  ├─ layout/
│  ├─ compositor/
│  ├─ pdf/
│  ├─ calibration/
│  ├─ diagnostics/
│  └─ platform/
│     └─ windows/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ qml/
│  ├─ fidelity/
│  ├─ golden/
│  └─ benchmarks/
└─ docs/
```

Plotter/cutter modules are intentionally absent from the initial tree.

## 3. Ownership boundaries

### QML

QML may:

- render models;
- hold temporary visual state such as open panel, active page, zoom and local picker filters;
- emit user intentions;
- animate/transition;
- display progress/errors.

QML must not:

- own canonical Project/card state;
- parse provider payloads;
- decide DFC/back rules;
- generate export images/PDF;
- write SQLite directly;
- mutate filesystem cache directly.

### Application services

Application services coordinate use cases and expose models/signals to QML. They are the only bridge from UI to domain/infrastructure.

Long-running actions return jobs with progress, cancellation and typed results.

### Domain

Domain code should be Qt-light or Qt-free where practical. Geometry, back selection, physical ordering, selection scope, duplex pairing and validation must remain deterministic pure logic suitable for fast unit tests.

## 4. Rendering/compositor

The live compositor is GPU-oriented and never doubles as the export renderer.

```text
ProjectSnapshot + WorkingSet + Settings
                  │
                  v
          CanonicalPrintPlan
            /            \
           /              \
Live compositor          PDF export
Qt Quick Scene Graph     LosslessPdfEngine
preview textures         validated originals
```

### GPU path

- use Qt Quick Scene Graph/RHI;
- page/card geometry remains in millimeters in the model;
- a viewport transform maps physical units to device pixels;
- previews are decoded asynchronously;
- GPU textures are cached with a memory budget;
- viewport-visible cards receive highest priority;
- zooming/reordering must not trigger re-download/re-derivation of source media;
- final export never reads framebuffer or compositor textures.

## 5. Artwork/cache pipeline

```text
Provider metadata
      │
      ├── metadata cache (SQLite)
      │
      ├── preview/display derivative cache
      │
      └── immutable original store
                 │
                 ├── image derivation
                 └── final PDF
```

All cache records carry provenance: provider, stable source ID, source hash, algorithm version and relevant settings.

Originals are immutable and content-addressed. Derived files are disposable/rebuildable.

## 6. Network

Qt Network owns online I/O.

Required behaviors:

- provider-specific rate limiting;
- request coalescing;
- cancellation;
- retry only where semantically safe;
- bounded concurrency;
- response-size limits;
- staged/progressive catalog events;
- cache-first behavior where allowed;
- clear degraded/offline states.

Scryfall and MPC remain separate providers behind a common `ArtworkProvider` interface.

## 7. SQLite

Use Qt SQL/QSQLITE or a thin direct-SQLite wrapper behind repositories.

Keep lifecycle separation:

- `projects.sqlite`: durable user project/recovery data;
- `artwork-cache.sqlite`: reconstructible provider/cache metadata;
- other durable stores may remain separate if their lifecycle requires it.

Project snapshot schema version remains independent from physical SQLite schema version.

The first native persistence milestone must be able to ingest current Project snapshot versions supported by the baseline app and rewrite them to the native current schema without losing semantic state.

## 8. Image engine

### Source rules

- source originals immutable;
- no unnecessary resize/re-encode;
- actual file signature/content validation, not extension trust;
- dimensions/bit depth/alpha recorded;
- ICC metadata recorded and not silently discarded.

### Bleed

The current product contract is preserved:

- only pixels outside trim are generated;
- top/bottom/left/right repeat the immediate adjacent border row/column;
- corner extension uses the corresponding trim corner pixel;
- trim is untouched when rounded corners are off;
- no AI/inpainting/interior sampling;
- zero bleed is passthrough;
- rounded corners are a separate optional transform;
- preview/export use the same derivation implementation.

Use libvips for efficient native image operations where it can preserve the required pixel semantics. Any libvips operation used for a fidelity-sensitive path must have a sample-level regression test.

## 9. Final PDF engine

Do not make Qt `QPdfWriter` the canonical final exporter by default.

The required engine has stricter guarantees:

- source JPEG DCT bytes preserved for unprocessed JPEG;
- PNG samples/alpha preserved without JPEG conversion;
- 16-bit PNG samples preserved;
- vector SVG subset remains vector;
- unsupported SVG explicitly fails;
- millimeters remain canonical until the PDF point conversion boundary;
- no hidden downsampling/recompression/page rasterization;
- deterministic geometry;
- duplex/calibration/cut-guide vectors share the canonical print plan.

### Proposed implementation

Use QPDF as a low-level PDF object/stream writer and build a small TCGPrint-specific `LosslessPdfEngine` around it.

The engine owns:

- page dictionaries and MediaBox;
- image XObjects;
- DCT passthrough;
- Flate sample streams and soft masks;
- vector operators;
- clipping;
- affine transforms;
- guide/stroke vectors;
- metadata/output intent when color management is enabled.

Qt PDF/PDFium is used to load/render the bytes produced by this engine for “Final PDF” proof inside the application.

## 10. SVG

Retain a conservative explicit supported subset at first.

- parse with a strict XML parser;
- whitelist elements/attributes;
- reject unsupported content;
- translate supported shapes/path data to PDF vector operators;
- never silently rasterize;
- preview renderer may be richer than export only if UI clearly reports that the asset is not exportable; otherwise keep parity.

## 11. Color management

Color management is part of quality, but enabling it without validation can make output less predictable.

Architecture should support:

- embedded/source ICC detection;
- monitor preview transform;
- printer/output profile selection;
- PDF output intent;
- RGB/CMYK-aware behavior;
- deterministic opt-out/raw behavior.

Enable this only after controlled fixture/print verification. Until then, do not silently convert source color data.

## 12. Concurrency

Define task pools/priorities instead of allowing arbitrary background work.

Suggested classes:

- UI/render-critical;
- visible-preview;
- provider metadata;
- original download;
- image derivation;
- export;
- maintenance/GC.

Every heavy operation needs:

- cancellation token;
- progress;
- bounded concurrency;
- lifetime/generation guard so stale completion cannot mutate current state.

## 13. Packaging

Windows initial target:

- MSVC toolchain;
- release build with symbols retained separately;
- `windeployqt` for Qt runtime/QML/plugin collection;
- explicit bundling of QPDF/libvips/SQLite and their applicable runtime dependencies;
- installer packaging after functional parity;
- crash logs and diagnostic export available without requiring a server.

## 14. What is deliberately not ported yet

No initial native implementation for:

- plotter/cutter job generation;
- Silhouette;
- `.studio3`;
- cutter-specific registration geometry;
- DXF/SVG cutter output.

The architecture must not block these from being added later, but no current native milestone depends on them.
