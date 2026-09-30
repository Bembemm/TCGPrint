# ADR 0013: Independent registration geometry

- Status: Implemented in software; physical validation pending
- Date: 2026-09-30

## Context

Fase 10 adds print registration to the existing page layout, preview, vector PDF, Project persistence, and versioned Template Library. Registration must remain independent of page and card orientation, prevent card artwork and bleed from occupying its reserved paper regions, and preserve the existing PDF image fidelity guarantees.

The repository has no real Silhouette template package or physical test fixture. The available external reference is the Silhouette Card Maker (SCM) specification and README. SCM documents 3-point and 4-point modes and generic defaults of 10 mm inset, 5 mm L arms, 1 mm line thickness, and a 5 mm square. Those are observed reference defaults only. They are not established Silhouette protocol requirements and have not been verified against a real template, printer, or cutter.

## Decision

### Registration model and units

Registration is an explicit serializable configuration with the variants `none`, `three-point`, `four-point`, and `custom`. All positions, dimensions, clearances, and line widths use millimeters. Coordinates use the existing page convention: origin at the upper-left, positive X to the right, positive Y down. Conversion to PDF points occurs only while emitting PDF drawing operators.

The shared geometry module generates immutable marks and axis-aligned bounds. Three-point and four-point use the same primitives and geometry path: L-shaped corner marks, with the third point represented by a filled square for three-point mode. Built-in mark placement defaults to the generic SCM values above, with zero extra reserved-zone clearance. Every built-in dimension remains configurable and may be overridden by a versioned template. These values are provisional until physically validated.

`none` always returns zero marks and zero registration-derived reserved zones. It does not change the established placement when there are no user skips or other reserved zones.

### Versioned template layout geometry

A Template Library version may carry explicit bounded `templateGeometry` metadata: coordinate-frame orientation, independent card orientation, physical page and card dimensions, fixed rows/columns, and stable row-major slot coordinates. It is validated in millimeters, included in that version's package hash, and stored in the new `template_geometry_json` column (database migration 4). Named paper/card formats are resolved to physical dimensions; custom paper or card formats require explicit geometry. The app passes these formats and exact positions through the existing placement/PDF engine. Template slots are never centered or shifted. Page rotation transforms the template slot geometry; the selected card orientation must still match the exact physical slot dimensions or placement fails with a clear error.

Projects persist the effective physical paper/card formats and the selected template geometry snapshot together with the exact `(templateId, version, packageHash)` association. Reopen, duplicate, and recovery therefore retain the geometry that was selected even after a newer version is imported. A template may define registration geometry and layout slots; a Project may override its effective registration configuration without modifying the immutable package. Older schema-1 Projects use the existing A4/Magic defaults.

Slot positions enter Template Library as explicit JSON metadata or other separately authored metadata. The implementation does not infer slot geometry from `.studio3` bytes. Original template files remain opaque and unchanged.

### Orientation semantics

Page orientation controls only the physical sheet dimensions. Card orientation controls only the trim dimensions and artwork transform. Registration orientation controls only how registration coordinates are transformed onto the selected sheet. Each setting is stored and passed independently; registration does not infer its orientation from the page.

When an explicit card orientation rotates a non-square card format, the PDF artwork receives a 90-degree vector placement transform inside the oriented trim. The source image is not resized to force a different aspect ratio or re-encoded. Duplex orientation and flip behavior remain future work.

### Reserved zones and skipped slots

Each mark produces a rectangular no-card zone from its physical mark bounds plus the configured clearance. Custom geometry can add explicit rectangles; the bounds of custom marks are also reserved. Zones are physical page rectangles and are validated before placement. A layout may touch a zone boundary, but trim plus requested bleed may not overlap its interior. If registration zones leave insufficient room, layout returns an error while keeping the requested physical card size, bleed, and scale.

Skipped slots are a separate layout concept. Their identities are zero-based, row-major positions in the fixed grid. They keep their positions and do not shift other slots. Cards fill remaining eligible positions in stable row-major order. Preview displays a user skip separately from a physically reserved zone.

