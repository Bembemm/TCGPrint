# Current TCGPrint system inventory

Baseline: `chatgpt/selection-picker-visual-rescue@7f23087`.

Status vocabulary:

- **PORT** — must exist in the native application.
- **PORT/REDESIGN** — preserve behavior but replace the implementation with a native design.
- **COMPAT** — preserve/read the existing persisted contract so current user data can migrate.
- **DEFER** — intentionally not part of the first native application.
- **REFERENCE** — keep as verification material, not production code.

## 1. Application shell and interaction

| Current capability | Current ownership/examples | Native mapping | Status |
|---|---|---|---|
| Main workspace with persistent central compositor and right-side tools | `workspace-shell.tsx`, `workspace-sidebar.tsx`, `page.tsx` | QML `ApplicationWindow`, workspace shell and dock/sidebar components | PORT/REDESIGN |
| Project/header controls | `project-header.tsx`, `workspace-project-header-context.tsx` | QML project header backed by `ProjectController` | PORT |
| Section navigation for Cards, Project/Settings, Export and secondary tools | M4 shell + redesign branch | QML navigation state, no HTTP boundary | PORT/REDESIGN |
| Responsive/mobile behavior | CSS + workspace components | responsive QML layouts; desktop-first Windows release, touch remains supported | PORT |
| Keyboard, touch and accessibility semantics | interaction tests, focus traps, keyboard selection | QML focus scopes, Accessible attached properties, keyboard/touch actions | PORT |
| Modal/inert behavior and focus restoration | Picker/final proof | QML dialogs/overlays with explicit focus ownership | PORT |

## 2. Working Set, editing and history

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| WorkingCard canonical model | `core/cards/types.ts` | `domain/cards/WorkingCard` | PORT |
| Quantity, order, section, identity hints | WorkingCard/editor | typed C++ domain objects | PORT |
| Undo/redo editorial history | `editor-history.ts`, workbench reducer | command/snapshot history in `WorkingSetStore` | PORT/REDESIGN |
| Add/remove/duplicate/edit entries | working-card editor/workbench | native commands | PORT |
| Physical instance ordering independent of compact quantity | `physical-instance-order.ts` | `PhysicalOrder` domain model with stable instance IDs | PORT |
| Reconciliation when quantity changes | M7 domain logic | pure C++ invariant-tested functions | PORT |
| 500 physical-card safety/export limit | domain/API/export validation | central native limit validated at edit and export boundaries | PORT |

## 3. Universal import engine

| Input/capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| Content detection | `import-engine/detection.ts` | `ImportDetector` | PORT |
| Plain text/decklists | text importer | C++ text parser | PORT |
| CSV | csv importer | C++ CSV parser + mapping model | PORT |
| JSON / structured data | json importer | JSON parser + schema adapters | PORT |
| XML / MPC order XML | xml importer | `QXmlStreamReader`-based import | PORT |
| Raster/vector image imports | image importer | native file inspection/validation | PORT |
| ZIP/batch import | `zip.ts`, batch tests | native archive layer | PORT |
| Direct-file URLs | URL transport/direct-file | network import service | PORT |
| Archidekt | URL adapter | native adapter | PORT |
| CubeCobra | URL adapter | native adapter | PORT |
| mtg.wtf | URL adapter | native adapter | PORT |
| MTGTop8 | URL adapter | native adapter | PORT |
| Scryfall URLs | URL adapter | native adapter | PORT |
| generic deck/JSON export adapters | URL adapters | native adapters | PORT |
| Import report, warnings and ambiguity flow | import engine + workspace UI | structured `ImportReport` model surfaced in QML | PORT |
| Progress/cancellation | current service/UI contracts | native async job with cancellation token and progress signal | PORT/REDESIGN |

