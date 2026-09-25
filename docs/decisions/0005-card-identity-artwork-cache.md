# ADR 0005: Card identity, selected artwork, and local cache

- Status: Accepted
- Date: 2026-09-25
- Scope: Phase 5 — Card Identity + Scryfall + Artwork Switching

## Context

Universal Import produces logical card entries and local assets. Printing identity,
artwork selection, and the immutable uploaded bytes have different lifetimes:
correcting a card name must not discard an upload, and changing artwork must not
change the identity or recreate the entry. Double-faced cards also need separate
front and back choices before duplex printing exists.

## Decision

`CardIdentity` represents the logical Magic card, using its Oracle ID as the
stable Scryfall identity when available. Printing fields such as Scryfall card ID,
set, collector number, and language remain identity-resolution or printing hints.
Each `WorkingCard` has its own stable session ID, quantity, order, section,
identity-resolution state, per-face selections, local asset links, and imported
MPC references. Artwork is always a separate candidate and selection. Candidate
refresh does not change the selection; an explicit user action does.

The Working Set stays in browser session state. SQLite contains provider
metadata with TTL, artwork provenance, identity-to-upload links, and separate
thumbnail records only. Originals are immutable SHA-256-addressed files under
paths derived from the digest and validated format. Uploads with identical bytes
share one physical original. Provenance retains provider IDs, Scryfall and Oracle
IDs, source URL, download time, content type, original filename, and import
metadata. Filesystem paths never enter UI DTOs. Thumbnails are separate
derivatives and can never serve as PDF input.

Scryfall access stays behind one typed server-side client with a TCGPrint
User-Agent, official HTTPS API/image hosts, bounded requests, rate limiting,
timeout, cancellation, and typed errors. Metadata and artwork originals are
cached independently. When metadata TTL expires offline, cached Scryfall
originals can reconstruct artwork candidates from their provenance. Related
token/card references are retained as labels only; they do not create deck
entries or trigger recursive provider calls.

For name-only identities, the default artwork is the newest non-digital English
high-resolution printing with an available original. Ties sort by set code,
collector number, then Scryfall ID. Explicit selections always stay selected;
an explicit Scryfall card ID takes precedence, then set plus collector number,
then the name-only default. Upload and MPC selections are never replaced by that
policy.

Scryfall `card_faces` are mapped in order to logical front and back faces. A
resolved multi-face identity adds its missing face while retaining imported
face artwork, so one face can remain a local upload while the other uses
Scryfall. Duplex composition is deferred. MPC Autofill asset IDs, selected
artwork IDs, slots, and order are preserved as reference-only data unless the
import already contains local bytes; this phase performs no MPC network lookup.

OCR uses `OcrRecognizer` with a lazy Tesseract.js 7 Node worker and a packaged
English model. Recognition reads a temporary Sharp crop of the likely title
band; it never modifies or uploads original bytes. The WASM core and English
model add roughly 59 MB unpacked server dependencies. CDN model loading failed
in the spike, so the model is local. Termux/proot and Node 24 remain unverified;
OCR failure is isolated from import, local artwork, and export.

PDF composition expands quantity only while building the image list. It loads
validated original bytes through providers and reuses the existing BleedEngine,
placement, CutGuideEngine, and LosslessPdfEngine. The standard trim remains
63.5 × 88.9 mm on A4. SVG remains vector at zero bleed; the current bleed engine
reports an explicit unsupported-operation error for non-zero SVG bleed.

## Consequences

- Changing artwork preserves `WorkingCard.id`, `CardIdentity.id`, quantity, and
  uploaded originals.
- Local uploads and cached Scryfall originals remain exportable when Scryfall is
  unavailable; unavailable MPC references remain visible but cannot be
  exported as if they contained image bytes.
- Metadata can expire without arbitrarily evicting content-addressed originals.
- The standard install grows because local OCR includes WASM and trained data;
  importing normal decks does not start the OCR worker.
- SVG stays vector when compatible, but non-zero bleed is not available for SVG
  until a separate vector-bleed implementation is designed.

## References

- [Fase 5 implementation plan](../superpowers/plans/2026-09-25-card-identity-scryfall-artwork.md)
- [Implementation plan, Phase 5](../../IMPLEMENTATION_PLAN.md#parte-xiv--universal-import-engine)
- [Bleed Engine and SVG policy](0003-bleed-algorithm.md)
- [Scryfall API access and rate-limit guidance](https://scryfall.com/docs/faqs/i-m-having-trouble-accessing-the-scryfall-api-or-i-m-blocked-17)
