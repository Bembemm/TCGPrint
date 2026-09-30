# ADR 0011: Isolated URL adapters for Universal Import

- Status: Accepted for Phase 8 audit
- Date: 2026-09-30
- Scope: Phase 8 — URL Adapters
- Related: `IMPLEMENTATION_PLAN.md` sections 6, 10–16, 115, 134–146; ADR 0005; Universal Import Engine plan

## Context

The Universal Import Engine accepts text and files in `importFiles`, detects URLs, and currently records a deferred warning. Phase 8 needs the same single UI input to accept URLs while preserving the existing `ImportResult`/`ImportReport` contract, generic importers, per-input failure isolation, and the separation between importers and artwork providers.

The requested sites do not expose one common protocol. Live, unauthenticated GET probes on 2026-09-30 found a mix of explicit exports, public JSON endpoints, and WAF/login barriers. HTML scraping is not a generic fallback.

## Decision

### Shared architecture

- Keep URL detection in the Universal Import flow; the user pastes a URL into the existing text input.
- The same text field is used by preview and Working Set imports. The safe Working Set report exposes source kind, basename, original format, response MIME, redacted source URL, adapter ID, and byte count; it omits raw response bodies and filesystem paths.
- Uploaded file `Content-Type` is passed to the existing detector as evidence alongside the bytes and filename.
- Match adapters by exact host and an explicit path grammar. A known host with an unsupported route returns a typed, user-readable import error.
- A URL adapter is an importer: it identifies or parses user-selected content and returns existing import entries or normalized source bytes for existing importers. It never searches/downloading card artwork and never implements `ArtworkProvider`.
- The shared transport is GET-only and bounds timeout, redirects, response bytes, and body reads. A failing URL becomes an error for that source; sibling files and text continue.
- For unknown hosts, attempt only a direct import file. Route by response bytes and `Content-Type`; an extension can refine the filename but cannot decide the importer by itself.
- Accept supported raster/SVG, TXT, CSV/TSV, JSON, XML, and ZIP payloads through existing importers. Reject HTML clearly unless an explicit adapter owns that site and protocol.
- Keep HTTP probes out of CI. Adapter tests use synthetic payloads and injected fetch/DNS implementations.

### Protocols in the first implementation slice

- **Scryfall:** accept individual `/card/{set}/{collector}/{slug}` links as a card hint. Do not infer support for Scryfall deck/search pages. The adapter does not fetch artwork or call the Artwork Catalog.
- **Archidekt:** public deck ID maps to `GET https://archidekt.com/api/decks/{id}/`. A live public ID returned HTTP 200 with JSON and `cards[]`; a stale/private ID returned 404 JSON. The endpoint/schema is not a published compatibility guarantee, so validate required fields and surface schema/remote failures. Do not use the retired `/small/` route.
- **CubeCobra:** public cube ID maps to `GET https://cubecobra.com/cube/api/cubeJSON/{id}`. A live public cube returned HTTP 200 `application/json` with `cards.mainboard`, `cards.maybeboard`, and `cards.basics`. Normalize these boards into card entries and preserve board labels.
- **MTGTop8:** a live `event?d=…` page exposed its `.mwDeck` export at `/dec?d=…&f=…`. The export returned HTTP 200 `text/plain` with a `.mwDeck` filename. Consume that export directly and use the existing MWS text importer; do not scrape the page's deck HTML.
- **mtg.wtf:** the public deck page exposes `/deck/{set}/{slug}/download`, which returned HTTP 200 `text/plain` with a decklist. Use the export endpoint and existing generic text importer; strip only its `//` metadata header lines.
- **Direct files:** unknown public URLs may be imported only when the response is a supported file type. Validate MIME and bytes; do not treat arbitrary HTML as a decklist.

## Verified limitations and deferred adapters

- **Moxfield:** the public API probe returned HTTP 403 with a Cloudflare challenge. Available protocol notes are unofficial and describe access depending on a custom User-Agent or an authenticated token. Do not bypass the challenge, use session credentials, or promise Moxfield import until an authorized stable access path is verified.
- **Deckstats:** the probe returned HTTP 403 with a Cloudflare challenge. No bypass or HTML scrape is included.
- **MTGGoldfish:** the deck page probe returned HTTP 403 with a Cloudflare challenge. Public download behavior may exist in the website, but it was not reachable through a verified stable protocol in this probe. Do not bypass the challenge.
- **TappedOut:** the public deck page probe returned HTTP 403 with a Cloudflare challenge. No widget/API fallback is included without a verified current stable protocol.
- **MTGTop8 HTML:** its page is readable, but the implementation uses the explicit `.mwDeck` export instead of depending on HTML structure.
- **Scryfall non-card routes:** search/deck URLs are explicitly unsupported until their data protocol is verified.

These domains are still identified explicitly so the user gets a clear unsupported/blocked result instead of generic HTML parsing. Users may import a separately downloaded file from any site through the file input.

## Consequences

- The URL architecture is testable without external services, and existing importers remain the single parsers for direct file formats.
- Public JSON endpoints can change; strict response validation prevents malformed remote content from becoming guessed card entries.
- WAF/login failures remain isolated and visible, but those sites remain pending rather than nominally supported.
- No changes are made to artwork providers, identity resolution behavior, Projects, PDF, bleed, geometry, or export engines.

## Live probe evidence

Low-volume GET-only probes used an identifiable `TCGPrint/0.1` User-Agent, no cookies, credentials, writes, or challenge bypass. Sample URLs and response summaries:

| Service | Probe | Observation |
| --- | --- | --- |
| Archidekt | `GET /api/decks/7031486/` | 200, `application/json`, public deck with 81 card records |
| Archidekt | `GET /api/decks/8720280/` | 404 JSON `Deck not found` |
| CubeCobra | `GET /cube/api/cubeJSON/obc` | 200, `application/json`, 1,540,533 bytes, board objects present |
| MTGTop8 | `GET /dec?d=298009&f=Limited_WB_by_captainobv` | 200, `text/plain;charset=ISO-8859-1`, attachment `.mwDeck` |
| mtg.wtf | `GET /deck/m19/red-white-deck/download` | 200, `text/plain; charset=utf-8`, decklist |
| Moxfield | public API deck GET | 403, HTML Cloudflare challenge |
| Deckstats | public deck GET | 403, HTML Cloudflare challenge |
| MTGGoldfish | public deck GET | 403, HTML Cloudflare challenge |
| TappedOut | public deck GET | 403, HTML Cloudflare challenge |

The evidence establishes behavior only at probe time, not an availability or schema guarantee. Synthetic fixtures are used for deterministic CI tests; no live commercial deck payload is committed.