## 4. Identity and card semantics

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| Identity separate from artwork | `core/cards`, ADR 0005 | strict `CardIdentity` / `ArtworkCandidate` separation | PORT |
| Scryfall identity resolution | identity resolver + Scryfall client | `ScryfallIdentityProvider` | PORT |
| Custom card without forced identity discovery | Part 2 M1 | explicit custom identity state | PORT |
| filename/name/fuzzy matching support | resolver/fuzzy matcher | pure C++ matcher | PORT |
| safe identity metadata allowlist | `safe-identity-metadata.ts` | versioned DTO validator | PORT |
| DFC semantic detection and named front/back faces | cards/back selection | native DFC policy | PORT |
| face-specific artwork selection | selectedArtworkByFace | typed face map | PORT |
| manual physical back distinct from DFC back | back-selection model | dedicated back variant type | PORT |
| legacy compatibility rules | parser/serializer/export | project migration layer | COMPAT |

## 5. Artwork providers, catalog and storage

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| Aggregated Scryfall/MPC/upload catalog | `artwork/catalog.ts`, CardWorkbench | `ArtworkCatalogService` | PORT |
| Scryfall provider | `artwork/scryfall-provider.ts` | C++ provider over Qt Network | PORT |
| MPC Autofill provider | `artwork/mpc-provider.ts` | C++ provider over Qt Network | PORT |
| Local/upload provider | `local-provider.ts` | native filesystem provider | PORT |
| provider health/degraded states | artwork/provider contracts | typed provider status | PORT |
| metadata cache with TTL/provenance | artwork storage | SQLite metadata store | PORT |
| immutable originals | original store | content-addressed local original store | PORT |
| thumbnails | thumbnail store | persistent thumbnail cache | PORT |
| display derivatives | display store | persistent preview/display cache | PORT |
| image validation before export | image validation | native codec/header validation | PORT |
| effective DPI | `effective-dpi.ts` | native physical-size/DPI calculator | PORT |
| MPC cache keys/ranking/revalidation/diagnostics | MPC modules | native provider submodules | PORT |
| coalesced duplicate requests | request coalescer | shared in-flight request registry | PORT |
| provider ranking/filtering/search | catalog/grid | model-side sorting/filtering, not QML-only | PORT |
| progressive Scryfall first-page/background completion | redesign branch | staged async catalog result stream | PORT/REDESIGN |
| progressive MPC population | redesign branch | streamed/batched result model | PORT/REDESIGN |
| first thumbnails prioritized | candidate grid | priority job queue | PORT/REDESIGN |
| originals fetched/prepared only when required | providers + prepare API | lazy original acquisition | PORT |

## 6. Artwork Picker

| Capability | Current behavior | Native mapping | Status |
|---|---|---|---|
| Gallery picker over current card context | M6/redesign | dedicated QML Picker overlay | PORT |
| Picker remains open after applying an artwork | redesign branch | mutation updates current state without closing dialog | PORT |
| HQ current-art preview | redesign | async high-quality preview surface | PORT |
| provider filters | M6 | proxy/filter model | PORT |
| search and sort over loaded logical catalog | M6 | native proxy model | PORT |
| Scryfall/MPC/custom choices for identified front/DFC faces | M6 | same domain policy | PORT |
| simple-card Back semantic flow | M6 | Back Library / Project Default / None / validated MPC CARDBACK | PORT |
| DFC front/back real-face tabs | M6 | two semantic face contexts | PORT |
| apply to entry | scope domain | command | PORT |
| apply to one physical copy with split | scope domain | command preserving PhysicalOrder instance | PORT |
| apply to same identity | scope domain | command | PORT |
| bulk simple-card back while preserving DFCs | M6 | command + impact preview | PORT |
| visible-page quality hydration | M3/M6 | prioritized background metadata/original inspection | PORT |
| catalog pagination/windowing | candidate grid | QML virtualized GridView + model paging | PORT/REDESIGN |
| no thumbnail/blob/temporary URL persisted as selection | M6 | stable IDs only | PORT |

