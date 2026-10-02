# ADR 0006: MPC Autofill artwork-provider protocol spike

- Status: Accepted with conditions for Phase 5.5 A1
- Date: 2026-09-26
- Scope: Phase 5.5 — protocol spike and A1 artwork-provider implementation

## Context

ADR 0005 keeps imported MPC Autofill IDs as references and performs no MPC
network lookup. This A0 spike checked whether the current public
`chilli-axe/mpc-autofill` service can support an independently implemented
artwork provider. It adds no provider or importer code and copies no upstream
implementation.

That no-provider statement describes only the historical A0 spike. The
independent A1 provider now present on the Phase 5.5 integration branch is
described under “Current TCGPrint A1 behavior and limits” below.

Evidence distinguishes **live observations** from **upstream-source
inspection**. Live tests were low-volume, unauthenticated HTTPS requests with
no cookies or CSRF token. No images or raw API responses were stored in the
TCGPrint repository.

## Protocol spike and live observations

- TCGPrint base: `a58cae9087ebf06be1d9eca9ac868693ea26da32`.
- Upstream snapshot: `chilli-axe/mpc-autofill` `master` at
  `ceb7c3b2f39b8c8caebe396ec87f2bddba6c3743`.
- Public service host tested: `https://mpcfill.com`.
- The live probes used ordinary GET/POST requests with an identifiable
  User-Agent. They did not send cookies, credentials, CSRF tokens, or writes.

| Probe | Live result |
| --- | --- |
| `GET /2/sources/` | HTTP 200, `application/json`, 71,903 response bytes; 279 source records were returned, all with `sourceType: Google Drive`. |
| `POST /3/editorSearch/` | HTTP 404, `text/html` on the live host at probe time, although current upstream `master` contains this route and uses it first. |
| `POST /2/editorSearch/` with the current v2 legacy request shape | HTTP 200, `application/json`; a single `Sol Ring` query returned 713 identifiers. |
| `POST /2/editorSearch/` with the v3 object-map query shape | HTTP 400 schema error. V2 requires the legacy query array; its response is nested by query and card type. |
| `POST /2/cards/` with three returned identifiers | HTTP 200, `application/json`; each result was hydrated under its identifier. One result was `Sol Ring (Extended Black Dom)`, `CARD`, `Google Drive`, `png`, metadata size 7,993,905 bytes, DPI 1200. It included separate small and medium thumbnail URLs. |
| `GET` small thumbnail URL from that card document | HTTP 200, `image/png`, 126,761 bytes; redirected from `drive.google.com` to `lh3.googleusercontent.com`, whose path requested a 400×400 thumbnail. |
| `GET https://cdn.mpcautofill.com/images/google_drive/full/<id>.jpg?jpgQuality=100` | HTTP 200, `image/png`, 1,355,811 bytes for the same identifier. The content type and length differ from the card’s PNG original metadata; this rendition must not be treated as byte-identical original artwork. |
| `GET https://drive.google.com/uc?export=download&id=<id>` | HTTP 200 without cookies or credentials; redirected to `drive.usercontent.google.com/download`, returned `image/png`, 7,993,905 bytes, matching the hydrated record’s declared size. This confirms one public Google Drive original path, not a guarantee for every asset or future permission state. |
| `GET /2/DFCPairs/` | HTTP 200, `application/json`, 508 front/back name pairs. Searching one returned pair produced separate front and back identifiers; `/2/cards/` hydrated both as `CARD` documents. |
| `POST /2/cardbacks/` with search settings | HTTP 200, `application/json`, 482 cardback identifiers. Hydration through `/2/cards/` returned `cardType: CARDBACK`. |

No volume, load, or failure-injection tests were performed. No 429/rate-limit
response or authentication challenge was observed in these low-volume calls;
this does not establish a rate-limit policy, timeout guarantee, or service
availability SLA. The single original download validates one publicly
accessible Google Drive asset only. No DFC or cardback original bytes were
downloaded.

## Public base URL configuration

The upstream frontend supports a configurable backend URL. The `mpcfill.com`
host is confirmed as a currently responding public API base by the live
`/2/sources/`, `/2/editorSearch/`, `/2/cards/`, `/2/DFCPairs/`, and
`/2/cardbacks/` calls above. It did **not** serve the current upstream `/3`
search route during this probe. Treat the chosen host as an external provider
configuration, not a permanent API guarantee, and preserve a safe degraded
state if it changes or becomes unavailable.

