# Source-to-native traceability

Baseline: `7f23087`.

This file maps current source ownership to intended native ownership. It is intentionally path-oriented so migration work can always answer “where did this behavior come from?”

| Current path / subsystem | Behavior contract | Native target |
|---|---|---|
| `core/cards/types.ts` | WorkingCard, identity, faces, artwork/back references | `src/domain/cards/model.*` |
| `core/cards/working-set.ts` | ordered Working Set operations | `src/domain/cards/WorkingSet.*` |
| `core/cards/working-card-editor.ts` | editorial mutations | `src/domain/cards/WorkingSetCommands.*` |
| `core/cards/editor-history.ts` | undo/redo | `src/application/HistoryStore.*` |
| `core/cards/physical-instance-order.ts` | stable physical copy sequence | `src/domain/cards/PhysicalOrder.*` |
| `core/cards/artwork-selection-scope.ts` | entry/copy/same-identity/bulk selection | `src/domain/cards/ArtworkSelectionScope.*` |
| `core/cards/back-selection.ts` | effective physical back rules | `src/domain/cards/BackSelection.*` |
| `core/cards/identity-*.ts`, fuzzy matcher | identity resolution policy | `src/domain/cards/identity/*` |
| `import-engine/*` | universal import | `src/import/*` |
| `import-engine/urls/*` | URL adapters | `src/import/url/*` |
| `providers/scryfall/*` | raw Scryfall transport/mapping/rate limit | `src/providers/scryfall/*` |
| `artwork/scryfall-provider.ts` | Scryfall artwork lifecycle | `src/providers/scryfall/ScryfallArtworkProvider.*` |
| `artwork/mpc-provider.ts` | MPC artwork lifecycle | `src/providers/mpc/MpcArtworkProvider.*` |
| `artwork/local-provider.ts` | local upload artwork | `src/providers/local/LocalArtworkProvider.*` |
| `artwork/catalog.ts` | aggregate catalog | `src/application/ArtworkCatalogService.*` |
| `artwork/mpc-ranking.ts` | MPC ordering | `src/providers/mpc/MpcRanking.*` |
| `artwork/mpc-request-coalescer.ts` | in-flight dedupe | `src/infrastructure/network/RequestCoalescer.*` |
| `artwork/storage/metadata-cache.ts` | provider metadata cache | `src/storage/artwork/MetadataRepository.*` |
| `artwork/storage/original-store.ts` | immutable originals | `src/storage/artwork/OriginalStore.*` |
| `artwork/storage/thumbnail-store.ts` | thumbnails | `src/storage/artwork/ThumbnailStore.*` |
| `artwork/storage/display-store.ts` | display derivatives | `src/storage/artwork/DisplayStore.*` |
| `artwork/effective-dpi.ts` | effective DPI | `src/domain/artwork/EffectiveDpi.*` |
| `image-engine/bleed/*` | edge extension / rounded corners / cache | `src/image/bleed/*` |
| `core/units/*` | physical unit conversion | `src/domain/geometry/Units.*` |
| `core/geometry/placement.ts` | single-page geometry | `src/domain/geometry/Placement.*` |
| `core/geometry/page-placement.ts` | canonical page/grid planning | `src/layout/CanonicalPrintPlan.*` |
| `core/geometry/template-layout.ts` | generic template layout | `src/layout/LayoutTemplate.*` |
| `core/geometry/cut-guides.ts` | printed guide geometry | `src/pdf/PrintedGuideGeometry.*` |
| `core/duplex/*` | page pairing/reflection | `src/domain/duplex/*` |
| `core/calibration/*` | calibration model/solver/transform | `src/domain/calibration/*` |
| `persistence/projects/*` | project DB, serializer, repository/recovery | `src/storage/projects/*` |
| `persistence/printer-profiles/*` | printer profile storage | `src/storage/calibration/*` |
| `persistence/back-library/*` | reusable backs | `src/storage/backs/*` |
| `persistence/templates/*` | generic template records | `src/storage/templates/*` |
| `services/card-workbench.ts` | use-case coordination | split among native application controllers |
| `services/card-export.ts` | preflight + original resolution + print plan + export | `src/application/ExportController.*` + `src/pdf/*` |
| `services/preview-bleed.ts` | preview derivative acquisition | `src/application/PreviewService.*` |
| `services/back-library.ts` | back asset use cases | `src/application/BackLibraryService.*` |
| `services/project-api.ts` | Project use cases behind HTTP | `src/application/ProjectController.*` directly |
| `services/printer-profile-api.ts` | calibration profile use cases | `src/application/CalibrationController.*` |
| `pdf-engine/document/*` | final fidelity writer | `src/pdf/LosslessPdfEngine.*` |
| `src/app/card-identity-workbench.tsx` | main card/workbench UI orchestration | QML models + `WorkingSetController` |
| `src/app/artwork-picker-dialog.tsx` | Picker dialog | `app/qml/picker/ArtworkPicker.qml` |
| `src/app/artwork-candidate-grid.tsx` | gallery/search/sort/windowing | QML GridView + C++ proxy/list model |
| `src/app/artwork-quality-hydration.ts` | visible-first quality jobs | `src/application/ArtworkQualityScheduler.*` |
| `src/app/registration-layout-preview.tsx` | live compositor | `app/qml/compositor/*` + `src/compositor/*` |
| `src/app/compositor-zoom.ts` | zoom semantics | `src/compositor/ViewportController.*` |
| `src/app/compositor-pointer-drag.ts` | drag thresholds/state | native pointer/drag controller |
| `src/app/project-*.ts*` | Project UI/session/autosave/recovery | QML project UI + native ProjectSession |
| `src/app/project-settings-controls.tsx` | print/project settings UI | `app/qml/settings/*` |
| `src/app/printer-calibration-panel.tsx` | calibration UI | `app/qml/calibration/*` |
| `src/app/back-library-controls.tsx` | back library UI | `app/qml/cards/BackLibrary.qml` |
| `src/app/template-library-panel.tsx` | generic + Silhouette template UI | generic layout only initially; Silhouette DEFER |
| `src/app/api/*` | browser/server transport boundary | removed; direct in-process application services |
| `tests/core/*` | domain contracts | native unit tests |
| `tests/import-engine/*` | import contracts | native golden/unit tests |
| `tests/artwork/*`, `tests/providers/*` | provider/cache contracts | native integration tests |
| `tests/app/*` | interaction/accessibility | QML/Qt Quick interaction tests |
| `tests/pdf-engine/*` | PDF fidelity | native PDF object/sample fidelity tests |
| `tests/persistence/*` | durable state | SQLite integration/migration tests |
| `tests/performance/*` | performance budgets | native benchmark suite |

## Deferred traceability: plotter

These are intentionally not assigned to an initial native implementation:

| Current path | Status |
|---|---|
| `core/cut/*` | DEFER |
| `services/cut-geometry/*` | DEFER |
| `services/cut-api.ts` | DEFER |
| `src/app/api/cut/*` | DEFER |
| Silhouette-specific template code/metadata | DEFER |
| SVG/DXF cutter export | DEFER |
| cutter registration/reserved-zone logic | DEFER |

If plotter support returns later, it must consume `CanonicalPrintPlan` rather than introducing a parallel layout engine.
