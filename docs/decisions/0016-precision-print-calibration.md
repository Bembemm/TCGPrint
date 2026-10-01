# ADR 0016: Precision print calibration

- Status: Accepted for Phase 13 implementation
- Date: 2026-10-01
- Related: ADR 0002 (PDF fidelity), ADR 0010 (Project persistence), ADR 0013 (registration), ADR 0014 (SVG/DXF cut export), ADR 0015 (duplex)

## Context

Nominal card layout, registration geometry, and cutter geometry are already shared across preview and export. A printer can still introduce repeatable physical translation, rotation, scale, or skew. That correction belongs to the final page-content transform, after the Phase 12 duplex pairing has produced each physical side. It must not change card geometry, image pixels, page dimensions, template identity, or nominal cut geometry.

## Decision

### Coordinate convention and precision

The persisted linear correction is an integer count of micrometers: `1 µm = 0.001 mm`. `offsetXUm > 0` means physically right; `offsetYUm > 0` means physically up. The existing layout and registration models remain top-left-origin, positive-Y-down millimeters. `core/calibration/coordinates.ts` owns explicit conversions between those frames. PDF calibration matrices use the PDF physical frame (positive X right, positive Y up); SVG preview matrices are derived by conjugating that matrix with the page-height Y reflection.

The shared bounds are deliberate printer-correction bounds, not arbitrary transforms:

| Parameter | Accepted range |
| --- | --- |
| X/Y offset | -10,000…+10,000 µm (-10…+10 mm) |
| rotation | -5…+5 degrees |
| scale X/Y | 0.98…1.02, finite and positive |
| skew X/Y | -1.5…+1.5 degrees |

Values outside those bounds fail with a typed `CalibrationError`. UI display precision never changes stored values. Linear text accepts either `.` or `,` as one decimal separator and at most three fractional digits; grouping separators and mixed decimal separators are rejected. Offsets convert to integer µm only at the input boundary.

### Canonical transform and matrix order

`createPrintCalibrationTransform(pageSizeMm, sideCalibration, side)` is the single pure transform API. The anchor is the center of the oriented physical page. In PDF coordinates, with column vectors, the transform is:

```text
M = T(offsetX, offsetY) · T(center) · R(rotation) · H(skewX, skewY) · S(scaleX, scaleY) · T(-center)
```

Points are therefore acted on from right to left: center-relative translation, scale, skew, rotation, center restoration, then visual X/Y translation. `R` is the standard counter-clockwise rotation in the PDF Y-up frame. `H = [[1, tan(skewX)], [tan(skewY), 1]]`. PDF/SVG affine tuples use `x'=a*x+c*y+e`, `y'=b*x+d*y+f`. Offsets are converted from µm to mm in core and from mm to points only at the PDF boundary. The transform exposes both its physical-frame matrix and its explicitly converted top-left/Y-down preview matrix, plus the side and anchor.

An identity calibration returns the exact identity matrix and is not emitted as a PDF CTM. Page width/height use the effective oriented paper size, so A4 landscape anchors at `(148.5, 105)` mm and portrait at `(105, 148.5)` mm.

### Duplex, registration, and cut geometry

The order is nominal layout → existing duplex slot reflection/artwork orientation → side calibration → PDF page content. `createDuplexPagePairing()` remains unchanged. Front and back each use their own calibration. A back-page visual `+Y` remains physically up after the selected Phase 12 flip because calibration matrices use the physical PDF frame after pairing.

The PDF engine brackets all printable page content (images, registration vectors, and cut guides) in one optional `q … cm … Q` graphics-state transform. It never changes MediaBox/CropBox and applies one transform per page, not once per card. Registration configuration, reserved zones, template geometry, trim, bleed, and artwork originals remain nominal. Registration marks are transformed with the printable page content; reserved zones remain layout constraints. SVG/DXF Cut Export and Template Library source IDs, versions, hashes, and paths remain nominal and do not consume calibration.

After transforming required printable bounds, content outside the physical page by more than 0.01 mm blocks export with `CALIBRATION_CONTENT_OUT_OF_BOUNDS`; content remaining inside but within 0.5 mm of an edge returns an explicit warning. Calibration never auto-scales content to fit.

### Printer profiles, immutable revisions, and compatibility

Profiles live in the existing Projects SQLite database, in `printer_profiles` and append-only `printer_profile_versions` tables (physical schema v5). Each revision stores its validated full profile JSON and SHA-256. The current revision is updated with compare-and-swap against the expected revision. Rename/recalibration creates a new immutable revision; duplicate creates a new profile ID and revision 1. Old revisions are retained and cannot be deleted through the library API.

Profile hash is SHA-256 of stable canonical JSON containing the profile ID, revision, paper identity/dimensions, orientation, duplex mode, side corrections, and bounded metadata. Profile import/export is JSON `{schemaVersion: 1, profile: <immutable revision>}`, at most 64 KiB, with strict fields and numeric validation. Unknown future schema versions, malformed hashes, paths, non-finite values, invalid µm integers, and incompatible parameter bounds fail explicitly.