## Protocol found in upstream source and compared with live behavior

The current public `master` frontend source describes this flow:

1. Current frontend source sends `POST {base}/3/editorSearch/` with
   `searchSettings` and `queries` keyed by a computed query hash. The live host
   returned 404 during this spike.
2. The current frontend falls back to `POST {base}/2/editorSearch/` after a v3
   404 or caught request failure. The legacy request uses a query array; the
   v2 response is nested by query and card type. A correctly shaped v2 request
   returned live results. The upstream backend source says this legacy route
   is retained for backward compatibility, is not covered by automated tests,
   and may be removed. This is the principal stability risk.
3. `POST {base}/2/cards/` with selected identifiers hydrates card records; this
   succeeded live for returned IDs.
4. `GET {base}/2/sources/`, `GET {base}/2/DFCPairs/`, and
   `POST {base}/2/cardbacks/` were all exercised successfully as described
   above.

The upstream frontend includes a same-origin credentials mode and a CSRF
header helper on its calls. The inspected backend marks the relevant handlers
CSRF-exempt, and the live API search, hydration, DFC, and cardback requests
succeeded without cookies, credentials, or a CSRF token. Upstream code sets
`EDITOR_SEARCH_MAX_QUERIES` to 300 and `CARDS_PAGE_SIZE` to 1000. The frontend’s
`maximumSize: 30` and `maximumDPI: 1500` are search filters, not verified hard
limits for an original download. No explicit browser fetch timeout or
published rate-limit contract was found in the inspected code.

### Sanitized request and response schema

The v3 example and field names are reduced from current upstream
TypeScript/Python schemas; the live host returned 404 for that route. The v2
query-array shape and `/2/cards/` identifier list were used in the live probes;
the payload below is sanitized, not a verbatim response capture. `<query-hash>`,
`<source-pk>`, and `<card-id>` are placeholders. The numeric source ID below is
synthetic.

```json
{
  "searchSettings": {
    "filterSettings": {
      "minimumDPI": 0,
      "maximumDPI": 1500,
      "maximumSize": 30,
      "includesTags": [],
      "excludesTags": [],
      "languages": []
    },
    "searchTypeSettings": {
      "fuzzySearch": false,
      "filterCardbacks": false
    },
    "sourceSettings": { "sources": [[123, true]] }
  },
  "queries": {
    "<query-hash>": { "query": "<card query>", "cardType": "CARD" }
  }
}
```

The v3 response schema is source-derived and was not observed live:
`{ "results": { "<query-hash>": ["<card-id>"] } }`. The live v2 request had
`queries: [{ "query": "Sol Ring", "cardType": "CARD" }]`; its summarized
response shape was `{ "results": { "Sol Ring": { "CARD": ["<card-id>",
"…"] } } }`.

The current upstream frontend derives the v3 map key from the full
`SearchQuery` fields (`cardType`, `query`, `expansionCode`, and
`collectorNumber`) using a 32-bit FNV-1a correlation hash. TCGPrint reimplements
that serialization for the exact query object it sends; it does not reuse the
upstream implementation. The live public host returned 404 for v3, so the key
behavior is source-derived rather than live-validated.

Hydration is described as:

```json
{"cardIdentifiers": ["<card-id>"]}
```

The live hydration request used `{"cardIdentifiers":["<card-id>"]}` and
returned HTTP 200. Its summarized response shape was
`{ "results": { "<card-id>": { "identifier":
"<card-id>", "cardType": "CARD", "name": "…", "sourceName": "…",
"sourceType": "…", "extension": "…", "size": 0, "dpi": 0,
"smallThumbnailUrl": "…", "mediumThumbnailUrl": "…" } } }`.

The source schema also includes tags, language, source IDs/names, and optional
canonical-card metadata. The hydrated live records included identifier, card
type, name, source type, extension, size, DPI, and thumbnail fields. Other
field presence, null handling, and general ordering guarantees remain
unverified.

## IDs and XML compatibility

