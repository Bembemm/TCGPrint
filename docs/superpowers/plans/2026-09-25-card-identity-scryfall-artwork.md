# Card Identity, Scryfall, and Artwork Switching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Turn the Fase 4 import result into a session-scoped Magic working set whose card identities and selected face artworks are independent, and export selected original assets through the existing print pipeline.

**Architecture:** Keep one stable WorkingCard per imported entry in browser session state. Node services adapt ImportResult, resolve identities, query Scryfall, aggregate upload/Scryfall/MPC candidates, and persist only provider metadata and content-addressed assets. Export accepts safe IDs and quantities, loads validated originals server-side, expands quantities only while composing, then calls the existing BleedEngine and LosslessPdfEngine.

**Tech Stack:** TypeScript, Next.js Node.js routes, better-sqlite3, filesystem content-addressed assets, Sharp for image validation and thumbnails, fake HTTP in tests, and a lazy OCR adapter. Tesseract.js, its WASM core, and the English model are externalized to the Node server; no Projects/autosave or MPC online provider.

**Spec:** IMPLEMENTATION_PLAN.md sections 19–34, 58–64, 120, 134–146, 150–154; the approved Fase 5 request and architectural constraints in the task conversation.

## Global Constraints

- The Working Set is session state; SQLite is only for provider metadata, provenance, artwork originals/thumbnails, and upload deduplication.
- Do not add Project, autosave, or editor-complete tables or flows.
- No filesystem path is returned to or accepted from the UI; APIs exchange DTOs and opaque IDs.
- SHA-256 identifies originals; internal paths derive only from validated hashes/IDs; repeated bytes occupy one original file.
- CardIdentity and artwork selection are separate values. WorkingCard.id and CardIdentity.id remain unchanged when artwork changes.
- Fixing identity never deletes or rewrites an uploaded original; user confirmation locks identity against later automatic resolution.
- Keep one WorkingCard per ImportedEntry with original order, quantity, section, import source, printing hints, and MPC references.
- Quantity expands only for physical PDF composition.
- Scryfall calls only pass through ScryfallClient/provider, HTTPS, explicit TCGPrint User-Agent and Accept, central rate limiting, configurable timeout, AbortSignal, typed errors, and bounded retries (no infinite retry).
- Scryfall metadata is mapped to domain models; raw provider objects do not escape the mapping boundary.
- Artwork thumbnails and originals have distinct IDs, storage records, and API routes; thumbnail data is never an export fallback.
- An exportable artwork must be fetched or loaded as an original, byte-validated and fully decoded before it enters the PDF.
- Resolve inputs in order: explicit Scryfall ID, set plus collector number, explicit imported card name, filename suggestion, local OCR, deterministic fuzzy candidates, human confirmation.
- Filename text only creates a search query; a provider-validated exact filename match may resolve, while fuzzy filename/OCR results stay suggestions until human confirmation.
- Scryfall default selection priority: (a) retain any selected artwork; (b) if there is no selection, honor an explicit Scryfall ID; (c) otherwise honor set+collector; (d) only then choose a default for a name-resolved identity. For (d), use the newest non-digital English high-resolution printing with usable original art, sorting ties by release date descending, set code, collector number, and Scryfall UUID. Record the policy on the selection. Never replace upload/MPC selections.
- DFC/MDFC faces are mapped and selected independently. Duplex is out of scope.
- MPC Autofill references, slots, ordering, and selectedArtworkId from Fase 4 are preserved and never looked up/downloaded online.
- Local image bytes remain immutable. JPEG is not recompressed, PNG sample depth remains intact, SVG stays on the existing vector path where compatible.
- Reuse BleedEngine, existing geometry/placement, CutGuideEngine, and LosslessPdfEngine; do not recreate their rules.
- Tests never call Scryfall. HTTP uses injected fake fetch responses.
- Excluded: full Editor, Projects/autosave, URL adapters, online MPC, silhouette, registration, duplex, or printer calibration.

## OCR Spike Notes

