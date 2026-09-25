# ADR 0004: Cut guide geometry and bleed-aware placement

- Status: Accepted
- Date: 2026-09-24
- Scope: Phase 3 — Cut Guide Engine

## Context

The implementation plan names six guide modes and their physical settings, but
does not define the exact segments for crop marks, crosses, or how multiple
trimmed cards reserve room for external bleed. Those choices affect printed
mark positions and physical cuts, so they must be explicit and testable.

## Decision

All domain geometry uses millimeters with a page origin at the upper-left:
positive X points right and positive Y points down. A guide receives trim
rectangles and never uses a bleed rectangle to determine a cut coordinate.

- `none` emits no segments.
- `corners` emits two outside-only crop strokes per trim corner. Each stroke
  sits `offsetMm` outside an adjacent trim edge. `externalLengthMm` extends
  beyond the projected corner; `internalLengthMm` continues along the
  projected trim edge. Neither segment enters the image trim.
- `sides` emits one mark for each trim side, centered on that side. Its outside
  portion begins `offsetMm` from the trim and extends by
  `externalLengthMm`; its inside portion starts at the trim and extends into
  the image by `internalLengthMm`. The offset gap remains empty.
- `cross` emits a plus centered exactly on each of the four trim vertices;
  each arm has the configured `armLengthMm`.
- `full` emits the four trim boundary lines.
- `guillotine` emits full-page vertical and horizontal lines at every unique X
  and Y trim boundary. Coincident lines are emitted once.

The minimum regular grid uses one slot per card with a footprint of
`cardSize + 2 × bleed`. Adjacent trim rectangles are therefore separated by
`2 × bleed`, so their external derivatives meet at most at their edges. The
complete slot grid is centered in the printable page area; it fails if it
cannot fit and never scales the card. The trim stays at its nominal dimensions.
When bleed amounts vary, each grid column and row reserves the largest bleed
of the cards assigned to it; adjacent trims then have at least the sum of their
individual external bleed clearances. The PDF engine chooses the largest
row-major prefix that fits on each page.

Outside portions of corner, side, and cross marks are checked against every
other trim, including half the configured stroke width. A request that would
draw over another card's trim fails with a geometry error.

Only the PDF adapter converts geometry and stroke widths from millimeters to
points. It draws bleed first, the original trim image once, and vector guides
last.

## Consequences

- Crop marks remain outside card pixels by default; an explicitly positive
  side-mark internal length intentionally enters the trim.
- Cross marks intentionally meet the four trim corners; they are not centered
  on bleed bounds or on the card center.
- Increasing bleed can change the spacing between cards in an automatic grid.
  The guide engine still uses each resulting trim rectangle, so bleed never
  expands or offsets a cut relative to its trim.
- Guillotine line deduplication uses a small millimeter tolerance to absorb
  floating-point arithmetic at shared boundaries.
- Mark lengths that would cover neighboring trim artwork are rejected instead
  of being shortened or clipped silently.

## References

- [Implementation plan, Cut Guide Engine](../../IMPLEMENTATION_PLAN.md#parte-ix--cut-guide-engine)
- [Implementation plan, PDF Engine](../../IMPLEMENTATION_PLAN.md#parte-xi--pdf-engine)