The current backend model makes `Card.identifier` unique within its database
and limits it to 200 characters. Treat it as an opaque provider asset ID, not a
Magic Oracle ID or canonical card ID; upstream does not document a
cross-rebuild persistence guarantee. A live search ID hydrated under the same
key by `/2/cards/` was reported as `sourceType: Google Drive` and resolved
through the tested Google Drive thumbnail and original paths. All 279 sources
in the live source listing used Google Drive, although upstream schemas also
define other source types; unsupported future source types must not be guessed.

The upstream desktop tool treats the XML `<card><id>` value as its `drive_id`:
for Google Drive it uses the Google Drive API, and it also accepts a local file
path. Its source logs a `drive.google.com/uc?id=…&export=download` URL on
download failure, while the actual desktop download uses
`files().get_media(fileId=…)`. TCGPrint's importer reads the XML `<id>` and
preserves that exact string as both `providerAssetId` and `selectedArtworkId`;
its internal `ImportedAsset.id` remains a separate identifier. This is
compatible with the live API's opaque Google Drive IDs and `/2/cards/` lookup.
The mapping was established from source and a live API ID, not by round-tripping
a production-generated XML file; the committed XML fixture contains synthetic
IDs only. The shared root `<cardback>` is also kept as an external reference;
existing imports stay reference-only unless local image bytes are already
supplied.

## Previews, originals, formats, and size bounds

Current card schemas expose `smallThumbnailUrl` and `mediumThumbnailUrl`, plus
`extension`, `size`, and `dpi`; they do not expose an original download URL or
MIME type. The live small-thumbnail field contained a `sz=w400-h400` request
and resolved to a PNG through Google's image host; decoded pixel dimensions
were not measured. The upstream CDN's `/full/...jpg` route returned a smaller
PNG rendition for the sample and is not suitable as a byte-preserving original.
The independently constructed Google Drive download URL returned a PNG whose
byte length matched the hydrated metadata for that one sample. It redirected
to `drive.usercontent.google.com`; original retrieval must allowlist and
validate redirects and bytes rather than trust an arbitrary metadata URL.

The suffix `.jpg` on the tested CDN full route returned `Content-Type:
image/png`, so extension alone is not reliable format evidence. The one tested
original's HTTP MIME and PNG signature agreed. JPEG/WebP variants and other
sources were not tested. Upstream frontend defaults define `maximumSize: 30`
and `maximumDPI: 1500`; these are search filters, not hard original-download
limits. Apply a TCGPrint byte cap while streaming and
validate MIME plus file signature. The live `Sol Ring` query returned 713 IDs;
limit candidate hydration and never download originals to fill the grid.

## DFC and cardback behavior

Upstream source defines `CARD`, `TOKEN`, and `CARDBACK` query types. The live
`/2/DFCPairs/` endpoint returned 508 front-name/back-name pairs; searching one
pair yielded independent identifiers for both faces, each hydrated as a
`CARD`. The live `/2/cardbacks/` endpoint returned 482 IDs; `/2/cards/`
hydration confirmed the `CARDBACK` type. The behavior supports independent
front/back candidates and a separate shared cardback reference; no DFC or
cardback original bytes were downloaded during this spike.

The upstream XML model has separate `<fronts>` and `<backs>` collections with
slot values and a root `<cardback>` identifier. TCGPrint currently pairs an
explicit back record to a front only by shared slot; ambiguous/missing records
are retained with warnings rather than guessed. It retains the root cardback
reference without downloading it. An upstream default-cardback policy,
redirect behavior, and byte availability remain unverified.

## Cache, provenance, and offline behavior

No upstream API cache lifetime, change token, or offline guarantee was
established. A thumbnail URL or identifier is not an offline original. If an
online provider is later approved, TCGPrint should persist provenance and
metadata separately from validated original bytes, and only cached original
bytes should be considered exportable offline. Unresolved MPC XML references
must remain visible as references and must not be substituted for print-ready
art. This matches ADR 0005; no cache or provider code was changed here.

## Failures and stability limits

- The current live service served the versioned v2 search fallback but returned
  404 for v3, despite current upstream `master` using v3 first. The v2 route is
  explicitly described in upstream source as backward-compatibility-only and
  subject to removal; this is a high external-change risk, not a stable API
  guarantee.