## 7. Back Library and physical backs

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| Project Default Back | project settings | immutable asset reference | PORT |
| Back Library upload/validation | back library service/repository | native content-addressed asset library | PORT |
| retired assets remain resolvable for old Projects | ADR 0015 | tombstone/selectability semantics | PORT |
| None/blank back | back mode | explicit variant | PORT |
| manual provider-backed physical back | WorkingCard | explicit variant | PORT |
| DFC auto back | DFC policy | explicit variant | PORT |
| shared MPC order cardback | MPC import | distinct project/import reference | PORT |
| missing-back export policy/preflight | export | native preflight | PORT |

## 8. Image engine

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| originals remain immutable | ADR 0008 | immutable source store | PORT |
| bleed is only outside trim | `image-engine/bleed` | `EdgeExtensionEngine` | PORT |
| immediate outer row/column pixel replication | ADR 0008 | native libvips/custom kernel implementation | PORT |
| deterministic four-corner extension | ADR 0008 | native implementation | PORT |
| no AI/inpainting/internal sampling | ADR 0008 | invariant | PORT |
| zero-bleed passthrough | ADR 0008 | no derived image when no pixel change | PORT |
| optional rounded corners separate from bleed | bleed policy/raster | `RoundedCornerMask` | PORT |
| Magic Standard 3.175 mm corner radius default | card format | physical format definition | PORT |
| alpha preservation | image engine/tests | native alpha-safe path | PORT |
| preview/export derivative parity | service/tests | shared derivation service | PORT |
| hash/version/config-based derivative cache | bleed cache | native content-addressed cache | PORT |
| no SVG raster fallback for unsupported transform | ADR | explicit rejection | PORT |
| color-management/ICC path | open in original plan | lcms2/libvips-backed managed pipeline, gated before enabling | PORT/REDESIGN |

## 9. Physical units, geometry and layout

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| millimeters canonical until output boundary | `core/units`, geometry | strong `Millimeters` value type | PORT |
| Magic Standard 63.5 x 88.9 mm | card format | immutable physical format | PORT |
| paper formats/orientation | geometry/templates | typed `PaperFormat` | PORT |
| card orientation | PDF/layout settings | geometry model | PORT |
| margins | placement | geometry model | PORT |
| horizontal/vertical gaps | placement | geometry model | PORT |
| automatic grid | page placement | native canonical planner | PORT |
| explicit rows/columns | placement | planner constraints | PORT |
| skipped slots | placement | canonical slot mask | PORT |
| per-card bleed envelopes | M5 canonical plan | native planner | PORT |
| stable geometry across pages/partial final page | M5 | invariant + golden tests | PORT |
| physical order mapped to slots before pagination | M7 | canonical planner input | PORT |
| generic template-based physical layout | template layout geometry | preserve only if independent from cutter-specific metadata | PORT |
| cutter-reserved zones/registration masks | cut/registration/Silhouette integration | not in first native rewrite | DEFER |

## 10. Live compositor

| Capability | Current behavior | Native mapping | Status |
|---|---|---|---|
| persistent live compositor, not a generated PDF | M5 | GPU-backed QML/scene-graph viewer | PORT/REDESIGN |
| same canonical physical plan as export | M5 | shared C++ `PrintPlan` | PORT |
| preview thumbnails/derivatives only | M5 | texture cache; never final-PDF source | PORT |
| front/back side switch keeps physical instance | M5/M7 | compositor state | PORT |
| page navigation | M5 | compositor state | PORT |
| Fit Page / Fit Width / physical 100% / manual zoom | M5 | native viewport controller | PORT |
| Artwork/Bleed/Trim/Cut guide/Margins/Calibration layers | M5 | GPU overlay layers | PORT |
| plotter path/registration/reserved-zone layers | M5 legacy | omitted initially | DEFER |
| selected physical instance | M5/M7 | stable instance ID UI state | PORT |
| click/tap/keyboard selection | M5/M7 | native pointer/key handlers | PORT |
| context HUD/menu | M7/redesign | QML contextual popup | PORT |
| drag reorder across slots/pages | M7 | native drag + domain command | PORT |
| skipped slots reject drop | M7 | planner-aware hit target | PORT |
| front/back paired movement | M7 | one PhysicalOrder, duplex mapping | PORT |
| mobile/touch fallback controls | M7/redesign | touch-accessible explicit actions | PORT |
| compositor never feeds pixels to PDF export | M5 | architecture boundary | PORT |

