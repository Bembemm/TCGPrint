# ADR 0014: Canonical SVG/DXF cut geometry and export

- Status: Implemented in software; physical cut validation pending
- Date: 2026-10-01
- Related: ADR 0002, 0004, 0009, 0010, 0012, 0013; Implementation Plan Phase 11

## Context

Phase 11 needs one measured cut geometry for parsing, validation, preview, layout synchronization, SVG output, and DXF output. Template artwork, print guides, registration marks, reserved zones, and cut paths have different meanings. Template Library originals are immutable and `.studio3` remains opaque.

## Decision

### Canonical model

`core/cut` defines `CutGeometryMm` (model version 1). It uses millimeters, a top-left page origin, positive X to the right, and positive Y down. A source identity is either the exact `(templateId, version, packageHash, fileId, fileHash)` tuple or an explicit Project ID/revision for manual layout geometry. Pages and paths carry finite physical bounds and stable IDs. Paths contain connected line, quadratic, cubic, or parameterized ellipse-arc segments plus a `closed` flag; internal geometry is never stored as SVG path text. Page dimensions are limited to 2000 mm, and canonical geometry is limited to 2048 paths and 20,000 segments.

Internal synchronization and SVG serialization use a 0.000001 mm numeric tolerance. This is a software arithmetic and serialization tolerance, not a printer or cutter tolerance.

### SVG input

The parser reuses the existing safe XML parser and accepts only geometry. Supported elements are `g`, `path`, `line`, `polyline`, `polygon`, `rect`, `circle`, and `ellipse`. Rounded `rect` corners become ellipse arcs. Path commands are `M/m`, `L/l`, `H/h`, `V/v`, `Z/z`, `C/c`, `S/s`, `Q/q`, `T/t`, and `A/a`; malformed or incomplete paths fail as malformed input. Cubic, quadratic, and elliptical curves are preserved in the canonical model.

Supported transforms are `matrix`, `translate`, `scale`, and `rotate` on the root, groups, and geometry. Transform lists compose in document order and are applied before bounds validation. The outer `<svg>` transform is applied outside the `viewBox` mapping; its translation is measured in parent CSS px and converted at 96 dpi. Skew, CSS transforms, and unknown transform functions fail as unsupported.

SVG root `width` and `height` must be physically determinable and must match the exact template page. `mm`, `cm`, `in`, `pt`, `pc`, and `px` are supported; unitless physical lengths follow CSS/SVG pixel rules at 96 dpi. A `viewBox` maps user coordinates to the physical viewport; `preserveAspectRatio` supports `none` and standard `xMin/xMid/xMax` + `YMin/YMid/YMax` alignment with `meet` or `slice`. Without a `viewBox`, user coordinates use CSS px at 96 dpi. Percent dimensions, missing physical dimensions, invalid aspect-ratio syntax, and a physical-size mismatch fail; no scale is guessed. The 96 dpi conversion follows [W3C SVG coordinate and unit rules](https://www.w3.org/TR/SVG/coords.html).

Scripts, event handlers, stylesheets, style attributes, external references, images, `foreignObject`, non-geometry elements, non-whitespace text, DTDs, and external entities are not interpreted. An unsupported element or attribute blocks the whole SVG rather than dropping geometry.

### DXF input

The bounded ASCII DXF parser accepts `LINE`, `LWPOLYLINE`, 2D `POLYLINE` with `VERTEX`/`SEQEND`, `ARC`, `CIRCLE`, and planar `ELLIPSE` in the model-space `ENTITIES` section. Polyline bulges become canonical arcs. It parses `HEADER`, `TABLES`, and `ENTITIES`; `CLASSES`, `BLOCKS`, `OBJECTS`, and `THUMBNAILIMAGE` are ignored as bounded non-geometric structures under the global byte/pair/line limits. In `TABLES`, it accepts the standard `APPID`, `BLOCK_RECORD`, `DIMSTYLE`, `LAYER`, `LTYPE`, `STYLE`, `UCS`, `VIEW`, and `VPORT` tables; only `LAYER` is interpreted, and each allowlisted table's records must match its table type. Hidden/frozen `LAYER` state is still enforced. `INSERT` and every unsupported/unknown `ENTITIES` record fail, so ignored `BLOCKS` are never expanded or used to produce a partial cut. Unknown/custom sections or tables remain unsupported. Nonzero widths/thickness, hidden or frozen layers, non-default extrusion, paper-space/non-model-layout entities, curve-fit vertices, 3D/polyface geometry, splines, binary DXF, and malformed/truncated structures fail explicitly. When no `LAYER` table is present, only the default layer `0` is accepted because another layer's visibility cannot be verified. A parsed open line or arc is valid geometry, but card-layout synchronization requires one closed trim path for every template slot, so open geometry cannot pass card cut export.

DXF `$INSUNITS` codes 1–24 follow Autodesk's documented unit table and are converted to mm. Missing or unitless `$INSUNITS` requires the saved explicit Project override (`mm`, `cm`, `m`, `in`, `ft`, or `yd`); a present but malformed `$INSUNITS` declaration is rejected even when an override exists. A conflicting override fails. WCS XY is mapped from CAD bottom-left/Y-up to page top-left/Y-down using the selected physical page height; coordinates are not scaled, recentered, or guessed. `$INSUNITS` mapping follows [Autodesk's DXF header reference](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-DXF/files/GUID-A85E8E67-27CD-4C59-BE61-4DC9FADBE74A.htm).