- `/2/editorSearch/` with the wrong (v3-shaped) body returned HTTP 400; the
  correctly shaped v2 query-array body returned HTTP 200. Keep protocol
  versions and response parsers distinct.
- Search, card hydration, DFC, cardback, thumbnail, and one original request
  completed without credentials. Timeout behavior, 429 handling, rate limits,
  CORS constraints, asset revocation, and reliability across multiple files
  remain unverified.
- A single successful original download does not establish that every
  community asset is public or that Drive's redirect contract will remain
  unchanged. Failures must preserve the selected MPC reference and surface
  provider degradation; never replace it with Scryfall.
- A single source snapshot does not establish an API compatibility promise.
- The public `master` source and public pages can change independently of this
  ADR; recheck before any implementation.
- No authentication, WAF, or other security control was bypassed.

## Current TCGPrint A1 behavior and limits

The independent provider implementation on the Phase 5.5 integration branch
uses MPCFill as an external backend.
The upstream frontend supports choosing a backend URL, while TCGPrint's
provider accepts a `baseUrl` option but pins API requests to its HTTPS
`mpcfill.com` host allow-list; arbitrary hosts are intentionally rejected.
This is an integration safety boundary, not a guarantee about future upstream
configuration or service ownership.

The live `/3/editorSearch/` probe returned HTTP 404. TCGPrint currently retries
with the legacy `/2/editorSearch/` request shape only for that explicit 404.
Unlike the inspected upstream frontend, TCGPrint does not fall back to v2 after
an arbitrary caught request failure: timeout, network failure, 5xx, invalid
response, or unsafe redirect degrades the provider and returns already-hydrated
MPC references when available; without references, the search fails visibly.
Cached search metadata may still serve results for its configured TTL. If the
v2 endpoint is removed or stops responding, new uncached searches will degrade
or fail under the same behavior. There is no silent fallback to Scryfall, and
selected MPC references are preserved.

The backend is externally operated and its API stability remains an external
risk. `/2/editorSearch/` is a compatibility route, not a promised future
contract. No future availability, compatibility, or community-artwork
distribution right is asserted here.

## License implications

The upstream repository's `LICENSE.md` is GNU GPL version 3. No upstream code
was copied into TCGPrint; this document records interface facts and sanitized
schemas only. The technical A1 client is approved only as an independent
protocol implementation, not by copying/adapting upstream code. This ADR does
not decide whether use or redistribution of community-contributed artwork
meets TCGPrint's content-rights requirements; that remains outside the
technical gate and must not be represented as cleared. No license workaround
is proposed.

## Alternatives

- Keep current MPC XML support reference-only, as ADR 0005 specifies. This
  preserves imported choices and works offline without claiming missing
  originals are available.
- Continue using user uploads and the separately approved Scryfall provider
  for locally cached print originals.
- Implement a small independently written MPC client against the observed
  versioned protocol, with explicit compatibility and degradation behavior.
- Do not vendor or adapt upstream GPL implementation code as part of this
  provider spike.

## Historical A1 gate recommendation

**APPROVED WITH CONDITIONS — proceed to Phase 5.5 A1 as an independently
written protocol client.** The live public service is reachable at
`https://mpcfill.com`; `/2` search, `/2/cards/` hydration, DFC/cardback
metadata, a separate thumbnail, and one original download were observed
without credentials. The protocol is identifiable and versioned, not scraping.

Conditions for A1:

1. Prefer the current `/3/editorSearch/` contract, then use the known `/2`
   legacy array request only when v3 is absent (404); keep the response
   parsers separate. The live deployment currently requires v2, which is
   deprecated upstream and may be removed. Treat failure/removal as MPC
   degradation, not as a reason for a silent Scryfall substitution.
2. Use hydrated identifiers and allow only verified Google Drive assets for
   this implementation. Construct original-download URLs from validated IDs;
   validate redirect hosts, response size, MIME and magic bytes. Do not use the
   CDN `/full` rendition as the original.
3. Keep thumbnail retrieval separate from lazy original retrieval; persist
   original response bytes immutably with hash and provenance. Cache is the
   offline path; no upstream offline/cache guarantee was found.