The native Tesseract executable is not installed here and would be a separate platform-specific install. A temporary install of tesseract.js 7.0.0 succeeded outside the repository: npm reports Apache-2.0 and 1,411,341 unpacked bytes for tesseract.js; tesseract.js-core 7.0.0 is Apache-2.0 and 45,262,431 unpacked bytes. On Node.js 22.22.1 a local worker recognized a synthetic title band exactly as “SOL RING”. The API documents Node workers from Node 16 onward, explicit workerPath/corePath, and cachePath for Node language data. The probe showed default traineddata was written into the current working directory, so production sets a dedicated app-local OCR cachePath. A real adapter smoke initially failed when the Node worker tried to fetch the English model from a CDN; package @tesseract.js-data/eng 1.0.0 (MIT, 13,876,967 unpacked bytes) now ships the model locally, avoiding runtime model-network dependency. Next externalizes Tesseract, core, and model packages so worker/WASM paths remain addressable. The Node/WASM option avoids requiring a separately installed native executable, despite its large core and model. It remains dynamic-imported behind OcrRecognizer and runs only after filename/metadata are insufficient. Recognition reads a temporary top title-band crop and does not mutate or send the source image. This workspace has no Termux/proot runtime, so that compatibility is unverified; Node 24 is unverified and OCR failure remains isolated from import/export.

## Review Focus

- Malformed or hostile Scryfall JSON, rejected API and image URLs, non-image bodies, byte-limit overruns, timeouts, abort, 404/429/5xx must become typed provider outcomes without breaking local candidates or cached export.
- A deck entry with Scryfall ID or set+collector must select that printing; an exact imported name can resolve; fuzzy and filename results need human confirmation.
- Refreshing candidate lists must retain a current selection; switching Scryfall/upload changes neither WorkingCard.id nor CardIdentity.id and must preserve all local assets.
- DFC cards without root image_uris must map each card_faces image correctly; front and back may select independent sources.
- MPC entries with providerAssetId/selectedArtworkId but no bytes remain visible as reference-only and are never silently changed or exported as a fake image.
- Repeated quantities stay compact until export; nine cards with 0.625 mm bleed fit one A4 page, and later cards flow through the existing page placement.
- Offline export succeeds for cached originals and uploads; provider outage degrades Scryfall while local artwork and PDF remain usable.

## File Structure