### Bounds and parser limits

Both parsers validate finite coordinates, page containment, and bounded physical dimensions. SVG limits are 8 MiB, 50,000 XML elements, depth 32, 2,048 paths, 20,000 segments, 64 KiB per path/points string, 256 combined root/group/element transforms, and 1,000,000 absolute user-coordinate units before physical page containment. DXF limits are 8 MiB, 500,000 code/value pairs, 4,096 characters per line, 2,048 entities, and 20,000 vertices per polyline; canonical output adds the 2,048 path / 20,000 segment bounds. XML declarations are handled by the shared secure XML reader. API request bodies for cut preview/export are limited to 2 KiB and carry only an opaque Project ID and expected revision.

### Exact source selection and immutable originals

No SVG/DXF is selected automatically. The user selects a file explicitly from the exact Template Library version. If a version has multiple vector files, the selected file ID and file SHA-256 are saved in Project settings. DXF unit overrides are saved with that choice. The related Project template selection stores the exact template ID, version, and package hash. Every preview, PDF synchronization, and cut export rechecks the expected Project revision, exact package identity, selected file association, per-file hash, byte length, and immutable original bytes. Another template version is never substituted. Missing, corrupt, or mismatched originals block the operation.

Other SVG/DXF files from the same package are parsed and compared where possible. Up to eight alternatives are compared. For closed linear paths, comparison is invariant to a cyclic change of starting vertex and reversed winding; path IDs do not affect physical equivalence. Differences in page dimensions, path count, closure, bounds, or linear contours above 0.001 mm are reported as divergent. Curves whose parameterizations cannot be compared safely, paths with ambiguous duplicate bounds, and more than eight alternatives are explicitly marked not compared; the comparison does not turn an uncertain result into a divergence. Unreadable files are reported separately. The explicit Project choice remains authoritative. A DXF unit override applies only to its selected file; alternatives must declare their own units to be comparable. `.studio3` is stored and made available as its exact original only; its contents are never opened, parsed, or used to derive cut geometry.

### Layout, bleed, registration, and skips

An SVG/DXF physical page must match the immutable template's page dimensions. A custom-paper version needs versioned `templateGeometry` or explicit Project `templateGeometry`; current paper defaults are not used to guess its page size. If immutable `templateGeometry` exists, each closed source path's bounds must match its slot trim envelope, card dimensions, orientation, and page position within 0.000001 mm. The actual path contour, including rounded curves from the source, is preserved because slot metadata does not encode a cut contour. No scale, offset, trim, bleed, or page correction is applied. If metadata has no `templateGeometry`, the service derives one only from a complete orthogonal grid of closed paths whose bounds match the configured card size. Otherwise it blocks with a layout mismatch.

When there is no selected SVG/DXF, the existing Project layout may still produce manual cut output: one square-corner rectangle from each active PDF trim slot. This deterministic fallback does not infer rounded corners and preserves configured `templateGeometry`. It does not claim to reproduce any unavailable proprietary template path.

Cut paths follow trim. Bleed remains outside trim and never becomes a cut path. Registration marks are generated by ADR 0013 and stay separate from cut geometry; reserved zones stay separate too. Source paths are matched to stable row-major slots. Cut exports contain only active slots with assigned cards; skipped, reserved, and empty slots are omitted without renumbering or recentering. Preview displays each source path with its active/skipped/reserved/empty slot state.

`core/geometry/page-placement.ts` owns document pagination for the PDF engine, cut layout resolver, and sheet preview. It retains PDF card order and effective per-card bleed, reserves the same registration zones, applies the same margins/gaps/template geometry/skips/orientations, and emits one independent page-coordinate placement at a time. Cut preview returns an explicit ordered `pages` array with one-based page number and inclusive card ordinals; the legacy top-level geometry fields project page 1. For one-page Projects, exports retain their simple filenames and need no query. For multi-page Projects, `POST /api/cut/export/svg?page=N` and `/dxf?page=N` require an explicit 1-based page number and produce `tcgprint-cut-page-NN` filenames with the corresponding PDF-page header. Preview and export share each page's same `CutGeometryMm` and active slot assignment.

