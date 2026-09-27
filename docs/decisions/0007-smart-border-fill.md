# ADR 0007: Smart Border Fill for raster bleed (superseded)

- Status: Superseded on 2026-09-27; retained only as a historical record
- Date: 2026-09-26
- Scope: Phase 5.5, Front B — Scryfall raster bleed

> Historical only: the product direction below was rejected. Do not implement or
> use its interior-strip search, thresholds, visual matrix, or diagnostics as
> current requirements or acceptance evidence. The normative decision is now
> [ADR 0008: Edge Extension e Rounded Corners opcionais](0008-edge-extension-rounded-corners.md).

## Context

The existing `subtle-edge-stretch` mode preserves the trim but samples the
physical outside edge of the source. On a Scryfall scan with a flat dark frame,
that can extend a black strip into the PDF bleed. The correction must keep the
physical trim and the existing `BleedEngine`/PDF boundary intact. It must also
fall back when pixel evidence cannot distinguish a frame from artwork.

## Decision

`BleedEngine` remains the sole bleed generator. It now accepts
`smart-border-fill` alongside `subtle-edge-stretch`. Providers supply artwork
metadata only; they do not classify pixels or generate derivatives. Smart mode
classifies top, right, bottom, and left independently and can use a different
source-strip offset on each side.

The automatic policy is centralized in `resolveBleedSourcePolicy`:

| Selected artwork | Automatic mode | Policy identity |
| --- | --- | --- |
| Scryfall raster | `smart-border-fill` | `scryfall-raster-auto-v1` |
| Scryfall with an unrecognized non-SVG format | `subtle-edge-stretch` | `scryfall-unknown-format-subtle-v1` |
| Local upload | `subtle-edge-stretch` | `local-raster-subtle-v1` |
| MPC without trusted trim/bleed metadata | `subtle-edge-stretch`, explicitly marked unknown | `mpc-metadata-unknown-conservative-v1` |
| URL or custom raster | `subtle-edge-stretch` | source-specific subtle policy |
| SVG | Existing vector rules | `svg-vector-preserved-v1` |

The export control and `/api/cards/export` accept `auto`, `smart-border-fill`,
or `subtle-edge-stretch`. An explicit choice overrides the source default. SVG
still passes through unchanged at 0 mm and still reports the existing explicit
unsupported-operation error for non-zero bleed.

## Classification and inward search

Thresholds are centralized under
`SMART_BORDER_FILL_CONFIG_VERSION = "smart-border-fill-thresholds-v2"`.
Values are normalized to 0–1 unless marked in millimeters or samples.

| Setting | Default | Use |
| --- | ---: | --- |
| `classificationStripMm` | 0.75 mm | Maximum width of the outer band sampled for the dark-frame check; capped by the requested source-strip width |
| `darkLuminanceMax` | 0.20 | Maximum mean Rec. 709 luminance for a dark band |
| `darkPixelLuminanceMax` | 0.14 | Per-pixel luminance counted as dark |
| `minimumDarkPixelFraction` | 0.85 | Minimum dark-pixel fraction for a low-variation outer frame |
| `maximumDarkPixelFractionForInteriorStrip` | 0.10 | Maximum dark-pixel fraction for accepting an inward source strip |
| `maximumLuminanceStdDev` | 0.045 | Maximum luminance variation for a uniform dark frame |
| `maximumColorStdDev` | 0.07 | Maximum average per-channel variation for a uniform dark frame |
| `minimumSamples` | 12 | Minimum visible samples after transparent pixels are ignored |
| `maximumInwardSearchFractionOfTrim` | 0.05 | Maximum search depth as a fraction of the physical trim dimension perpendicular to that side; validation rejects values above 5% |
| `searchStepMm` | 0.25 mm | Distance between inward candidate strips |

For each side, the maximum search depth is `physical trim dimension ×
maximumInwardSearchFractionOfTrim`, converted to pixels using that side's source
scale. With the fixed 63.5 × 88.9 mm trim, left/right search is capped at
3.175 mm and top/bottom at 4.445 mm. This keeps the search proportional to card
geometry instead of a fixed pixel count and caps it at 5% of the corresponding
dimension. Each edge samples the central 90% of its length, skipping 5% at each
corner so corner pixels do not drive classification. Alpha values at or below
5% are ignored. Luminance and color variation are measured from normalized
8-bit or 16-bit samples.

The outer source band is a frame only when its mean luminance, dark-pixel
fraction, luminance deviation, and color deviation all meet the configured
thresholds. The search advances inward in 0.25 mm steps and selects the first
candidate whose mean luminance is above the dark limit and whose dark-pixel
fraction is at most 10%. The leading edge must be within the geometry-derived
search bound; the strip width itself can extend farther inward. The requested
source-strip width limits how much of the card is copied into the bleed.

## Fallback and corner behavior

If the outer band is not confidently dark and uniform, the side uses
`subtle-edge-stretch` with fallback reason
`outer-band-not-dark-uniform`. If a qualifying inner strip is not found within
the bound, the side falls back with reason
`no-representative-interior-strip-within-search-bound`. A failed side does not
change the decisions for the other three sides. Results report the requested
mode, each side's effective mode and source-strip offset, classification, and
fallback reason. The overall result reports `mixed` when sides use different
modes.

`addRasterBleed` writes only outside the trim rectangle. The trim samples are
copied directly. For each corner, the X and Y samples use the independently
selected adjacent side strips and the same strip-to-bleed mapping as those
sides. Near each end of a side extension, its along-edge source coordinate is
clamped to the neighboring side offset so both adjoining corner boundaries
sample the same pixels, even when one side falls back and the other uses an
inward strip. This preserves the reflected-corner join invariant from
[ADR 0003](0003-bleed-algorithm.md).

