# Native rewrite quality contracts

These are migration gates, not suggestions.

## Q1 — Physical geometry

- Millimeters are canonical.
- Magic Standard trim is exactly 63.5 x 88.9 mm.
- Page/card orientation, margins, gaps and layout geometry are deterministic.
- Partial final pages cannot recenter or mutate the canonical grid.
- Reordering changes assignments, not physical rules.
- PDF point conversion happens only at the output boundary.

## Q2 — Source media

- Original files are immutable.
- A preview/thumbnail can never replace an original in export.
- Stable IDs/hashes, not transient URLs/private paths, are persisted.
- File extension alone never establishes image validity.
- Unsupported formats fail explicitly.

## Q3 — PDF fidelity

Unprocessed output must preserve:

- JPEG DCT source stream byte-for-byte;
- PNG raster samples and alpha without JPEG conversion;
- supported 16-bit PNG sample precision;
- supported SVG as vector content.

Forbidden unless explicitly selected by a future user feature:

- downsampling;
- lossy recompression;
- full-page rasterization;
- silent SVG raster fallback;
- thumbnail substitution.

## Q4 — Bleed

- bleed exists only outside trim;
- immediate border pixels are extended;
- no inner-band heuristic;
- no AI/inpainting;
- trim is pixel-identical when rounded corners are off;
- four corners join deterministically;
- zero bleed is passthrough;
- preview and export share the same derived result;
- rounded corners are separate and optional.

## Q5 — DFC and backs

- DFC front/back are two real faces of one identity.
- A simple-card generic back is not a fake DFC face.
- Project Default, Back Library, provider manual back and None remain distinct.
- Bulk simple-back actions preserve DFCs.
- Manual locks are never silently replaced by provider refresh.
- Front/back duplex pairing follows the same physical instance.

## Q6 — Artwork selection

- identity != artwork;
- selection IDs are revalidated against real provider/domain candidates;
- face mismatch is rejected;
- identity mismatch is rejected;
- physical-copy selection preserves that exact PhysicalOrder instance;
- selection may split compact quantities without moving the chosen physical instance;
- applying an artwork does not have to close the Picker;
- originals are lazy and are not downloaded for the entire catalog.

## Q7 — Projects

- current project snapshots can be migrated;
- autosave cannot overwrite a newer revision;
- recovery stays separate until promoted;
- deleting a Project cannot delete shared immutable artwork;
- UI-only state does not enter the project snapshot;
- future unknown schema versions fail safely.

## Q8 — Compositor

- live compositor is not the PDF;
- live compositor and PDF share the canonical physical plan;
- compositor uses preview/display assets;
- PDF uses validated originals;
- zoom/display settings never alter export bytes/geometry;
- selection, HUD and drag state are not persisted unless they represent a real editorial change.

## Q9 — Duplex and calibration

- page pairing is deterministic for long-edge and short-edge modes;
- skipped slots stay structurally paired;
- printer calibration wraps the correct physical content at the defined transform stage;
- side-specific offsets/rotation/scale/skew remain independent;
- calibration preview and export use the same numeric profile.

## Q10 — Performance without quality loss

Optimization may change scheduling, caching and rendering strategy. It may not weaken Q1–Q9.

Initial native performance targets must be measured on representative datasets and recorded before declaring parity. At minimum measure:

- cold start;
- warm start;
- Project open;
- first useful Picker content;
- first 8 thumbnails;
- catalog scrolling;
- compositor pan/zoom/reorder;
- 100/250/500 physical-card planning;
- PDF export;
- memory high-water mark;
- cache hit/miss behavior.

## Q11 — Plotter scope

A missing plotter feature is **not** a native parity failure during the initial rewrite because plotter support is intentionally deferred.

Printed PDF trim/external guides, printer calibration and duplex are still parity requirements.
