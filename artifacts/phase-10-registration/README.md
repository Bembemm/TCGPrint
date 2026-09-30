# Fase 10 physical registration gate

## Programmatic print artifact

Print `registration-physical-reference.pdf` on **A4, portrait, at 100% / Actual Size**. Disable “Fit”, “Shrink”, borderless expansion, and driver scaling. The PDF page is 210 × 297 mm.

This is a synthetic reference fixture, not a real Silhouette template. It is labeled with fixture ID `tcgprint-registration-physical-reference`, fixture version `fixture-1`, Template ID `none`, and package hash `n/a`. Its intentionally generic geometry is three-point / portrait, with 10 mm insets, 5 mm L arms, a 5 mm square, 1 mm stroke, and zero extra clearance. It shows an A4 sheet, portrait 50 × 65 mm card outlines, 0 mm margins and gaps, all nine stable grid identities, center slot 5 skipped, reserved registration zones, cut guides, and a 10 mm calibration bar.

## Real-template measurements required for approval

The actual Silhouette template is **not present in the repository or available in this environment**. Its Template ID, exact version, and package hash are therefore pending and must not be fabricated. Import the physical template into Template Library, select the exact immutable version in a Project, and regenerate the reference PDF from that Project with its versioned registration configuration before using the cutter.

For the real-template print, record:

- paper format, physical dimensions, and page orientation;
- Template Library ID, version, and 64-character package hash;
- registration type and orientation, configured offsets, mark dimensions, stroke, and reserved-zone clearance;
- printer dialog’s 100% / Actual Size setting and the measured 10 mm scale bar;
- measured registration mark centers/edges and their distances from page edges;
- measured reserved-zone boundaries and card trim dimensions/positions;
- whether the Silhouette software detects all marks and whether each cut lands within the selected template/equipment's documented physical tolerance of the printed trim. The implementation plan sets no numeric cut tolerance, so record the source and exact pass threshold before testing; do not invent it after seeing the result;
- pass/fail result and the physical printer/cutter/template used.

Do not treat the synthetic fixture or SCM’s generic reference defaults as physical validation. The physical gate remains pending until these measurements come from an actual print and cut with the exact real template version.
