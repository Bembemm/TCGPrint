# TCGPrint Native — implementation plan

The current web application remains the reference until native parity is proven.

Milestones are named N1–N9 to avoid confusion with the existing Part 2 M1–M8 history.

## N0 — Migration map

Goal: freeze the source baseline and trace every current capability.

Deliverables:

- current capability inventory;
- target architecture;
- source-to-native traceability;
- quality contracts;
- explicit plotter exclusion.

Gate:

- every source subsystem has a PORT / COMPAT / DEFER disposition;
- no native production implementation yet.

## N1 — Native foundation and measurable shell

Goal: prove the toolchain, packaging and UI/render path before porting product logic.

Deliverables:

- CMake/CMake Presets;
- Qt 6.12 + C++23 executable;
- QML application shell;
- Windows MSVC build;
- CI build/test;
- structured logging;
- background-job abstraction with cancellation/progress;
- benchmark harness;
- initial `windeployqt` packaged folder.

Performance baseline:

- cold/warm launch;
- idle RAM;
- compositor empty-scene frame pacing.

Gate:

- reproducible clean Windows build;
- packaged exe launches without development environment;
- no web server/localhost requirement.

## N2 — Domain model, projects and compatibility

Goal: establish the native source of truth and prove we can preserve existing Projects.

Port:

- WorkingCard;
- CardIdentity/faces/back semantics;
- WorkingSet/history;
- PhysicalOrder;
- project settings excluding plotter-specific settings from active UI;
- SQLite projects repository;
- revisions/CAS;
- autosave/recovery/duplicate/delete;
- snapshot migrations.

Compatibility gate:

- native reader loads representative current snapshots v1–v6;
- semantic round-trip comparison passes for cards, artwork refs, backs, physical order, print settings and calibration references;
- no shared artwork deletion on Project delete.

## N3 — Import, identity and providers

Goal: make cards enter the native Working Set through the current supported paths.

Port:

- content detection;
- text/CSV/JSON/XML/image/ZIP;
- supported URL adapters;
- Scryfall identity;
- custom-card path;
- DFC detection;
- provider health;
- Scryfall/MPC/local artwork providers;
- rate limiting and request coalescing.

Gate:

- current import fixtures have native equivalents;
- provider failures remain isolated;
- offline/cache behavior is explicit.

## N4 — Artwork storage, image engine and Picker

Goal: beat the current Picker responsiveness without weakening media quality.

Port:

- metadata/original/thumbnail/display storage tiers;
- content hashes/provenance;
- effective DPI;
- progressive Scryfall/MPC;
- visible-first thumbnail scheduling;
- edge-extension bleed;
- rounded corners;
- Back Library;
- full native Artwork Picker and selection scopes.

Required UX:

- useful Picker content appears before full catalog completion;
- selecting artwork updates immediately and Picker stays open;
- HQ current preview can replace low-res preview asynchronously;
- scrolling must use virtualized native model/view behavior.

Quality gate:

- bleed pixel fixtures equal the current product contract;
- original bytes never replaced by previews;
- selection face/identity policy tests pass.

## N5 — Canonical geometry and GPU compositor

Goal: establish the native compositor on the same physical plan that export will use.

Port:

- millimeter value types;
- paper/card formats;
- margins/gaps/orientation;
- automatic layout;
- explicit rows/columns;
- skipped slots;
- per-card bleed envelope;
- physical-order assignment;
- pagination;
- front/back mapping;
- printed PDF guide geometry;
- selection/HUD/drag/reorder;
- zoom modes and layers.

Do not port cutter-specific registration/reserved-zone logic.

Performance gate:

- pan/zoom/reorder remains interactive on representative 500-card Project;
- visible image jobs preempt offscreen work;
- no Project mutation from zoom/page/layer-only actions.

## N6 — Lossless PDF engine

Goal: equal or exceed current PDF fidelity before relying on native output.

Implement:

- QPDF-based document writer;
- exact page/card physical geometry;
- JPEG DCT passthrough;
- PNG 8-bit and alpha;
- PNG 16-bit and alpha/tRNS/Adam7 cases currently supported;
- strict vector SVG subset;
- clipping/affine transforms;
- printed trim/external guide vectors;
- no plotter SVG/DXF output;
- final PDF proof via Qt PDF/PDFium.

Hard gate:

- current fidelity fixtures ported;
- unprocessed JPEG embedded stream hashes match source;
- extracted PNG samples match source;
- 16-bit low bytes survive;
- SVG fixture contains vectors and no raster substitute;
- unsupported SVG fails;
- physical measurements match expected mm within established tolerance.

The native app is not allowed to replace the web app before N6 passes.

## N7 — Backs, duplex and calibration

Goal: complete production print semantics.

Port:

- Project Default Back;
- Back Library/current-retired semantics;
- manual provider physical backs;
- DFC automatic/manual backs;
- missing-back policy;
- front only / back only / separate / duplex;
- long-edge and short-edge pairing;
- printer profiles;
- offset/rotation/scale/skew;
- calibration and verification sheets;
- nominal/calibrated compositor view.

Gate:

- simple + DFC mixed jobs pair correctly;
- reordered physical copies remain paired;
- calibration numeric transform matches compositor/export;
- Project profile references remain reproducible.

## N8 — Full parity, migration and performance

Goal: compare native vs baseline as a complete product.

Build a parity matrix for every PORT/COMPAT row in CURRENT_SYSTEM_INVENTORY.

Performance scenarios:

- cold/warm start;
- open medium/large Projects;
- Scryfall Picker cold/warm;
- MPC Picker cold/warm;
- first 8 useful thumbnails;
- 100/250/500 physical card compositor;
- PDF export;
- duplex export;
- memory high-water;
- cache rebuild/hit paths.

Gate:

- no unexplained parity gap;
- no quality contract failure;
- native app must demonstrate meaningful improvement in at least the interactive workloads that motivated the rewrite.

## N9 — Windows distribution

Goal: make the native app the normal Windows install.

Deliverables:

- release package/installer;
- dependency/license inventory;
- crash/diagnostic bundle;
- upgrade/uninstall behavior;
- Project/cache location policy;
- backup/export/import documentation.

Gate:

- clean Windows machine install test;
- no developer runtimes required beyond intentionally bundled/runtime prerequisites;
- uninstall does not silently delete user Projects.

## Later, optional — Plotter/cutter

Not scheduled as part of N1–N9.

Potential future work:

- Silhouette;
- cutter registration;
- `.studio3`;
- SVG/DXF cutter export;
- cutter-specific validation.

If restarted, it must attach to the already proven canonical print/layout model instead of changing it.