## 11. PDF fidelity and export

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| final PDF independent of compositor rasterization | PDF engine/M5 | `LosslessPdfEngine` | PORT |
| JPEG original DCT bytes preserved when unprocessed | ADR 0002 | QPDF image XObject with source DCT stream | PORT |
| PNG 8-bit sample/alpha preservation | PDF engine | exact sample + Flate/SMask path | PORT |
| PNG 16-bit sample/alpha preservation incl. Adam7/tRNS | custom current engine | dedicated native PNG16 parser/resource path | PORT |
| strict SVG vector subset | current PDF engine | strict XML validation + vector PDF operators; reject unsupported | PORT |
| no silent SVG rasterization | ADR 0002 | invariant | PORT |
| exact physical page/card sizing | PDF engine | mm -> points only at PDF boundary | PORT |
| no destructive optimization/downsampling/recompression | ADR 0002 | invariant | PORT |
| printed trim/external cut guides | PDF engine / geometry | vector PDF overlays | PORT |
| plotter SVG/DXF cut file export | cut services | omitted | DEFER |
| registration geometry specific to cutter | registration/cut stack | omitted | DEFER |
| final-PDF proof/viewer | M5 | generate final bytes then render with Qt PDF/PDFium | PORT |
| separated front/back PDF result | export | two PDFs + optional archive | PORT |
| ZIP packaging of separate outputs | separate-pdf archive | native archive service | PORT |
| preflight before original reads/export | card export | native `ExportPreflight` | PORT |
| effective DPI/quality warnings | export/workbench | native diagnostics | PORT |

## 12. Duplex

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| front only | export | export mode | PORT |
| back only | export | export mode | PORT |
| separate front/back | export | export mode | PORT |
| interleaved duplex | duplex engine | export mode | PORT |
| long-edge pairing/reflection | `core/duplex` | native `DuplexPlanner` | PORT |
| short-edge pairing/reflection | `core/duplex` | native `DuplexPlanner` | PORT |
| skipped slots stay paired | duplex/placement | invariant | PORT |
| DFC uses actual back face | back policy/export | invariant | PORT |
| simple card uses effective physical back | back policy | invariant | PORT |
| same reordered physical sequence drives both sides | M7 | invariant | PORT |

## 13. Printer calibration

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| printer profiles | persistence/services | `PrinterProfileRepository` | PORT |
| versioned profile snapshots | project/profile model | immutable referenced profile version | PORT |
| side-specific calibration | `core/calibration` | `SideCalibration` | PORT |
| X/Y offset | calibration | double-precision affine transform | PORT |
| rotation | calibration | affine transform | PORT |
| independent X/Y scale | calibration | affine transform | PORT |
| skew/shear | calibration | affine transform | PORT |
| calibration sheet | service | native PDF calibration document | PORT |
| measurement/solver flow | calibration | native solver | PORT |
| verification sheet/result | calibration | native workflow | PORT |
| nominal vs calibrated compositor representation | M5 | compositor overlay/mode | PORT |
| apply transform at correct PDF stage | PDF engine | explicit transform order | PORT |

## 14. Projects, persistence and recovery

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| separate `projects.sqlite` and artwork cache DB | ADR 0010 | retain separation | PORT |
| versioned JSON Project snapshot inside SQLite | serializer | native DTO + migration layer | PORT |
| read legacy snapshot versions through current v6 | serializer/M7 | migration compatibility tests | COMPAT |
| Project revision/CAS conflict detection | repository | transactional repository | PORT |
| autosave | project autosave modules | background debounced save job | PORT |
| recovery candidate separate from canonical snapshot | ADR 0010 | transactional recovery record | PORT |
| recovery promote/discard/copy | project API | native commands | PORT |
| duplicate Project | repository/API | native command | PORT |
| delete Project without deleting shared artwork | repository | invariant | PORT |
| 16 MiB snapshot limit | ADR 0010 | validated limit | PORT |
| transient UI state excluded from Project | serializer | invariant | PORT |
| stable artwork/back references, not private paths/blobs | serializer | invariant | PORT |
| Project list/session/open/close flows | project UI/session | native `ProjectSession` | PORT |

