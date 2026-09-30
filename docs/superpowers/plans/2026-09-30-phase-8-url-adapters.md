# Phase 8 URL Adapters Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, with test-first changes and a commit for each coherent deliverable.

**Goal:** Accept a URL in the existing Universal Import text field, use isolated known-site adapters where a verified protocol exists, and safely route unknown hosts that serve direct import files to existing generic importers.

**Architecture:** A Node-only URL dispatcher selects adapters by exact host and supported path. Adapters return normalized bytes in the existing import formats or a single card hint; bounded HTTP transport, typed failures, content-type evidence, and per-input error isolation are shared. Unknown hosts are treated only as possible direct files; HTML is never scraped as a generic fallback.

**Tech Stack:** Existing TypeScript Universal Import Engine, Node.js `fetch`, existing text/CSV/JSON/XML/image importers, Vitest, Next.js Node routes.

**Spec:** `IMPLEMENTATION_PLAN.md` sections 6, 10–16, 22, 115–119, 134–146; Phase 8 requirements in the user request; ADR 0011 in this plan.

## Global Constraints

- Keep Importer and Artwork Provider separate; URL adapters create import entries and never become artwork providers.
- Keep the single Universal Import text input for text and URLs.
- Support only explicit URL/domain protocols; never promise arbitrary website scraping.
- A remote adapter failure is an import report error for that source and cannot abort sibling inputs.
- Bound requests by timeout, response bytes, redirects, and content-type checks.
- Direct file format selection uses response bytes and `Content-Type`; extension is secondary evidence.
- Route direct TXT, CSV, XML, JSON, raster/SVG image, and ZIP content into existing generic importers.
- Preserve imported URL/protocol/content-type provenance without persisting provider or project state.
- Do not change PDF, bleed, geometry, Projects, artwork providers/catalog, or other phases.
- Keep live network probes out of automated tests; adapters use fake HTTP in CI.

## Review Focus

- URL-like malformed input must report a clear URL error rather than become a card name.
- A URL on a supported site with an unsupported path must fail explicitly; it must not be treated as a generic HTML file.
- Direct URL bodies whose extension, `Content-Type`, and bytes disagree must use content evidence and report the mismatch.
- A 403/WAF page, HTML body, timeout, oversized body, redirect to a private host, or malformed site payload must fail only that source.
- URL import must work through both the preview route and the Card Identity Working Set route, with no provider lookup or persistence added.

---

### Task 1: URL contracts, explicit registry, and typed failures

**Files:**
- Create: `import-engine/urls/types.ts`
- Create: `import-engine/urls/registry.ts`
- Modify: `import-engine/types.ts`
- Modify: `import-engine/errors.ts`
- Modify: `import-engine/detection.ts`
- Modify: `import-engine/index.ts`
- Test: `tests/import-engine/urls/registry.test.ts`
- Test: `tests/import-engine/detection.test.ts`

**Interfaces:**
- `UrlAdapterContext` contains optional injected `fetchImpl`/DNS lookup, `signal`, `timeoutMs`, and `maxResponseBytes`.
- `UrlAdapterResult` is `{ kind: "source", filename, mediaType, bytes, sourceUrl, metadata? }` or `{ kind: "entries", entries, warnings?, sourceUrl, metadata? }`; emitted entry `sourceId`s point to the URL source.
- `UrlAdapter` is `{ id, hosts, matches(url), import(url, context): Promise<UrlAdapterResult> }`.
- `resolveUrlAdapter(url)` returns `{ kind: "adapter", adapter }`, `{ kind: "known-unsupported", siteId, message }`, or `{ kind: "direct-file" }`.
- Add URL-specific typed failure codes for invalid URL, unsupported site/path, HTTP, timeout, content type, response size, redirect, and malformed adapter payload.
- Extend detection input/source metadata with optional `mediaType`, source URL, adapter ID, and a URL-like invalid-input state.

- [x] Add tests for exact host boundaries, supported versus unsupported paths, each known domain, malformed `http(s)://` strings, and non-HTTP schemes.
- [x] Run the focused detector/registry tests and observe the expected missing behavior.
- [x] Implement types, exact URL parsing, registry, and typed errors only.
- [x] Run the focused detector/registry tests.
- [x] Commit as `feat(import): define URL adapter contracts`.

### Task 2: Bounded transport and direct-file fallback

**Files:**
- Create: `import-engine/urls/transport.ts`
- Create: `import-engine/urls/direct-file.ts`
- Modify: `import-engine/types.ts`
- Modify: `import-engine/detection.ts`
- Modify: `import-engine/engine.ts`
- Test: `tests/import-engine/urls/direct-file.test.ts`
- Test: `tests/import-engine/detection.test.ts`

**Interfaces:**
- `fetchUrlPayload(url, options)` performs GET with timeout, `AbortSignal`, bounded streaming, explicit redirect handling, and public-host checks for direct URLs.
- `directFileAdapter` accepts supported image/text/table/JSON/XML/ZIP media types, captures final URL, `Content-Type`, and a sanitized filename, then returns an `ImportSource` for the existing generic importer dispatch.
- `UniversalImportOptions` supports injected fetch/DNS resolution, timeout, and response limits for deterministic tests.

- [x] Add failing tests for TXT, CSV, XML, JSON, PNG with a misleading extension/type, unsupported HTML, 404, timeout, oversize body, and redirect-to-loopback/private host.
- [x] Run `npm test -- tests/import-engine/urls/direct-file.test.ts tests/import-engine/detection.test.ts` and confirm the expected failures.
- [x] Implement bounded transport and route direct responses by detected bytes plus `Content-Type` into the existing importers.
- [x] Run the focused tests and existing importer tests.
- [x] Commit as `feat(import): add bounded direct URL imports`.