4. Do not copy or adapt upstream GPL-3.0 implementation code. This spike used
   source inspection and protocol observations only. Rights for community
   artwork and any redistribution remain outside the technical protocol
   decision and must not be represented as cleared by this ADR.
5. Keep all live service dependence out of CI: use fake HTTP for provider
   tests, enforce timeouts/byte caps, and surface useful degraded health.

The gate is technical approval to begin A1, not a claim that the external
service is stable or that community artwork has cleared content rights.

## Phase 14 protocol revalidation (2026-10-02)

The protocol was rechecked before Phase 14 implementation with a low-volume,
unauthenticated probe against `https://mpcfill.com`. The inspected upstream
`master` still resolved to `ceb7c3b2f39b8c8caebe396ec87f2bddba6c3743`, the
snapshot recorded above. No raw API response or artwork bytes were stored.
Catalog and hydration bodies were parsed in memory and only sanitized shapes
were retained. The thumbnail and original checks requested at most the first
32 bytes; no full original was downloaded.

| Probe | Observed result |
| --- | --- |
| `GET /2/sources/` | HTTP 200, `application/json`, `{results: object}` with 279 source records; all 279 were `Google Drive`. |
| `GET /2/languages/` | HTTP 200, `application/json`, `{languages: array}` with 11 records shaped with `code` and `name`. |
| `GET /2/tags/` | HTTP 200, `application/json`, `{tags: array}` with 6 records; records included `name`, `aliases`, `children`, `parent`, and `isEnabledByDefault`. |
| `POST /3/editorSearch/` | HTTP 404, `text/html`; no v3 result schema was returned. |
| `POST /2/editorSearch/` | HTTP 200, `application/json`; the legacy query-array body returned `{results: {query: {CARD: string[]}}}`. One `Sol Ring` query returned 716 valid opaque IDs. |
| `POST /2/cards/` | HTTP 200, `application/json`; one requested identifier was hydrated under `results[identifier]`. |
| Small-thumbnail range request | HTTP 206, `image/png`; redirected once from `drive.google.com` to `lh3.googleusercontent.com`. Only a 32-byte range was requested. |
| Original range request | HTTP 206, `image/png`; redirected once from `drive.google.com` to `drive.usercontent.google.com`. The 32-byte range had a PNG signature; the response advertised a 12,652,704-byte total object. No full object was read. |

The hydrated sample had these fields and JSON types: `dpi` (number),
`sourceId` (number), `sourceName` (string), `sourceType` (string), `tags`
(array), `language` (string), `priority` (number), `dateCreated` (string),
and `dateModified` (string). Its source was Google Drive, its declared
extension was PNG, its declared DPI was 1200, and its tags array was empty.
`canonicalCard` and `canonicalArtist` were omitted from this particular
record; this does not establish that optional canonical metadata is absent
from all records. The source and language references matched their catalog
entries. The live sample therefore confirms that source, tag, language, DPI,
priority, and timestamp metadata are available for candidate provenance, but
metadata still does not validate locally stored image bytes.

This revalidation confirms the historical protocol-version behavior rather
than changing it: `/3/editorSearch/` remains unavailable on the public host,
and `/2/editorSearch/` remains usable with its legacy body. The existing rule
to fall back only on an explicit v3 404 remains in force; timeout, network,
server, redirect, or schema failures must not cause an unsafe protocol
downgrade. These few requests do not establish an availability guarantee,
rate-limit policy, full-asset integrity, or future compatibility.

## Phase 14 initial implementation decisions

This section records the initial Phase 14 behavior. The later advanced ranking,
diagnostic, and batching contracts in [ADR 0017](0017-mpc-advanced-provider.md)
extend these decisions and take precedence where their details differ.

The Phase 14 provider extends the existing independent
`artwork/mpc-provider.ts` implementation. `ArtworkCatalog`, its generic
provider contract, and the project selection model remain shared. No upstream
implementation code was copied. Live MPC is not used by CI.

