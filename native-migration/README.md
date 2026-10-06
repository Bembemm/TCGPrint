# TCGPrint Native — migration baseline

Status: planning / traceability only. No native implementation has started.

## Baseline

The native rewrite is mapped from the complete current TCGPrint state at:

- source repository: `Bembemm/TCGPrint`
- source branch: `chatgpt/selection-picker-visual-rescue`
- source commit: `7f2308764d3f4691d662e29d3ad0cc9ee8535a1b`
- source commit title: `style: simplify cut export presentation`

That commit is the behavioral reference. The native application must not silently lose a capability that exists there. Differences must be intentional and recorded in the capability map.

## Goal

Build a Windows-first native TCGPrint focused on:

1. maximum interactive performance;
2. deterministic and high-fidelity print output;
3. local-first/offline-friendly operation;
4. aggressive persistent caching without replacing source originals;
5. direct filesystem/database access;
6. a GPU-backed compositor;
7. explicit separation between live compositor preview and final PDF proof;
8. preserving the current product semantics for projects, cards, artwork, DFCs, backs, duplex, calibration and export.

## Target technology

- C++23
- Qt 6.12
- Qt Quick / QML for the application UI
- Qt Quick Scene Graph / RHI for GPU-backed compositor presentation
- Qt Network for Scryfall/MPC and URL imports
- Qt SQL + SQLite for local durable state
- Qt Concurrent / QThreadPool for cancellable background work
- QPDF as the low-level basis for the final lossless/fidelity PDF writer
- Qt PDF / PDFium only for final-PDF viewing/proof rendering
- libvips for native raster processing and derived-preview generation
- lcms2-compatible ICC/color-management path when color management is enabled
- CMake + CMake Presets
- MSVC on Windows; cross-platform compatibility should not compromise Windows quality/performance
- Qt Test for Qt/QML integration plus a C++ unit-test framework for pure domain code

## Explicit non-goal for the initial native rewrite

Plotter/cutter integration is deferred.

Do **not** port in the initial native milestones:

- Silhouette integration;
- `.studio3` handling;
- SVG/DXF cutter export;
- cutter-specific cut-path geometry;
- cutter registration marks / reserved cutter zones;
- plotter validation artifacts and APIs.

This does **not** remove normal printed PDF cut/trim guides. Printed trim/external guides remain part of the print/export pipeline.

Printer calibration, front/back registration and duplex alignment also remain in scope; they are printing capabilities, not plotter integration.

## Documents

- [CURRENT_SYSTEM_INVENTORY.md](CURRENT_SYSTEM_INVENTORY.md) — capability-by-capability inventory of the current application.
- [TARGET_ARCHITECTURE.md](TARGET_ARCHITECTURE.md) — proposed C++/Qt architecture and ownership boundaries.
- [TRACEABILITY.md](TRACEABILITY.md) — old paths/contracts to native modules.
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — native milestones and quality gates.
- [QUALITY_CONTRACTS.md](QUALITY_CONTRACTS.md) — invariants that must survive the rewrite.

## Rewrite rule

The web implementation is a reference implementation, not code to transliterate line-by-line.

Port behavior and invariants first. Re-design internals when the native architecture can be simpler, faster or safer, but preserve externally visible semantics unless a migration decision explicitly changes them.
