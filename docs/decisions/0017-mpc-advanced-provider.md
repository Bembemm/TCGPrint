# ADR 0017: MPC advanced artwork provider

- Status: Accepted for Phase 14
- Date: 2026-10-03
- Scope: advanced behavior for the existing MPC Artwork Provider
- Supersedes: no earlier ADR; this records Phase 14 extensions to ADR 0006

## Decision

Phase 14 extends the one existing `MpcArtworkProvider`. It does not add a
second MPC provider, alter the generic `ArtworkProvider` contract, change
candidate ID generation, or add a Project schema version. MPC-only search,
revalidation, capability, and diagnostic contracts stay in the MPC adapter and
catalog extension.

The implementation treats MPC as an external community service without an SLA.
Search ordering, metadata, image URLs, permissions, catalog contents, and route
availability can change independently. A successful request proves only that
one response was accepted at that time.

## Protocol evidence and routes

The low-volume live observations in [ADR 0006](0006-mpc-artwork-provider.md)
recorded on 2026-09-26 are the protocol evidence used here. They observed
`https://mpcfill.com`, `/2/sources/`, `/2/editorSearch/`, `/2/cards/`, Google
Drive originals, and allowlisted Google thumbnail redirects. The public
`POST /3/editorSearch/` route returned 404 at that probe time, while the v2
query-array shape worked. This is historical evidence, not a claim about
current service behavior.

Current request policy is:

1. Try `POST /3/editorSearch/` with the v3 keyed-query shape.
2. Try `POST /2/editorSearch/` with its legacy query-array shape only when v3
   returns HTTP 404. A 429, 5xx, network error, malformed response, or unsafe
   redirect never triggers a protocol fallback.
3. Hydrate returned IDs through `POST /2/cards/`, in chunks of 20, with at most
   three chunks active within a batch and at most four provider requests active
   per provider instance.
4. Read verified filter catalogs through `GET /2/sources/`, `/2/languages/`,
   and `/2/tags/` when required. Catalogs are bounded and cached for 24 hours.

A low-volume live smoke on 2026-10-03 observed `GET /2/sources/` return HTTP
200 with 279 verified Google Drive sources and `POST /3/editorSearch/` return
HTTP 404 with HTML. The application's documented v2 fallback then returned
search candidates, `/2/cards/` hydration succeeded, and the allowlisted
thumbnail and original routes returned bytes that passed local validation.
The picker applied the declared-DPI/source filters and provider ordering,
preserved the prior selection until an explicit choice, displayed candidate
metadata, revalidated it, and exported a PDF through the existing pipeline.
The JSON diagnostics report returned schema version 1 within its size bound.
The exported image/PDF bytes and raw responses were kept out of the repository
and temporary smoke data was removed. Offline export after metadata expiry is
covered by the deterministic test that runs the real export handler while the
MPC transport is unavailable; the live service was not deliberately taken
offline.

The live probe did not establish the maximum batch size supported by MPC, API
rate policy, retry policy, ordering guarantees, or guaranteed response
completeness. The chunk size and concurrency limits above are TCGPrint safety
limits, not upstream guarantees.

## Capabilities and filters

`MpcProviderCapabilities` is MPC-specific. It reports search, preview, original,
DPI, source, tag, language, and protocol capabilities. A capability becomes
visible only after the corresponding behavior or non-empty verified catalog
has been observed. Empty or unavailable tag/language catalogs do not advertise
those controls. Capabilities describe observed/configured support, not future
availability of a remote asset.

Search sends minimum/maximum DPI, selected tags, languages, and source choices
in the provider request. TCGPrint also checks hydrated records locally because
the service may return broader results. Missing metadata does not satisfy an
active filter. Preferences only affect ordering; they do not change the filter
set or the selected artwork.

No metadata is invented. Declared MPC DPI remains `metadata.dpi`; effective DPI
is calculated only from dimensions of locally validated original bytes. A
missing or malformed metadata value remains unknown. Tag/language capability
requires a verified non-empty catalog.

## Ranking and selection

The provider's returned ID position is saved as `providerRank` when search
results are hydrated. Metadata refresh keeps that signal because `/2/cards/`
does not provide the original search position.

Balanced ordering is an explicit lexicographic comparator:

1. preferred source, language, and preferred-tag matches;
2. exact canonical printing match when both sides have that metadata;
3. validated local-original cache state;
4. known PDF exportability, then remote availability;
5. measured effective DPI when available;
6. provider priority and declared DPI;
7. upstream `providerRank`;
8. stable candidate ID.

The `provider` ordering mode applies explicit preferences, then `providerRank`,
then stable ID. Unknown values stay unknown. Neither ordering mode writes or
changes `selectedArtwork`, imported MPC references, face selection, or Project
state. Ranking changes only the candidate list. The cache key includes the
normalized filters, preference order, ranking mode, face, query, verified
source set, maximum size, protocol behavior version, and ranking version.

## Freshness, stale cache, and negative caching

Catalog freshness is represented as fresh, stale, unavailable, or empty with a
bounded age. Expired catalogs may be served from stale cache while the provider
is offline; health stays degraded even if a separate operation succeeds.
Successfully refreshing all expired catalogs clears that catalog degradation.

Candidate metadata exposes `metadataCheckedAt` and a freshness value of fresh,
stale, or revalidated. Search results are marked stale when served from expired
search cache after a remote failure. Stale metadata never removes a local
content-addressed original.