### Export and curve policy

SVG output is minimal deterministic XML with explicit physical `mm` dimensions, a matching `viewBox`, and vector paths. It contains no artwork, raster images, scripts, remote resources, or private application metadata. Coordinates and radii use six decimal places; ellipse rotation uses twelve decimal places so even large page-contained ellipses round-trip within the 0.000001 mm software tolerance.

DXF output is deterministic ASCII AC1015 with `$INSUNITS=4` (millimeters), page extents, a `CUT` layer, and closed/open `LWPOLYLINE` entities. Lines remain linear. Curves are deterministically flattened to chords with a fixed 0.005 mm maximum mathematical flatness bound, at most 4,096 subdivisions per arc, recursion depth at most 20 for Béziers, and at most 20,000 vertices per path. Six-decimal serialization adds at most 0.0000005 mm per coordinate. SVG round trips preserve curve segments; DXF round trips preserve bounds and coordinates within the chord and serialization bounds. These are software tolerances only.

Preview calls `cutPathToSvgD` on the returned canonical geometry. SVG export, DXF export, validation, and preview all consume `CutGeometryMm`; there are no independent path parsers or geometry engines in React. The existing PDF engine remains responsible for PDF output. When a cut file is selected, PDF export requires a clean autosaved Project revision, revalidates the exact cut source and layout, checks relevant saved settings and card ordering, and supplies derived `templateGeometry` to the existing PDF placement engine. Tests compare PDF trim coordinates numerically with canonical active cut bounds. JPEG passthrough, PNG handling, vector cut guides, and vector registration are unchanged.

### Project compatibility and API

Project logical schema version 3 adds optional exact cut-source selection and DXF unit override. It is stored in the existing JSON snapshot; no SQLite migration is needed. Schema-1 and schema-2 Projects still read using existing defaults and migrate in memory to schema 3 on save. Autosave, reopen, duplicate, recovery, recovery copy, and promotion retain the selected file/hash/units alongside the exact relational template selection. No filesystem path is persisted.

`POST /api/cut/preview`, `/api/cut/export/svg`, and `/api/cut/export/dxf` receive only Project ID and expected revision in their body. Multi-page cut exports additionally select a page through one `page` query parameter. `/api/cards/export` checks the expected revision, saved layout settings, and card order for every Project-based export; when a cut source is selected, it also performs the exact source integrity and layout checks. Responses expose geometry and template identity, never local paths or original file blobs inside JSON. SVG/DXF downloads are direct static attachments.

### Physical validation status

Software fixtures cover parser behavior, bounds, skips, SVG/DXF round trips, API exports, and numeric PDF trim synchronization. The review manifest records the byte length and SHA-256 for its input and each PDF/SVG/DXF artifact. They are not a real Template Library package or a physical Silhouette test. No machine test is claimed. PDF/SVG/DXF and a measurement procedure are provided under `artifacts/phase-11-cut-validation/` for later physical review. Physical compatibility, machine recognition, and real cut alignment remain pending.

## Alternatives considered

- Keep SVG path strings as the shared model. Rejected because it would make DXF parsing, preview, bounds, and layout comparison depend on SVG syntax.
- Silently prefer SVG or DXF when both exist. Rejected because package files can diverge; the user selects one explicitly and alternatives are compared/reported.
- Ignore unsupported entities and export the remaining DXF. Rejected because it can produce an incomplete cut as if it were valid.
- Scale source paths to fit PDF layout. Rejected because that hides physical disagreement and would also alter trim, bleed, or page placement.
- Export every template slot regardless of Project state. Rejected because skipped, reserved, and empty slots must not become active cuts.
- Export registration marks as cut paths. Rejected because registration and cutting are separate geometry domains.
- Reverse engineer `.studio3`. Rejected; it remains opaque and unchanged.

## References

- [W3C SVG coordinate systems, transforms, and units](https://www.w3.org/TR/SVG/coords.html)
- [Autodesk DXF `$INSUNITS` reference](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-DXF/files/GUID-A85E8E67-27CD-4C59-BE61-4DC9FADBE74A.htm)
- [ADR 0002: PDF fidelity spike](0002-pdf-fidelity-spike.md)
- [ADR 0004: cut guide geometry](0004-cut-guide-geometry.md)
- [ADR 0009: cut guide geometry](0009-cut-guide-geometry.md)
- [ADR 0010: Project persistence](0010-project-persistence.md)
- [ADR 0012: Silhouette Template Library](0012-silhouette-template-library.md)
- [ADR 0013: Independent registration geometry](0013-registration-geometry.md)