### Task 3: Site adapters with explicit export protocols

**Files:**
- Create: `import-engine/urls/adapters/scryfall.ts`
- Create: `import-engine/urls/adapters/mtg-wtf.ts`
- Create: `import-engine/urls/adapters/mtgtop8.ts`
- Modify: `import-engine/urls/registry.ts`
- Modify: `import-engine/engine.ts`
- Test: `tests/import-engine/urls/scryfall.test.ts`
- Test: `tests/import-engine/urls/mtg-wtf.test.ts`
- Test: `tests/import-engine/urls/mtgtop8.test.ts`

**Interfaces:**
- Scryfall card URLs produce one `deck-card` hint from explicit set/collector/slug path data; other Scryfall paths are clearly unsupported.
- mtg.wtf deck URLs use its explicit `/download` plain-text export; metadata comment lines are removed before existing text import.
- MTGTop8 deck URLs map the deck ID/format to its explicit `/dec?d=…&f=…` `.mwDeck` export and preserve the existing text importer semantics.

- [x] Add success, invalid/unsupported URL, bad export response, remote failure, and mixed-batch isolation tests for the fetching adapters; Scryfall intentionally parses card URLs locally without a remote request.
- [x] Run focused tests and confirm expected failures before implementation.
- [x] Implement each adapter in its own file and feed its normalized output to the existing importer contract.
- [x] Run the focused tests and generic text importer tests.
- [x] Commit as `feat(import): add Scryfall and public deck export adapters`.

### Task 4: Archidekt and CubeCobra JSON adapters

**Files:**
- Create: `import-engine/urls/adapters/archidekt.ts`
- Create: `import-engine/urls/adapters/cubecobra.ts`
- Modify: `import-engine/urls/registry.ts`
- Modify: `import-engine/engine.ts`
- Test: `tests/import-engine/urls/archidekt.test.ts`
- Test: `tests/import-engine/urls/cubecobra.test.ts`
- Fixtures: synthetic JSON payloads under `tests/fixtures/import-engine/urls/`

**Interfaces:**
- Archidekt public deck IDs use `GET https://archidekt.com/api/decks/{id}/`; the adapter validates `cards[]`, name, quantity, set/collector hints, and category/section before normalization.
- CubeCobra cube links use `GET https://cubecobra.com/cube/api/cubeJSON/{id}`; the adapter validates `cards.mainboard`, `cards.maybeboard`, and optional `cards.basics`, retaining board labels and printing hints.
- Both return normalized JSON card arrays for the existing JSON importer; unknown or changed shapes produce typed per-source adapter errors.

- [x] Add successful synthetic schema tests, malformed schema, invalid IDs/paths, HTTP 403/5xx, timeout, and batch-isolation tests.
- [x] Run focused tests and confirm expected failures.
- [x] Implement isolated API parsing and normalization; do not scrape HTML or follow arbitrary response URLs.
- [x] Run the focused tests and generic JSON importer tests.
- [x] Commit as `feat(import): add Archidekt and CubeCobra adapters`.

### Task 5: Wire preview and Working Set flows; document limits

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/api/import/preview/route.ts`
- Modify: `src/app/api/cards/import/route.ts` only if required by the request DTO
- Modify: `services/card-workbench.ts`
- Modify: `import-engine/engine.ts`
- Create: `docs/decisions/0011-url-adapters.md`
- Modify: `tests/app/import-routes.test.ts`
- Modify: `tests/services/card-workbench.test.ts`
- Modify: `tests/app/import-page.test.tsx`

**Interfaces:**
- The existing text field accepts either text or URL in preview and Working Set import.
- The preview source report exposes safe adapter/source URL, response MIME, and clear unsupported/WAF failures without raw response bodies or private paths.
- Register Moxfield, Deckstats, MTGGoldfish, and TappedOut as known unsupported domains with explicit reasons; do not bypass login/WAF/Cloudflare.
- ADR 0011 records observed protocols, implemented scope, smoke evidence, and pending adapter limitations.

- [x] Add integration tests proving URL preview and Working Set import, `Content-Type` propagation, URL error isolation alongside valid text/file input, and static UI copy.
- [x] Run the route/service/UI-focused tests and confirm expected failures.
- [x] Integrate dispatcher into `importFiles`, pass local file MIME hints, and keep the same universal input field.
- [x] Run focused URL, importer, route, service, and UI tests.
- [x] Review documentation against live probes and the implementation; commit as `feat(import): wire URL imports into Universal Import`.

### Task 6: Full verification, smoke, review, commit, and feature push

**Files:** Review the entire Phase 8 diff; add only fixes required by findings.

- [ ] Run focused URL adapter tests.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record exact results.
- [ ] Smoke live Scryfall link parsing and, where reachable, Archidekt, CubeCobra, MTGTop8, mtg.wtf, and a direct image/TXT URL; report any transient external failures accurately.
- [ ] Review the full diff against `IMPLEMENTATION_PLAN.md`, ADRs, Importer/Provider separation, and phase scope; fix blocking findings.
- [ ] Confirm `main` remains at `cdcb69c1dce8a48254189fc74a1d29c7a1df7a24`, feature branch only contains coherent commits, and no merge was made.
- [ ] Push only `feature/fase-8-url-adapters` to `origin`.