## 15. Templates

| Capability | Current ownership | Native mapping | Status |
|---|---|---|---|
| generic physical layout geometry | `core/geometry/template-layout.ts` | native `LayoutTemplate` if cutter-independent | PORT |
| template validation/versioning/file store | `templates/*`, persistence | retain only generic layout use cases initially | PORT/REDESIGN |
| Silhouette-specific template library | ADR 0012/Phase 9 | omitted initially | DEFER |
| `.studio3` concerns | implementation plan | omitted | DEFER |
| cutter cut geometry inside templates | cut/template services | omitted | DEFER |

## 16. Performance architecture

| Current capability | Native mapping | Status |
|---|---|---|
| hash-based cache | content-addressed native cache | PORT |
| metadata/preview/original separation | separate cache tiers | PORT |
| request coalescing | in-flight registry | PORT |
| progressive provider population | streamed model updates | PORT |
| visible-first thumbnail/quality work | priority task queue | PORT |
| limited concurrency for expensive hydration | dedicated QThreadPool priorities | PORT/REDESIGN |
| stale response suppression | generation/request token | PORT |
| no full-catalog original download | lazy original fetch | PORT |
| large-data tests/benchmarks | native benchmark suite | PORT |
| cancellation/progress for heavy operations | stop token/job abstraction | PORT/REDESIGN |
| GPU compositor | Qt Quick scene graph with texture cache | NEW NATIVE IMPLEMENTATION |

## 17. Diagnostics and failure behavior

| Capability | Native mapping | Status |
|---|---|---|
| explicit provider unavailable/degraded state | typed status + UI badge | PORT |
| MPC diagnostics/revalidation | provider diagnostics service | PORT |
| file validation failures are explicit | typed domain errors | PORT |
| unsupported SVG fails instead of degrading silently | typed fidelity error | PORT |
| export preflight blocks invalid state | structured preflight report | PORT |
| logs/diagnostic reports | structured local log + exportable diagnostic bundle | PORT/REDESIGN |
| no provider failure erases valid other-provider candidates | catalog isolation | PORT |

## 18. Tests and evidence

| Current test area | Native replacement |
|---|---|
| cards/domain tests | pure C++ unit tests |
| import-engine tests/fixtures | native parser golden tests using same fixtures where license-safe |
| artwork/provider tests | mocked Qt Network integration tests |
| app interaction tests | Qt Quick Test / QML integration tests |
| PDF engine fidelity tests | byte/object-level PDF tests + image sample extraction |
| physical geometry tests | pure C++ property/golden tests |
| duplex tests | pure C++ pairing tests |
| persistence tests | temporary SQLite integration tests |
| calibration tests | numeric tolerance and generated-sheet tests |
| performance tests | benchmark executable and regression budgets |
| browser smoke | native Windows UI smoke |
| reference PDFs/artifacts | retained as behavioral comparison, regenerated only by explicit golden update |

## 19. Explicitly deferred plotter surface

The following current areas are recorded so they are not accidentally mistaken for missing work:

- `core/cut/*`
- `services/cut-geometry/*`
- `services/cut-api.ts`
- `src/app/api/cut/*`
- plotter-oriented portions of `cut-guide-controls.tsx`
- Silhouette template/cutter workflow
- SVG/DXF cutter export
- cutter-specific registration/reserved zones
- Phase 11 cut-validation artifacts
- ADRs 0004/0009/0012/0014 where they describe cutter integration

They may return in a later optional milestone after the native print workflow reaches parity and passes quality/performance gates.