- core/cards/types.ts: stable CardIdentity, CardFace, artwork and resolution models.
- core/cards/working-set.ts: deterministic ImportResult to session WorkingCard mapping and immutable WorkingCard updates.
- core/cards/identity-policy.ts, filename-resolver.ts, fuzzy-matcher.ts, identity-resolver.ts: centralized resolution policy and cost-ordered resolver.
- providers/scryfall/types.ts, mapper.ts, errors.ts, rate-limiter.ts, client.ts: normalized Scryfall transport boundary.
- artwork/types.ts, scryfall-provider.ts, local-provider.ts, mpc-reference-provider.ts, catalog.ts: provider contract and catalog aggregation.
- artwork/storage/: safe local data paths, SQLite migrations/repositories, SHA-256 original store and separately typed thumbnail store.
- providers/ocr/types.ts and tesseract-recognizer.ts: lazy local OCR adapter, isolated from core and imported only on demand.
- services/card-workbench.ts and services/card-export.ts: server-side composition; no UI imports persistence/provider internals.
- src/app/api/cards/**: Node routes accepting DTOs/opaque IDs and returning DTOs/bytes; no arbitrary file path inputs.
- src/app/card-identity-workbench.tsx, src/app/page.tsx, src/app/globals.css: compact import/identity/artwork workbench.
- tests/core/cards/**, tests/providers/scryfall/**, tests/artwork/**, tests/providers/ocr/**, tests/services/**, tests/app/**: deterministic fakes and synthetic fixtures.
- docs/decisions/0005-card-identity-artwork-cache.md: identity/art separation, cache provenance, default artwork policy, face mapping, and OCR findings.

## Task 1: Card Domain and Import-to-Working-Set Adapter

**Files**
- Create: core/cards/types.ts
- Create: core/cards/working-set.ts
- Create: tests/core/cards/working-set.test.ts
- Modify: package.json only if a small UUID helper is actually needed (prefer node:crypto randomUUID).

**Interfaces**
- Consumes: ImportResult, ImportedEntry, ImportedAsset, ImportedFace from import-engine/types.ts.
- Produces: CardIdentity, CardFace, ArtworkSource, ArtworkCandidate, SelectedArtwork, WorkingCard, IdentityResolution, IdentityResolutionCandidate, IdentityResolutionStatus, createWorkingSet(result, options?), and selectArtwork(workingCard, faceId, artwork). ProviderHealth belongs to the artwork/provider contract in Task 4.

Types encode identity, selected artwork, and face data independently. WorkingCard includes id, quantity, order, section, original import source metadata, identity resolution, optional confirmed identity, separate front/back selections, and MPC reference fields. createWorkingSet emits one card per ImportedEntry, preserves entry order and quantity and uses an injected ID factory in tests; it never expands copies.

- [x] Write tests asserting deck entries preserve order, quantity, section, set/collector/Scryfall hints and each import entry maps to one stable WorkingCard.
- [x] Write tests asserting MPC front/back slots and IDs remain reference-only when no bytes exist; DFC faces and different per-face selections are representable; selecting artwork changes neither WorkingCard.id nor CardIdentity.id.
- [x] Run npm test -- tests/core/cards/working-set.test.ts; expect missing module/export failures.
- [x] Implement only the domain types and pure import/session mapping needed by those tests.
- [x] Run the focused test and then npm test; expect all foundation/import/PDF tests to pass.
- [x] Commit as feat(cards): add identity and working-card domain.

## Task 2: Typed Scryfall Mapping, Client, and Central Rate Limit

**Files**
- Create: providers/scryfall/types.ts
- Create: providers/scryfall/mapper.ts
- Create: providers/scryfall/errors.ts
- Create: providers/scryfall/rate-limiter.ts
- Create: providers/scryfall/client.ts
- Create: tests/fixtures/scryfall/normal-card.json, dmf-card.json, token-card.json, malformed-card.json
- Create: tests/providers/scryfall/mapper.test.ts and client.test.ts

**Interfaces**
- Produces: ScryfallClient constructed with { fetchImpl?, baseUrl?, userAgent?, minIntervalMs?, timeoutMs?, maxAssetBytes? }.
- Methods: autocomplete(query, { signal? }), lookupById(scryfallId, { signal? }), lookupBySetCollector(setCode, collectorNumber, language?, { signal? }), lookupByName(name, "exact" | "fuzzy", { signal? }), searchCards(query, { signal? }), listPrintings(oracleId, { signal? }), downloadAsset(uri, { kind: "thumbnail" | "original", signal? }).
- Produces normalized ScryfallCard, ScryfallFace, ScryfallRelatedCard, ScryfallImageUris, and ScryfallPrintingPage only; no raw API payload is exposed.

- [x] Write mapper tests for normal root image_uris, root image_uris plus card_faces, DFC card_faces-only image_uris, multiface ordering, related tokens, and required/optional field validation.
- [x] Write client tests for autocomplete, exact/fuzzy lookup, ID, set+collector, search, all printings/pagination, request headers, and fake responses.
- [x] Write tests for 404, 429 and Retry-After, 500, invalid JSON/payload, timeout, caller AbortSignal, invalid/non-HTTPS asset URL, HTML response, oversize image body, and serialized requests staying under the configured rate.
- [x] Run npm test -- tests/providers/scryfall; expect missing module/export failures.
- [x] Implement the mapper/client with a default 125 ms request interval, explicit TCGPrint/version User-Agent, Scryfall's recommended `Accept: application/json;q=0.9,*/*;q=0.8`, bounded response reads, one request per operation, and no hidden retry loop. A 429 updates the shared blocked-until time and returns a typed rate-limit error.
- [x] Run the focused tests and npm test; expect fake HTTP only and no network dependence.
- [x] Commit as feat(scryfall): add typed API client and rate limiting.

## Task 3: Deterministic SQLite Cache and Content-Addressed Asset Store

**Files**
- Create: artwork/storage/paths.ts
- Create: artwork/storage/migrations.ts
- Create: artwork/storage/repository.ts
- Create: artwork/storage/original-store.ts
- Create: artwork/storage/thumbnail-store.ts
- Create: artwork/storage/metadata-cache.ts
- Modify: persistence/sqlite/index.ts to add deterministic user_version migrations behind the existing connection helper.
- Modify: .gitignore to exclude the app-local .tcgprint/ cache directory.
- Create: tests/artwork/storage.test.ts

**Interfaces**
- Produces: ArtworkRepository, ArtworkOriginalStore, ArtworkThumbnailStore, ArtworkMetadataCache, appDataPaths(baseDirectory).
- addOriginal(bytes, provenance) returns a safe artworkId/contentHash and validated dimensions/format; getOriginal(artworkId) returns the exact stored bytes or a typed missing/corruption error.
- putMetadata(key, value, expiresAt) and getMetadata(key, now?) implement cache TTL; expired/malformed metadata is treated as a miss.
- putThumbnail(candidateId, bytes, metadata) and getThumbnail(candidateId) use distinct identifiers and records. An absent thumbnail never falls through to original and an original never resolves by thumbnail ID.

- [x] Write tests for migrations from schema version zero, idempotent migration, transaction rollback, absence of Project/autosave tables, content-hash path derivation, byte-for-byte original reads, duplicate upload dedupe, metadata TTL, and thumbnail/original namespace separation.
- [x] Write tests proving filenames containing traversal sequences are metadata only and cannot affect storage destinations; reject tampered hash files rather than overwrite them.
- [x] Run npm test -- tests/artwork/storage.test.ts; expect absent exports/tables.
- [x] Implement safe IDs as lowercase SHA-256 hex and paths as originals/<first-two-hex>/<full-hash>.<validated-extension>; use atomic create/no-overwrite and verify existing bytes against the hash.
- [x] Run focused tests and npm test; expect all existing SQLite/import tests to pass.
- [x] Commit as feat(cache): add artwork metadata and original asset stores.

## Task 4: Scryfall, Local, and MPC Artwork Providers plus Catalog

**Files**
- Create: artwork/types.ts
- Create: artwork/scryfall-provider.ts
- Create: artwork/local-provider.ts
- Create: artwork/mpc-reference-provider.ts
- Create: artwork/catalog.ts
- Create: tests/artwork/catalog.test.ts and providers.test.ts

**Interfaces**
- Consumes: normalized ScryfallClient/DTOs, ArtworkOriginalStore, ArtworkThumbnailStore, MetadataCache, WorkingCard, CardIdentity.
- Produces: ArtworkProvider.searchArtwork(identity, { faceId?, signal? }), getPreview(candidateId, signal?), getOriginal(candidateId, signal?), getCandidate(candidateId); ArtworkCatalog.search(identity, { source: "all" | ArtworkSource, faceId?, mpcReferences?, signal? }). MPC references are passed from the current WorkingCard into aggregation because the reference-only IDs belong to an import entry, not the card identity.

A candidate identifies source, identityId, faceId, printing/card IDs, preview URI, original URI, original-vs-thumbnail availability, dimensions, effective DPI, set/collector/language/release date, and provenance. Internal filesystem paths stay private. Scryfall original selection uses png then large URI only; normal/small are preview-only. Downloading original caches exact validated response bytes. Local upload candidate IDs derive from content hash; identity associations are separate links. MPC candidates preserve Fase 4 providerAssetId/selectedArtworkId and expose availability reference-only without inventing URI or bytes. Existing WorkingCard selections are not mutated while loading candidates. If an entry already selects upload or MPC, it retains that choice. A source filter narrows candidates without rewriting session state.

- [x] Write tests asserting all/scryfall/upload/mpc filters and providers remain isolated on individual failure.
- [x] Write tests for original URI preference, preview-only URIs, explicit download/cache, effective DPI, identity/artwork independence, source switching, local linking without byte mutation, and refresh retaining current selection.
- [x] Write tests that MPC slots/providerAssetId/selectedArtworkId survive with no original bytes and no network call.
- [x] Run npm test -- tests/artwork/catalog.test.ts tests/artwork/providers.test.ts; expect absent exports.
- [x] Implement the catalog and three providers; include only related token metadata supplied in the normalized response and do not recursively fetch related cards.
- [x] Run focused tests and npm test; expect thumbnail lookup never to become export bytes.
- [x] Commit as feat(artwork): add catalog and local/scryfall providers.

## Task 5: Identity Resolution, Filename/Fuzzy Policy, and Lazy Local OCR

**Files**
- Create: core/cards/identity-policy.ts
- Create: core/cards/filename-resolver.ts
- Create: core/cards/fuzzy-matcher.ts
- Create: core/cards/identity-resolver.ts
- Create: providers/ocr/types.ts
- Create: providers/ocr/tesseract-recognizer.ts
- Modify: package.json and package-lock.json only after the OCR spike selects tesseract.js.
- Modify: next.config.ts to externalize the Node-only worker, WASM core, and packaged English model.
- Create: tests/core/cards/filename-resolver.test.ts, fuzzy-matcher.test.ts, identity-resolver.test.ts, tests/providers/ocr/recognizer.test.ts

**Interfaces**
- Produces: normalizeArtworkFilename(filename), fuzzyMatchName(query, candidates, policy?), IdentityResolver.resolve(input, { signal?, recognizer? }), confirmIdentity(workingCard, candidate), keepCustom(workingCard), OcrRecognizer.recognizeName(imageBytes, { signal? }).
- Central IdentityResolutionPolicy owns exact/fuzzy thresholds, score margin for ambiguous candidates, and OCR/name-region settings.
- Resolver stages stop when explicit ID/set+collector/name metadata resolves. Filename is only a suggestion. OCR is lazy and only runs when stronger metadata/filename candidates are insufficient. Fuzzy suggestion never confirms identity.
- User confirmation sets the identity and a confirmed/locked marker without removing local artwork references; future resolve attempts preserve the confirmed identity.
- OCR preprocesses a temporary crop of the likely title band using Sharp; original bytes never pass through a mutating write.

- [x] Run the OCR spike before adding a dependency: verify native executable availability; inspect current package version/license/package size and Node support; run a small Node-only worker smoke test with a synthetic title-band fixture; record Windows/Next/Termux implications below and in ADR. Do not bundle traineddata in the JS client.
- [x] Write filename tests for Sol Ring.png, Sol_Ring_custom.png, 01 - Sol Ring - alt art.jpg, 1x Sol Ring proxy.png, Sol Ring [MPC].png, and front/back suffixes; assert legitimate interior words remain.
- [x] Write fuzzy tests for exact, small typo, close alternatives/ambiguity, unresolved name, custom action, and policy-boundary values.
- [x] Write default-selection tests for retained artwork, explicit Scryfall ID, set+collector, and deterministic name-only ordering; assert upload/MPC selections are never replaced.
- [x] Write resolver tests asserting ID before set/collector before explicit name before filename before OCR/fuzzy; mocks prove later stages are not invoked after a strong result.
- [x] Write tests proving user-confirmed identity survives re-resolution/candidate refresh and uploaded bytes/hash remain unchanged after association or identity correction.
- [x] Run npm test -- tests/core/cards tests/providers/ocr; expect missing modules and expected policy behavior.
- [x] Implement filename/fuzzy logic, the staged resolver, and OcrRecognizer with dynamic server-only tesseract.js import; initialize/cache one worker lazily and process only title-region bytes.
- [x] Run focused tests and npm test; fake OCR workers cover deterministic crop behavior and the real worker uses only the locally packaged English model, never a network download.
- [x] Commit as feat(identity): add safe upload resolver and lazy local OCR.

**OCR Spike Result:** Node.js v22.22.1; no native tesseract executable. Temporary npm install of tesseract.js 7.0.0 added 13 packages outside the repository. It is Apache-2.0 (1,411,341 unpacked bytes); tesseract.js-core 7.0.0 is Apache-2.0 (45,262,431 unpacked bytes). A Node worker with the English model recognized a generated title band exactly as “SOL RING”. The default model cache wrote eng.traineddata into the current directory; production now sets an app-local cachePath. The adapter CDN smoke failed with worker `fetch failed`, so @tesseract.js-data/eng 1.0.0 is pinned (MIT, 13,876,967 unpacked bytes). A real adapter smoke with that packaged model passed; the model is read from server-side package files rather than downloaded at runtime. Explicit local workerPath/corePath and Next server externalization preserve package files. Tesseract.js remains dynamically loaded behind OcrRecognizer. Termux/proot and Node 24 were unavailable and remain unverified.

## Task 6: Server Workbench Services and Safe Node API

**Files**
- Create: services/card-workbench.ts
- Create: services/card-export.ts
- Create: src/app/api/cards/import/route.ts
- Create: src/app/api/cards/autocomplete/route.ts
- Create: src/app/api/cards/search/route.ts
- Create: src/app/api/cards/resolve/route.ts
- Create: src/app/api/cards/[identityId]/route.ts
- Create: src/app/api/cards/[identityId]/artworks/route.ts
- Create: src/app/api/cards/artworks/[candidateId]/preview/route.ts
- Create: src/app/api/cards/artworks/[candidateId]/download/route.ts
- Create: src/app/api/cards/export/route.ts
- Modify: src/app/api/import/preview/route.ts only if a compatibility fix is required; preserve its no-persistence contract.
- Create: tests/services/card-workbench.test.ts and tests/app/card-api.test.ts

**Interfaces**
- importForWorkingSet(request, { signal? }) calls Universal Import once, registers original upload bytes in the local store, and returns { workingCards, report } with no paths/bytes.
- autocompleteCards(query, { signal? }), searchCardIdentities(query, { signal? }), getIdentityDetails(identityId, { signal? }), resolveWorkingCards(cards, { signal? }), listArtworkCandidates(identityId, faceId, source, { signal? }), getArtworkPreview(candidateId), selectArtworkOriginal(candidateId, { signal? }), exportWorkingCards(cards, options, { signal? }) are service functions used by thin routes.
- POST bodies validate field shapes, IDs, quantities and faces; never accept localOriginalPath or arbitrary fetch URLs. GET parameters are bounded. Request cancellation reaches ScryfallClient and export.
- Preview returns distinct thumbnail DTO. Download API returns validated original bytes and provenance metadata. ProviderHealth per provider lets one provider degrade without failing uploads/cache.
- WorkingSet DTO carries one WorkingCard per import entry; the UI owns session state and sends that DTO back for resolution/selection. Server cache does not canonicalize WorkingSet state.

- [x] Write service tests covering decklist import → one WorkingCard per entry, upload persistence, cached resolver reuse, cancellation, provider degraded with local success, no network work on MPC, and DTOs with no byte/path fields.
- [x] Write route tests for search/autocomplete/details/artwork filters, bad JSON/IDs, arbitrary-path rejection, preview-vs-original separation, MPC reference response, and safe bounded export request parsing.
- [x] Run focused service/API tests; they use injected fake fetch and no live Scryfall requests.
- [x] Implement server factories using one local app-data directory and the shared SQLite migration/repositories; all routes use Node runtime and no browser code imports providers/SQLite.
- [x] Run focused tests and the full suite; fake fetch injection at the service boundary and no live Scryfall requests.
- [x] Commit as feat(api): add local card workbench services.

## Task 7: Compact Identity and Artwork Picker UI

**Files**
- Create: src/app/card-identity-workbench.tsx
- Modify: src/app/page.tsx
- Modify: src/app/globals.css
- Modify: tests/app/import-page.test.tsx
- Modify: tests/app/import-page.test.tsx

**Interfaces**
- UI calls only /api/cards routes and consumes serializable DTOs; no ScryfallClient, SQL, filesystem, server path, or provider URL parsing in client code.
- UI actions: paste decklist/upload; import; show order/quantity/section/source and resolution status; exact search/autocomplete/details; confirm identity/change identity/keep custom; show per-face Front/Back for DFC; filter All/Scryfall/MPC Autofill/My uploads; show preview, selected artwork, source/set/collector/language/effective DPI; select artwork; load/download original; export A4 PDF.
- Fuzzy, filename and OCR suggestions present explicit Use this identity / Choose another / Keep custom actions; no uncertain identity is silently confirmed. Candidate refresh never overwrites current selections.
- DFC indicator includes visible text "Carta dupla-face". The UI does not offer duplex printing in Fase 5.

- [x] Add a static-render regression test for the compact session workbench; API/service tests exercise resolution, confirmation, custom identity, candidate sources, per-face selection, and export DTO actions.
- [x] Run npm test -- tests/app/import-page.test.tsx tests/app/card-api.test.ts; Phase 4 controls and Phase 5 API actions remain valid.
- [x] Implement the compact workbench with accessible form labels and text status; keep the candidate image grid inside the artwork picker.
- [x] Run focused tests and npm test; the existing Phase 4 import page checks remain valid.
- [x] Commit as feat(ui): add identity and artwork picker workbench.

## Task 8: Original-Only PDF Composition and End-to-End Acceptance

**Files**
- Modify: services/card-export.ts
- Modify: src/app/api/cards/export/route.ts
- Create: tests/services/card-export.test.ts
- Create: tests/app/card-export.test.ts

**Interfaces**
- exportWorkingCards receives WorkingCard DTOs and { bleedMm, cutGuides }; it resolves selectedArtwork IDs to cached originals only.
- Expand each card to quantity copies only into ordered physical image and bleed arrays immediately before LosslessPdfEngine.generate. Do not create repeated WorkingCard objects.
- Reuse BleedEngine for each unique original/configuration and pass its result aligned with the expanded image list. Reuse existing A4, MAGIC_STANDARD_CARD, calculateGridPlacement inside LosslessPdfEngine, and CutGuideEngine-backed cutGuides.
- If an artwork has no validated original (including reference-only MPC or thumbnail-only candidate), return a clear non-exportable item error; never choose another source.
- Output retains 63.5 × 88.9 mm trim, external bleed, vector guides, and JPEG DCT passthrough with original bytes when no transformation is needed.

- [x] Write an integration test for decklist → fake Scryfall name resolution → explicit default candidate → original download/cache → offline quantity composition → generated A4 PDF; assert nine/ten copies, page size, original-byte passthrough, and no provider request after going offline. Existing PDF engine tests cover trim dimensions and vector guides.
- [x] Write tests for nine Magic cards with 0.625 mm bleed on A4, more than nine cards across additional pages, quantity kept compact before export, cached-original export with Scryfall offline, and rejection of an MPC reference without a validated original.
- [x] Run npm test -- tests/services/card-export.test.ts; the composition flow passes with fake HTTP only.
- [x] Implement composition and route by passing original bytes only to BleedEngine/LosslessPdfEngine; do not implement placement or guide math here.
- [x] Run focused integration tests and npm test; image bytes/page size/placement match existing engine contracts.
- [x] Commit as feat(export): compose selected artwork into lossless PDF.

## Task 9: ADR, Full Validation, Diff Review, Commits, and Push

**Files**
- Create: docs/decisions/0005-card-identity-artwork-cache.md
- Modify: docs/superpowers/plans/2026-09-25-card-identity-scryfall-artwork.md to record completed tasks and OCR result.

**Interfaces**
- ADR records identity/art separation, stable IDs, deterministic default-art policy, metadata/original/thumbnail cache provenance, DFC face mapping, and OCR dependency/version/limits. It records Termux/proot as unverified if unavailable.
- Plan checklist and execution ledger match commits and exact verification output.

- [x] Run npm test (30 files, 256 passed, one optional OCR test skipped), npm run typecheck (passed), and npm run build (Next.js 16.3.6 production build passed without warnings).
- [x] Inspect git diff --check, git status, and the implementation diff for forbidden phase scope, path/byte DTO exposure, thumbnail export fallback, identity/selection replacement, live provider tests, and changes to existing print engines; no phase 6–8/14 work or engine duplication is included.
- [x] Run a deterministic service smoke flow using fake Scryfall: import deck text, resolve identities, cache the selected default original, simulate Scryfall being offline, and produce an A4 PDF.
- [ ] Commit ADR and any final documentation as docs(cards): record Fase 5 identity and artwork policy.
- [ ] Push the completed codex/fase-5 branch to origin/codex/fase-5; do not merge into main.
