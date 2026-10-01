# Phase 11 cut export review fixture

This is a small software fixture for reviewing the same A4 layout in the PDF, SVG cut export, DXF cut export, and canonical millimeter geometry. It is not a real Silhouette template and does not establish physical machine compatibility.

## Exact fixture identity

- Template ID: `phase11-a4-cut-fixture`
- Version: `1`
- Package SHA-256: `6153c44c7faca945660edf5be5780b5abdaac878a73f53fac5d8f0168dbf6c93`
- Selected file ID: `phase11-layout-svg-v1`
- Source file SHA-256: `458a5e3814260eca6ee5b09dbcf880c8cc99368458cf49a3b28bad9caebd1c4b`
- Project fixture: `phase11-review-project`, revision `1`

These identifiers bind the generated review artifacts to the checked-in `source-layout.svg` bytes and fixture metadata in [manifest.json](manifest.json). The IDs are synthetic fixture IDs.

## Files and expected coordinates

| File | Contents |
| --- | --- |
| [source-layout.svg](source-layout.svg) | Two source card paths on a 210 × 297 mm page. |
| [layout-reference.pdf](layout-reference.pdf) | One card on A4, three-point registration marks, vector trim/external guides, and the second slot skipped. Uses the synthetic gradient image from the PDF test fixtures. |
| [tcgprint-cut.svg](tcgprint-cut.svg) | One active vector path; explicit 210 × 297 mm dimensions and matching viewBox. |
| [tcgprint-cut.dxf](tcgprint-cut.dxf) | One active `LWPOLYLINE`, `$INSUNITS=4` (mm), layer `CUT`. |

The page origin is top-left, X increases to the right, and Y increases down. Page dimensions are **210 × 297 mm**. The card trim is **63.5 × 88.9 mm**. Slot 0 is at `(50, 100) mm` and is active. Slot 1 is at `(130, 100) mm` and is skipped. Both remaining slots keep their stable row/column identities; the second one is not included in either cut export.

Expected active cut bounds:

```text
x = 50 mm
y = 100 mm
width = 63.5 mm
height = 88.9 mm
```

The corresponding PDF image matrix is `(a=180 pt, d=252 pt, e=141.73228346456693 pt, f=306.4251968503937 pt)`. Converting `e` and the PDF bottom-origin `f` back to page millimeters gives the same trim at `(50, 100) mm`. PDF registration marks are separate from cut paths and do not appear in the SVG/DXF files.

## Software review procedure

1. Reopen `source-layout.svg` using the exact fixture identity above. Confirm its file SHA-256 and 210 × 297 mm physical page.
2. Parse the source to `CutGeometryMm`; confirm the two closed path bounds match `(50,100,63.5,88.9)` and `(130,100,63.5,88.9)` mm.
3. Apply the Project skip for slot 1. Confirm the SVG and DXF contain one path for slot 0 only and retain the active slot coordinates without recentering.
4. Reparse each export. SVG coordinates should match within the 0.000001 mm software tolerance. DXF is serialized to six decimals and uses straight edges for this rectangular fixture.
5. Compare the PDF trim matrix with the expected point matrix above. PDF registration and print guides stay vector and separate from the cut files.

## Later physical review procedure

Physical review remains pending. When a real supported cutter and a real selected template are available:

1. Use a Project associated with that exact real template ID, version, package hash, and selected SVG/DXF file hash. Do not use this synthetic fixture identity as a substitute.
2. Print the PDF on A4 at **100% / Actual Size** with printer scaling disabled. Record printer model, driver, media, orientation, and settings.
3. Measure the printed page and card trim against the stated millimeter coordinates. Record actual measurements and the selected template identity.
4. Before sending cuts, use the manufacturer's documented recognition and cut tolerance for the actual cutter/template. Record its source and numeric value; this ADR does not invent a physical tolerance.
5. Load the matching exported SVG or DXF into the cutter software, confirm registration recognition, and perform a controlled cut. Record the software version, cutter model, recognition result, measured offsets, and pass/fail against the recorded manufacturer's tolerance.

Until that procedure is performed with the actual template and hardware, the result is **software geometry/export validated; physical cut validation pending**. No physical compatibility or alignment claim is made.