The TCGPrint filter contract contains minimum/maximum declared DPI, verified
Google Drive source IDs, include/exclude tags, and language codes. It also
accepts source, language, and tag preferences used only for ranking. Inputs are
strictly bounded, normalized, checked against catalog values before query
construction, and translated into MPC's fixed `filterSettings` and source
boolean list. Hydrated metadata is checked locally against the same filters:
all requested include-tags must match, any excluded tag removes a candidate,
and non-default DPI, language, or tag filters require the corresponding
validated metadata. The default 0–1500 DPI search retains candidates whose
remote record omits DPI to preserve the basic-search behavior. Defaults remain
a fixed 30 MB search size, exact name search, and all currently verified
Google Drive sources.
Search keys include the normalized query, face, all filters and preferences,
verified source IDs, the fixed size bound, and protocol/ranking behavior
versions. Set-like arrays are sorted; explicitly ordered language/source
preferences retain their order.

Candidate ranking is a stable lexicographic order: preferred source order,
preferred language order, descending count of preferred tags, exact canonical
set plus collector printing, descending upstream priority, descending
provider-declared DPI, and ascending stable candidate ID. There are no hidden
numeric weights. Declared DPI is provenance and ranking metadata; only
validated local original pixels produce `effectiveDpi`. Imported MPC
references remain ahead of search results in their existing order. Ranking
never changes a `SelectedArtwork`; refresh and filter changes only update or
order catalog candidates.

Sources, languages, and tags use independent metadata-cache keys with an
explicit 24-hour TTL. Source cache contents include only validated Google
Drive sources. Catalogs are loaded when needed by filters or the filter
catalog endpoint, not as a prerequisite for an unfiltered search. Expired
catalogs may be used as stale validated values during an outage, with a
provider-specific degraded diagnostic. Catalog metadata never shares a key or
storage record with thumbnails or originals.

Explicit candidate refresh performs `/2/cards/` metadata hydration only. It
does not fetch thumbnails or originals. Removed, invalid, or unsupported
remote metadata marks the candidate status while preserving the candidate ID
and any validated local original. A corrupt local original is detected during
validation and is fetched again only through an explicit original retrieval
operation, using the existing HTTPS host/redirect, size, MIME, magic-byte,
decoder, and SVG-to-PDF checks. Local content hash and provider provenance
remain in the existing immutable-original storage records.

MPC diagnostics are provider-specific and do not extend `ProviderHealth` for
Scryfall or uploads. They expose only bounded status enums, timestamps,
catalog-cache age/state, and search cache hit/miss counters. They omit URLs,
asset bytes, local paths, cookies, credentials, and arbitrary error text.

Batching was reviewed against the current workbench flow. A gallery request
searches one identity/query at a time, while each resulting search already
hydrates its selected IDs in one bounded `/2/cards/` request (at most 30 IDs
in TCGPrint). There is no current user flow that queues multiple compatible
identity searches, so a cross-request search batching coordinator would add
state and cancellation complexity without a demonstrated gain. No unlimited
parallelism or bulk thumbnail/original download was introduced. The existing
bounded hydration of search results remains in place.

## References

- [Upstream repository](https://github.com/chilli-axe/mpc-autofill)
- [Upstream GPL-3.0 license](https://github.com/chilli-axe/mpc-autofill/blob/master/LICENSE.md)
- [Frontend backend selection](https://github.com/chilli-axe/mpc-autofill/blob/master/frontend/src/features/backend/useBackendSetter.ts)
- [Frontend API calls and v3-to-v2 fallback](https://github.com/chilli-axe/mpc-autofill/blob/master/frontend/src/store/api.ts)
- [Frontend API schemas](https://github.com/chilli-axe/mpc-autofill/blob/master/frontend/src/common/schema_types.ts)
- [Frontend search settings and size/DPI defaults](https://github.com/chilli-axe/mpc-autofill/blob/master/frontend/src/common/constants.ts)
- [Backend card identifiers and serializers](https://github.com/chilli-axe/mpc-autofill/blob/master/MPCAutofill/cardpicker/models.py)
- [Backend API views](https://github.com/chilli-axe/mpc-autofill/blob/master/MPCAutofill/cardpicker/views.py)
- [Upstream desktop download flow](https://github.com/chilli-axe/mpc-autofill/blob/master/desktop-tool/src/io.py)
- [Upstream current public app](https://mpcfill.com/)
- [Upstream GitHub Pages frontend](https://mpcautofill.github.io/)
- [ADR 0005: card identity, selected artwork, and local cache](0005-card-identity-artwork-cache.md)