Stale-while-offline applies only to expired positive search results. An expired
negative entry (a valid empty result) is not returned as stale: after its
30-second TTL the provider must try MPC again, and a transient or protocol
failure remains a failure/degraded state rather than appearing as no results.

Only a successful, valid empty search is negative-cached, for 30 seconds. A
positive search cache entry lasts 24 hours. MPC does not expose a distinct,
verified per-asset not-found route: an omitted `/2/cards/` result is treated as
the existing removed-reference signal, recorded as degraded/omitted, and is
not used to suppress later revalidation requests. Timeouts, network failures,
429, 5xx, malformed protocol, and unsafe responses are never written as empty
search results or negative cache entries.

## Revalidation and batch hydration

Revalidation returns one structured result per unique candidate ID, including
status, candidate ID, provider asset ID, local-original state, safe failure
kind, and the updated/retained candidate when available. Statuses distinguish
unchanged, metadata-updated, remote-missing, remote-unavailable,
local-original-valid, local-original-corrupt, and unsupported. Duplicate
candidate references sharing a `providerAssetId` cause one hydration request
per unique asset, then map back to their candidate IDs.

Hydration accepts at most 500 input IDs, deduplicates them, rejects extra or
unrequested response IDs, and chunks requests at 20 IDs with concurrency three.
Partial valid responses retain valid documents, increment omitted-ID
diagnostics, degrade health, and are not cached as complete healthy searches.
Transient chunk failures are isolated per chunk. Revalidation reads only local
original validation metadata and does not download original image bytes.

There is no cross-query `/2/cards/` batch queue. The current user path submits
one identity search at a time, while batch revalidation coalesces repeated
provider asset IDs. The deterministic request-count fixture records this
boundary instead of claiming that independent identities are combined.

## Coalescing, cancellation, retries, and rate limits

Identical MPC API requests and identical thumbnail/original fetches share one
in-flight operation. Each caller has an independent subscription: cancelling
one caller does not abort another; the shared transport aborts when its last
consumer leaves. Resolved and rejected entries are removed. A bounded semaphore
limits active provider operations to four; per-batch work uses at most three
workers.

GET/POST requests used for search, hydration, and image fetch may retry a
bounded maximum of two times for network errors, 5xx, and 429. Backoff is
bounded; `Retry-After` is parsed and capped at two seconds. A 429 is a distinct
`rate-limited` error and maps to HTTP 429. No retry occurs for abort, timeout,
unsafe redirect, malformed protocol, invalid image, unsupported format, or
other non-transient validation failure. Retry waits honor cancellation. These
are local client limits, not upstream recommendations.

## Health, diagnostics, and logging

`ProviderHealth` reflects the provider's current health plus stale-catalog
degradation. `ArtworkCatalog.getProviderHealth()` synchronizes provider state
on reads and clears a catalog override after the provider itself reports a
degraded-to-healthy recovery. MPC public health text is fixed and contains no
upstream error message.

Diagnostics are bounded and contain protocol/fallback state, observed
capabilities, catalog counts and freshness, cache hit/miss counts, HTTP status
counts, timeouts, protocol failures, rate limits, request/batch/revalidation
counts, omitted hydration count, concurrency gauges, last successful contact,
and up to 20 recent safe failure kinds. `GET
/api/cards/artworks/mpc-diagnostics/report` returns schema version 1 JSON capped
at 8 KiB. `lastSuccessfulContactAt` advances only after a bounded HTTP response
from the remote service (including the explicit v3-404 fallback signal);
`lastSuccessfulAt` separately records the most recent successful provider
operation, including a cached search. The report allowlists values; it excludes URLs, paths, bodies, image
bytes, raw XML, credentials, and arbitrary upstream strings.

The repository has no shared structured logging interface for provider events.
Phase 14 uses bounded diagnostic counters and failure summaries instead of
adding a logging framework or writing raw provider data to application logs.

## Offline behavior, storage, and compatibility

Imported MPC identity references and candidate IDs remain stable. Original
files stay content-addressed and immutable. Metadata refresh can update
candidate metadata but never deletes a local original or rewrites its bytes.
Selection is not replaced when remote metadata disappears or the provider is
offline. Export reads validated local originals through the existing storage
and PDF paths; MPC failures do not block Scryfall, uploads, Projects, or local
exports.

Browse filters and ranking are request/UI state and are not serialized into a
Project. The Project schema remains unchanged. Per-face artwork and manual
physical backs continue to use the existing selection model. The PDF engine,
JPEG passthrough, bleed generation, rounded corners, and duplex composition are
not modified by this decision.

## Security and known limits

The API host is pinned to HTTPS `mpcfill.com`. Thumbnail and original redirects
are manually checked against existing exact host allowlists. Requests omit
cookies and credentials, cap response bytes, validate content types/signatures,
and use bounded timeouts. Candidate DTOs and diagnostics use allowlists. Upstream
text is not copied to health messages, error bodies, diagnostics, logs, Project
state, or artifacts.

The service can still change its routes, JSON shapes, catalog values, source
permissions, ranking, metadata quality, or remote files without notice. MPC may
return incomplete hydration or inaccurate declared DPI/size/format; local
validation remains authoritative for cached/exported originals. No current
availability SLA, rate-limit quota, permanent source availability, provider
rank guarantee, or future route compatibility is claimed.
