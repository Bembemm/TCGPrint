# Universal Import Engine Implementation Plan

> **For agentic workers:** This plan follows the supplied Fase 4 requirements in `IMPLEMENTATION_PLAN.md` and is being executed in this session as requested by the user.

**Goal:** Interpret user supplied text and files into immutable, reviewable import entries and reports, without provider lookup or project persistence.

**Architecture:** A Node only import core owns content detection, parsing, raster validation, ZIP traversal, metadata and report generation. Next.js routes expose serializable previews and a thin PDF test export; the client keeps original File objects for previews and retries. Importers remain independent of BleedEngine and LosslessPdfEngine.

**Tech Stack:** TypeScript, existing Sharp and PDF/bleed engines, `csv-parse`, `@xmldom/xmldom`, `yauzl`, and synthetic fixtures.

**Spec:** `IMPLEMENTATION_PLAN.md` sections 6, 10–16, 18–19, 22, 35, 58–62, 134–146, 150–151; the user's Fase 4 requirements in the task message.

## Global Constraints

- Only implement Fase 4; do not add providers, URL adapters, editor, projects, cutter or registration features.
- Original bytes are immutable and preserved; metadata may be normalized.
- Importer performs no network lookups and does not write to SQLite or project storage.
- Identity fields remain hints; unknown images remain printable custom entries.
- Prefer explicit warnings/errors to guesses that could lose order, quantity, slots, artwork IDs or face pairing.
- Node.js support remains `^22.12.0 || ^24.0.0 || >=26.0.0`.
- ZIP input is processed in memory/streams with configured entry, byte, ratio and nesting limits; no filesystem extraction.
- XML DTDs are rejected before parsing and external entities are never resolved.
- Test fixtures contain only synthetic, non-commercial data.
- PDF image, bleed and guide behavior continues through the existing engines.

## Review Focus

- Content and extension disagree: detection follows bytes, reports the mismatch and preserves the source.
- Two import kinds remain plausible: selection is required and the report records the ambiguity.
- XML DTD/XXE and malformed XML are isolated typed errors; other batch inputs still import.
- ZIP traversal, symlinks, entry count, per-entry/aggregate size and compression ratio are rejected before unsafe work.
- MPC slots, source order, selected IDs, cardback and face links survive parsing without online access.

## Planned File Boundaries

- `import-engine/types.ts`, `errors.ts`, `limits.ts`: stable public models, typed domain failures and configurable safety/detection policy.
- `import-engine/detection/`: byte-based format candidates and explicit selection policy.
- `import-engine/importers/`: focused image, text/decklist, CSV, JSON, XML and MPC Autofill adapters.
- `import-engine/zip/`: in-memory archive reader and per-entry isolation.
- `import-engine/`: batch orchestration, progress, cancellation, report aggregation, asset pairing and JSON-safe preview DTO.
- `src/app/api/import/preview/route.ts`: server-side preview, no persistence.
- `src/app/api/import/pdf/route.ts`: one selected local PNG/JPEG/SVG through existing bleed and PDF engines.
- `src/app/page.tsx`, `src/app/globals.css`: compact import workbench for paste, file/folder selection, drop, report and PDF export.
- `tests/import-engine/`, `tests/app/`: synthetic format/security tests and the local image-to-PDF proof.

## Tasks

### Task 1: Stable import model, errors, limits and detector

**Files:** Create the public model, typed errors, configurable policies, detection implementation and `tests/import-engine/detection.test.ts`.

- [ ] Add failing tests for signatures vs extensions for PNG, JPEG, WebP, TIFF, SVG and ZIP, plus JSON/XML/TXT/CSV/TSV, URL, unknown and ambiguity.
- [ ] Run the detector tests and confirm missing exports/behavior fail.
- [ ] Implement content sniffers, centralized confidence scoring, extension hints, reasons, and explicit auto-select/ambiguous/unknown policy.
- [ ] Run the detector tests.

### Task 2: Image import, original asset preservation and safe metadata

**Files:** Create the image adapter and `tests/import-engine/images.test.ts`.

