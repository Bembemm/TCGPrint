# ADR 0002: PDF image fidelity and vector SVG

- Status: Accepted
- Date: 2026-09-24
- Scope: Phase 1 — minimal PDF export

## Context

The implementation plan selects `@pdfme/pdf-lib` as the PDF document base and
requires JPEG passthrough, lossless PNG pixels with transparency, vector SVG
where supported, and millimeters as the canonical geometry unit. The package
was not yet installed in the project, so these properties needed an isolated
probe before building the production engine.

## Spike and results

The probe used Node.js 22.22.1, `@pdfme/pdf-lib` 6.1.13, and
`svg4pdf-lib` 0.1.2 with small synthetic color and geometry fixtures:

- **JPEG:** `embedJpg` wrote a `/DCTDecode` image stream whose SHA-256 matched
  the source JPEG byte for byte. Its `/Width` and `/Height` remained the
  source's 8 × 6 pixels while the PDF draw matrix placed it at 180 × 252
  points. Passing a Node `Buffer` backed by a larger slab failed with `SOI not
  found in JPEG`: this fork reads `imageData.buffer` without applying the view's
  `byteOffset` and `byteLength`.
- **PNG RGB:** the PDF contained an 8 × 6 `/DeviceRGB` image with
  `/FlateDecode`; inflating its stream produced the same RGB sample bytes as
  the source PNG. No JPEG stream or resampling was involved.
- **PNG alpha:** the PDF contained an 8 × 6 RGB image and a matching 8 × 6
  grayscale `/SMask`. Inflating both streams reproduced the original RGB and
  alpha samples exactly.
- **PNG 16-bit follow-up:** the selected library's built-in PNG embedder uses
  an 8-bit RGBA decode path and truncates the low byte of 16-bit samples. A
  native PDF image object was therefore added for PNGs with 16-bit samples:
  their unfiltered big-endian RGB/gray samples use `/BitsPerComponent 16` and
  `/FlateDecode`; alpha is split into a same-sized 16-bit grayscale `/SMask`.
  A `tRNS` color key is represented as a full-precision soft mask as well.
  Automated fixtures verify distinct low-byte samples, alpha, transparency
  keys, and Adam7 interlacing.
- **SVG:** `@pdfme/pdf-lib` exposes `drawSvgPath`, but no API that converts an
  SVG document. The separate `svg4pdf-lib` adapter emitted PDF path operators
  (`m`, `l`, `h`, `f`, `S`) for a synthetic SVG rectangle and path, without
  adding an image XObject for that SVG. Its placement honors physical SVG
  dimensions when the root `width` and `height` are set to the target size.
  Additional negative probes found two silently ignored inputs: an
  `feGaussianBlur` filter was omitted without a warning, and `foreignObject`
  content exported no visible content. The converter warning callback is not a
  complete unsupported-feature detector.
- **Geometry:** an A4 MediaBox measured 595.2755905511812 ×
  841.8897637795276 points, equivalent to 210 × 297 mm. Magic Standard's
  63.5 × 88.9 mm placement measured 180 × 252 points. Both were created from
  the existing millimeter geometry via `mmToPoints`.

The isolated throughput probe assembled 30 PDFs with 9 cards each (three
synthetic JPEGs, three PNGs, and three vector SVGs per PDF). On this Node.js
22.22.1 environment, median assembly time was 11.3 ms, p95 was 28.0 ms, and the
last PDF was 3,161 bytes. The fixtures are only 8 × 6, 4 × 3, and vector
shapes, so these figures validate the probe path and are not representative of
large-card export performance.

## Decision

Use `@pdfme/pdf-lib` for the PDF document and standard 8-bit JPEG/PNG objects.
Use `svg4pdf-lib` to translate a conservative, validated SVG subset into
vector PDF operators. Embed 16-bit PNG sample data as native PDF Flate image
objects because the library's built-in PNG path reduces it to 8 bits. The
engine copies input bytes into an exact, zero-offset `Uint8Array` before
handing them to the library; this is a byte-for-byte memory copy, not image
decoding or processing.

Keep all page, card, margin, and placement geometry in millimeters until the
PDF page and draw calls are created. Convert to points only at that boundary.
Set A4 dimensions from the exact millimeter values rather than a rounded page
size constant. Set each card's physical width and height through the PDF draw
transformation, independently of its embedded pixel dimensions.

For SVG export, preserve vector output. Require a numeric `viewBox`, set the
root's physical dimensions on an in-memory copy for the requested card size,
and reject every element or attribute outside the validated subset before
conversion. The current subset accepts a root `svg` and basic shape elements
(`rect`, `path`, `circle`, `ellipse`, `line`, `polyline`, `polygon`) with plain
numeric geometry, hex RGB (`#RRGGBB`) or `none` paint, and the `stroke-width`
attribute. Filters, `foreignObject`, text, groups, CSS, gradients, masks,
transforms, external content, other paint forms, and other unvalidated SVG
features fail explicitly. Converter warnings also fail export. Never silently
rasterize an SVG.

## Consequences and limits

- `@pdfme/pdf-lib` 6.1.13 is MIT licensed. `svg4pdf-lib` 0.1.2 is
  LGPL-3.0-or-later; distribution packaging must preserve the applicable
  notices and comply with that license, or replace the adapter before release.
- SVG support is intentionally narrower than the full SVG standard so that
  known adapter omissions and unverified properties fail explicitly. The
  adapter version, allowlist, and vector-output test must be reviewed when it
  is upgraded.
- 8-bit PNG pixels and alpha remain sample-exact through the library's Flate
  streams. 16-bit gray/RGB color types 0, 2, 4, and 6 preserve full sample
  precision (including Adam7 reconstruction) through native 16-bit Flate
  image objects. The 16-bit parser rejects unsupported color/interlace modes
  explicitly. Unprocessed JPEGs retain their original DCT stream.
- No thumbnail substitution, downsampling, recompression, page rasterization,
  or file-size optimization is part of Phase 1.

## Alternatives considered

- **Only `@pdfme/pdf-lib`:** preserves JPEG and PNG as required and can draw SVG
  paths, but it does not consume a complete SVG document. That leaves the
  planned SVG-image requirement incomplete.
- **Rasterize SVG before embedding:** rejected because it loses vector
  geometry and adds an export resolution choice.
- **Implement a general SVG-to-PDF converter in TCGPrint:** deferred because
  it would duplicate a substantial format parser and renderer in this phase.

## References

- [`@pdfme/pdf-lib` package](https://www.npmjs.com/package/@pdfme/pdf-lib)
- [`@pdfme/pdf-lib` source](https://github.com/pdfme/pdfme/tree/main/packages/pdf-lib)
- [`svg4pdf-lib` package and API](https://www.npmjs.com/package/svg4pdf-lib)
- [Implementation plan, PDF Engine and PDF Fidelity Spike](../../IMPLEMENTATION_PLAN.md#parte-xi--pdf-engine)