Project logical schema v5 adds `printerProfileSelection` and `printerDuplexMode`. The selection embeds the exact profile ID, version, hash, and immutable profile snapshot used. This self-contained snapshot survives autosave, reopen, duplicate, recovery, recovery promotion/copy, and remains renderable if a library entry is retired or unavailable. Project v1–v4 reads normalize to no selected profile and identity calibration, preserving the former nominal PDF path. A profile update never mutates any Project snapshot; updating a Project to a newer version is an explicit selection action.

Compatibility checks compare paper name and base dimensions and page orientation. `front-only` may use the front calibration even if the profile's duplex mode differs. Any export containing backs requires exact `printerDuplexMode` agreement; duplex PDF additionally rejects a `single-sided` profile and requires the mode's long/short edge to match the Project pairing. Incompatible profiles are shown with reasons and cannot be applied silently. No override path is provided in Phase 13.

### Solver and measurement contract

Measurements are `delta/error = observed printed coordinate - nominal target coordinate`, in integer µm, with positive Y physically up. They are not absolute measured positions. Standard targets are the center and four page corners. Simple mode directly validates and packages X, Y, and rotation entered by the user.

Advanced mode fits an affine printer map from at least four unique, non-collinear target/error pairs using deterministic least squares in normalized page-center coordinates. The correction is the inverse fitted map. The solver decomposes it into rotation, positive independent scales, and X shear; Y shear remains zero because this decomposition is sufficient for any nonsingular 2×2 affine correction near identity. It returns measured-point residuals and mean/min/max magnitude without a pass/fail tolerance. Fewer than four valid points, duplicate points, non-finite inputs, near-zero geometry, an ill-conditioned fit (normalized QR condition estimate above 1e5), singular inversion, or a result outside calibration bounds returns a specific `CalibrationError`; unsupported parameters remain identity rather than being guessed.

### Calibration and verification sheets

Calibration and verification sheets are vector-only PDFs generated from bounded requests; no card artwork or client-supplied matrix is accepted. Sheets include a center cross, four corner targets, X/Y rulers and grid, 10/50/100 mm bars, rotation marks, `FRONT`/`BACK` identifiers, print-at-100% instructions, fit/shrink/borderless/driver-scaling warnings, and a diagram/text for the selected manual flip. Front and back use complementary crosses/rings with matching target IDs. Sheet metadata identifies session ID, draft profile ID, paper, orientation, duplex mode, side, and schema version. Verification sheets use the validated solved transform. Generating one changes status only to `verification-generated`; only recorded physical measurements can set `physically-verified`.

### Preview and export diagnostics

Preview offers nominal and calibrated rendering using the canonical transform's SVG matrix, including a front/back opacity overlay. Preview state/cache identity includes profile revision/hash, side, and effective correction. Export manifests/headers record profile ID/version/hash, the side, parameters, and matrix in bounded structured metadata; no artwork bytes, local paths, host IDs, or operating-system details are included. The Project revision remains the synchronization boundary, so export must use the same persisted calibration selection as preview.

### Physical validation boundary

Software tests and generated artifacts establish math, persistence, compatibility, PDF fidelity, and deterministic vector-sheet geometry only. They do not establish a printer's repeatability or a universal tolerance. A profile is never marked physically verified merely because a sheet was generated. No numeric physical pass/fail threshold is defined by this ADR.

## Consequences

- JPEG DCT streams, PNG samples, and supported SVG vectors continue through their existing embedding paths; a page CTM changes placement only.
- MediaBox/CropBox and nominal card/cut geometry remain invariant under printer calibration.
- Old Projects remain nominal until the user explicitly selects a profile.
- Updating one profile revision cannot alter existing exports or Projects.
- Physical printer validation remains a separate, user-measured gate.

## Alternatives considered

- Mutate layout/card placements per printer: rejected because it changes nominal geometry and duplicates correction logic across export, preview, registration, and duplex.
- Store only a profile ID in Project: rejected because recalibration would silently change old Projects.
- Apply calibration before duplex pairing: rejected because back offsets would be expressed in the wrong physical frame for some flips.
- Rasterize or resample a calibrated sheet: rejected because a page CTM preserves source fidelity and vectors.
- Calibrate SVG/DXF cut paths: rejected because printer compensation belongs to printed content while cutter geometry remains nominal.

## References

- [Implementation plan, Phase 13](../../IMPLEMENTATION_PLAN.md#fase-13--precision-print-calibration)
- [ADR 0002: PDF image fidelity and vector SVG](0002-pdf-fidelity-spike.md)
- [ADR 0010: Project persistence](0010-project-persistence.md)
- [ADR 0013: Independent registration geometry](0013-registration-geometry.md)
- [ADR 0014: Canonical SVG/DXF cut geometry and export](0014-svg-dxf-cut-export.md)
- [ADR 0015: Duplex backs and physical page pairing](0015-duplex.md)