- [ ] Add synthetic/fixture tests for real raster decoding, dimensions, hash, original byte identity, disguised extensions, invalid/truncated data, SVG byte identity and limits.
- [ ] Run the image tests and confirm they fail for the absent adapter.
- [ ] Implement content-based image validation with bounded Sharp decode and safe SVG XML inspection; do not re-encode any input.
- [ ] Run the image tests.

### Task 3: Decklist formats and text report problems

**Files:** Create focused text parsers and `tests/import-engine/text.test.ts`.

- [ ] Add failing tests for bare names, quantities, `1x`, set/collector hints, sections, Arena, MTGO `SB:`, XMage layout markers, `.mwDeck` markers and malformed lines.
- [ ] Run the text tests and confirm the parsing API is absent.
- [ ] Implement independent adapters sharing only card-line parsing; retain raw section labels and report every nonblank unparsed line.
- [ ] Run the text tests.

### Task 4: CSV/TSV mapping and JSON path mapping

**Files:** Create CSV/JSON adapters and `tests/import-engine/structured-data.test.ts`.

- [ ] Add failing tests for quoted/escaped CSV, TSV, alias mapping, unknown columns, custom mappings, known JSON arrays, `cards[].name` mappings, bounds and malformed JSON.
- [ ] Run the structured-data tests and confirm expected failures.
- [ ] Use `csv-parse` for record parsing and implement bounded JSON path traversal and report mappings/warnings without name correction.
- [ ] Run the structured-data tests.

### Task 5: Safe XML, generic XML and MPC Autofill

**Files:** Create XML tree helpers, generic and MPC adapters, synthetic XML fixtures and `tests/import-engine/xml.test.ts`.

- [ ] Add failing tests for generic XML, malformed XML isolation, DTD/XXE rejection, order preservation, repeated cards, singular/plural slots, quantity, IDs, cardback, front/back links and optional fields.
- [ ] Run the XML tests and confirm the typed errors/adapters are missing.
- [ ] Implement strict bounded XML parsing after DTD rejection. Map MPC data only from explicit fields; retain XML bytes and all original field text; do no network access.
- [ ] Run the XML tests.

### Task 6: Secure ZIP recursion, folder paths, pairing, batch and reports

**Files:** Create ZIP reader/orchestrator/pairing/report modules, synthetic ZIP test helpers and `tests/import-engine/batch-zip.test.ts`.

- [ ] Add failing tests for normal/nested ZIP, image/text/table/JSON/XML entries, traversal, absolute/drive paths, symlink, entry count, individual/aggregate size, compression ratio, malformed entry, mixed batches, folder pairing ambiguity, progress and AbortSignal.
- [ ] Run the ZIP/batch tests and confirm the limits/report pipeline is absent.
- [ ] Implement streaming in-memory entry handling, configurable preflight limits, per-entry errors, bounded recursion, deterministic ordering, explicit suggestions and cancellation without external writes.
- [ ] Run the ZIP/batch tests.

### Task 7: Next.js import workbench and image-to-PDF route

**Files:** Create the preview DTO, two Node route handlers and focused React workbench; update global styles; add route/engine integration tests.

- [ ] Add failing tests for serializable import previews, no persistence, PNG/JPEG/SVG export, JPEG DCT passthrough, 63.5 × 88.9 mm trim, external bleed, vector guides, and explicit WebP/TIFF export limitation.
- [ ] Run the app integration tests and confirm the routes/UI are absent.
- [ ] Implement paste/file/folder/drop controls and a dense report view. Keep File bytes in the client and pass selected source bytes to the route.
- [ ] Re-run the app integration tests.

### Task 8: Full verification, diff review, commits and push

**Files:** Review only Fase 4 implementation, tests, package manifest/lockfile, documentation and synthetic fixtures.

- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Confirm all existing Fases 0–3 tests still pass and report exact totals.
- [ ] Review `git diff` for accidental phase scope, persistence, network access, byte mutation and test fixture licensing.
- [ ] Commit coherent Fase 4 slices on `codex/fase-4` and push to `origin/codex/fase-4`; do not merge to main.