The existing placement engine also accepts four page margins and independent horizontal/vertical gaps, all in millimeters. Margins contain the complete grid envelope, including requested bleed. A gap is additional empty space between adjacent bleed envelopes; the trim-to-trim distance includes both cards' bleed plus that gap. These values affect capacity and exact positions and are persisted in the Project.

### Custom geometry and validation

Custom registration accepts JSON line, rectangle, and circle primitives, mark groups, and reserved rectangles. It does not accept executable code. Parsing rejects non-finite values, accessors, cyclic or non-plain objects, sparse or oversized collections, dimensions outside configured physical bounds, malformed primitives, and geometry outside the page. The serialized configuration is limited to 64 KiB, with at most 32 marks, 128 primitives, and 64 explicit zones.

### Template Library and Projects

Registration configuration and optional exact slot geometry belong to an immutable Template Library version. Both participate in that version's package hash and are stored in `registration_config_json` (database migration 3) and `template_geometry_json` (database migration 4). Selecting a template explicitly applies the selected version's registration, physical-format, orientation, and layout defaults. Reopening a Project uses the saved effective settings and exact `(templateId, version, packageHash)` selection; it never silently adopts a later template version.

Projects persist effective registration and template layout geometry as reprint settings. Project snapshot schema 2 adds independent orientations, physical paper/card formats, page margins, registration, and fixed-grid/skipped-slot/template-geometry settings. Reading schema 1 supplies compatibility defaults; the next save writes schema 2. Autosave, duplicate, recovery, and recovery promotion use the same serializer and keep the exact template association.

### Preview and PDF

Preview calls the shared placement and registration geometry modules and displays cards/trim, bleed, cut guides, registration marks, reserved zones, and skipped slots. It uses geometry and card IDs rather than loading original artwork just to show registration.

The PDF engine draws registration marks with vector line, rectangle, and circle operators. It keeps the page as a vector PDF and continues embedding original JPEGs as image XObjects. Registration `none` emits no mark operators. Cut guides remain on the existing vector path.

## Alternatives considered

- Derive registration placement from page orientation. Rejected because the plan requires separate orientation settings and a template can require a different registration frame.
- Implement separate placement engines for three-point and four-point. Rejected because their geometry differs by mark count and configuration, not by placement infrastructure.
- Store custom executable shapes. Rejected because a bounded JSON representation is sufficient and safer to persist in template packages and Projects.
- Treat user-skipped slots as reserved zones. Rejected because an explicit layout omission has different identity and preview semantics from a physical no-card area.
- Copy or inspect `.studio3` internals. Rejected. The application treats `.studio3` as opaque template data and makes no claim about its internal protocol.

## Physical validation gate

The generic defaults and generated reference fixture are not proof of compatibility with a Silhouette machine. No printer, cutter, or real template was available in this implementation environment. The committed fixture is explicitly unbound to a Template Library package and exists for programmatic review and as a printable setup reference. It does not satisfy the plan's real-template gate.

Before accepting built-in physical geometry, import and select a real template, record its exact ID, version, and package hash, generate the physical fixture with that version's explicit geometry, print on the declared paper at 100% / Actual Size, and measure the registration marks, reserved offsets, card trims, and 10 mm calibration bar. The implementation plan defines no numeric cut tolerance. Before the print/cut, record the tolerance published for the selected equipment/template and its source; the cutter must recognize the marks and all cuts must land within that recorded threshold. Record the observed paper, orientation, scale, measurements, template identity, and pass/fail result in a follow-up ADR amendment. Do not promote the generic reference defaults to validated Silhouette dimensions before that test.

## References

- SCM specification (observed reference behavior and generic defaults): https://github.com/Alan-Cha/silhouette-card-maker/blob/main/SPECIFICATION.md
- SCM README (observed supported mark types): https://github.com/Alan-Cha/silhouette-card-maker/blob/main/README.md
- [ADR 0004: cut guide geometry](0004-cut-guide-geometry.md)
- [ADR 0010: project persistence](0010-project-persistence.md)
- [ADR 0012: Silhouette Template Library](0012-silhouette-template-library.md)