The result remains a lossless PNG derivative. The original trim is overlaid
once by the PDF engine, and the generated `BleedResult.preview.bytes` are the
same bytes it embeds in the clipped outside-trim regions. The existing PDF path continues to place guides and trims at the nominal
63.5 × 88.9 mm size, with no downsampling. Zero millimeters remains
original-byte passthrough. Tests cover exact trim samples, 16-bit RGBA and
alpha, 0 / 0.625 / 1 / 2 / 3 mm bleed, borderless/full-art and light-border
fallbacks, asymmetric four-side results, and corner joins where adjacent sides
choose different sources.

## Versioning and cache identity

The algorithm version is
`reflected-corners-v2-smart-border-fill-v2`. `createBleedCacheKey` hashes the
source SHA-256, requested bleed, requested mode, source-policy identity, source
strip, physical trim dimensions, algorithm version, and the complete
versioned threshold configuration. `CardExportService` uses the same key helper
for its per-export derivative de-duplication, so identical bytes chosen through
different policies or modes cannot reuse the wrong derivative.

## MPC metadata gap

The online MPC provider resolves selected provider IDs independently of gallery
search and distinguishes remote availability from validated local cache. XML
`availableLocally` is retained only as an untrusted hint; export still requires
validated original bytes. MPC does not provide trustworthy trim bounds or
bleed state, so automatic policy reports `MPC_BLEED_METADATA_UNKNOWN` and uses
`subtle-edge-stretch`. It does not assume the image is already bled, crop it,
or silently substitute Scryfall. The user can explicitly choose `auto`,
`smart-border-fill`, or `subtle-edge-stretch` in the export UI/API; preview
diagnostics and PDF export share the same effective `BleedResult`.

## Synthetic visual review

The matrix below compares original, subtle, and smart output at 1 mm for five
generated RGB fixtures: a classic dark frame, borderless/full-art texture, light
border, asymmetric left frame, and high-contrast corners. No commercial card
artwork is used. The red dashed rectangle marks the trim; the original column
uses a neutral pad outside the source only to keep panel dimensions equal.

The generated image comparison for this rejected proposal is not acceptance evidence and is not retained as a current project artifact.

For the classic synthetic frame, `subtle-edge-stretch` extends the dark frame;
`smart-border-fill` selects the inner color field on all four sides. The
borderless, light-border, and high-contrast-corner fixtures fall back to subtle
stretch; the asymmetric fixture uses smart fill on its dark left edge and
subtle fallback on the other sides. The old renderer is not retained in the
active tree; its contents remain recoverable from Git history.

## Real Scryfall diagnostic

The initial real-card failure was traced to the 2 mm search cap, not a bad dark
frame classification or an overly strict interior threshold. On all three
assets, the outer band passed the dark/uniform classifier, while every candidate
inside the old cap still had mean luminance below 0.20 and dark-pixel fraction
1.0. The first representative strips appeared about 2.993–3.791 mm inward;
their dark-pixel fractions were at most 9.97%. Thus
`search-bound-exhausted` was the internal classification and
`no-representative-interior-strip-within-search-bound` the fallback reason.

With the geometry-derived 5% cap, real assets were tested locally after the
change. `auto` resolved to `smart-border-fill` for all three; source strips are
8 px wide at 1 mm bleed. Values below are the effective result per side; offsets
are pixels from the trim edge and physical millimeters. All results used
`reflected-corners-v2-smart-border-fill-v2`.

| Card | Requested | Effective overall | TOP | RIGHT | BOTTOM | LEFT | Fallback reasons | Algorithm version |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Lightning Bolt (me1/102) | `auto` | `mixed` | smart @ 26 px / 3.399 mm | smart @ 24 px / 3.123 mm | smart @ 28 px / 3.661 mm | subtle fallback | LEFT: `no-representative-interior-strip-within-search-bound` | `reflected-corners-v2-smart-border-fill-v2` |
| Counterspell (me4/45) | `auto` | `smart-border-fill` | smart @ 26 px / 3.399 mm | smart @ 24 px / 3.123 mm | smart @ 28 px / 3.661 mm | smart @ 23 px / 2.993 mm | none | `reflected-corners-v2-smart-border-fill-v2` |
| Island (inr/290) | `auto` | `smart-border-fill` | smart @ 27 px / 3.530 mm | smart @ 23 px / 2.993 mm | smart @ 29 px / 3.791 mm | smart @ 23 px / 2.993 mm | none | `reflected-corners-v2-smart-border-fill-v2` |

For Counterspell, subtle bleed mean luminance was 0.000–0.0001, compared with
0.3368–0.4395 for smart bleed. For Island, subtle was 0.0521 and smart was
0.2658–0.3612. The black edge remained inside the unchanged trim; the generated
outside bleed sampled the interior rather than extending a dominant black
band. Pixel-by-pixel comparison of every trim pixel passed for both modes on
all three assets (331,840 trim pixels per image). The real-art matrix and full
per-side report are local-only at
`/home/agent/.hermes/cache/scratch/tcgprint-phase5-5-evidence/smart-border-real/`
and are not committed. These measurements document the rejected approach only;
the renderer and matrix are not active project requirements.

## Consequences

- Scryfall raster artwork with a dark, uniform edge can use a nearby inner
  source strip without changing the physical trim.
- Every Scryfall raster requests `smart-border-fill` automatically, including
  borderless/full-art metadata. Pixel-only evidence determines each side; the
  borderless/full-art fixture falls back when its edges are not confidently
  dark and uniform.
- Preview bytes and PDF output share one `BleedResult` and one effective policy.
- MPC trim/bleed state stays explicitly unknown until trustworthy metadata is
  available.
- Changing any threshold requires a new or changed cache identity; changing
  the algorithm requires updating `BLEED_ALGORITHM_VERSION`.
