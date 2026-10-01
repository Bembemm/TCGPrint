# Phase 13 Precision Print Calibration Implementation Plan

> **For agentic workers:** Use this plan task by task. Each task has a testable deliverable and ends with focused verification.

**Goal:** Add reproducible page-side printer calibration without changing nominal card, template, registration-reserved-zone, or cut geometry.

**Architecture:** A pure calibration core owns bounds, coordinate conversion, matrix creation, measurements, and solving. Immutable printer-profile revisions are stored in SQLite; Project v5 embeds the exact selected revision snapshot. Export applies one optional page CTM after the existing duplex pairing, while preview and vector calibration sheets consume the same canonical transform.

**Tech Stack:** TypeScript, Vitest, SQLite via better-sqlite3, Next.js 16 Route Handlers, React client components, @pdfme/pdf-lib.

**Spec:** `docs/decisions/0016-precision-print-calibration.md` plus Phase 13 acceptance requirements supplied for this branch.

## Global Constraints

- Branch: `feature/fase-13-precision-print-calibration`; base: `3a3ca1e584c1843ba64647814c47aaa4089da474`.
- Magic Standard remains nominally `63.5 × 88.9 mm`; calibration never changes cardFormat, template geometry, quantity, slot identity, cut source, or original artwork.
- Offsets are integer micrometers; `+X` is physically right and `+Y` is physically up.
- Transform order is scale → skew → rotation → X/Y translation around the oriented page center, after duplex pairing.
- Page dimensions remain unchanged; identity calibration emits no PDF CTM.
- Profile revisions are immutable and Project snapshots carry exact profile ID/version/hash and values.
- SVG/DXF Cut Export stays nominal; registration marks and printed cut guides move with the calibrated PDF content.
- No physical pass tolerance or printer validation is invented.
- Keep `main` at the base SHA; commit and push only the feature branch; do not merge.

## Review Focus

- `+Y` UI offset converts to physical up in page Y-down geometry and stays up on every duplex back flip; test front/back with explicit point coordinates.
- Scale, skew, and rotation compose about the oriented page center in the documented multiplication order; test corners and asymmetric points with hand-derived constants.
- Project v1–v4 reads remain identity and profile v1 snapshots survive update to v2 through duplicate and recovery; test exact hashes and parameter values.
- PDF CTM changes content but not MediaBox/CropBox or embedded JPEG stream; test transformed front/back pages and all output modes.
- Cut exports and immutable template associations remain byte/geometrically nominal with a selected profile; test API output against the uncalibrated Project.

---

### Task 1: Pure calibration math and validation

**Files:**
- Create `core/calibration/types.ts`, `errors.ts`, `coordinates.ts`, `transform.ts`, `index.ts`.
- Test `tests/core/calibration-transform.test.ts`.

**Interfaces:**
- `SideCalibration`: integer `offsetXUm`, `offsetYUm`; finite `rotationDeg`, `scaleX`, `scaleY`; optional `skewXDeg`, `skewYDeg`.
- `createIdentitySideCalibration(): SideCalibration`.
- `parseSideCalibration(value: unknown): SideCalibration` with the ADR ranges.
- `createPrintCalibrationTransform(pageSizeMm, calibration, side)` returns side, center anchor, exact identity flag, PDF Y-up matrix and SVG/page Y-down matrix.
- `pageYDownToPhysicalYUp(yMm, pageHeightMm)` and inverse.

- [ ] Write failing point tests for translation (`100×150`, `(10,20)`, X `+1250 µm`, visual Y `+500 µm`), signed Y conversion, center invariance, rotation, nonuniform scale, X/Y skew, and one composed asymmetric point.
- [ ] Run `npm test -- tests/core/calibration-transform.test.ts`; confirm expected missing module/API failures.
- [ ] Implement bounds and matrix composition from ADR 0016; emit exact identity values for identity input.
- [ ] Add failures for NaN, infinity, negative/zero scales, offsets past 10,000 µm, rotation past 5°, and skew past 1.5°.
- [ ] Re-run focused test; confirm all literal expected coordinates pass.

### Task 2: Measurement parser, solver, and residual model

**Files:**
- Create `core/calibration/measurements.ts`, `solver.ts`.
- Test `tests/core/calibration-solver.test.ts`.

**Interfaces:**
- `CalibrationPointId = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"`.
- `CalibrationMeasurement` carries a unique point ID and integer delta X/Y µm (observed minus nominal; positive Y physically up).
- `solveSimpleCalibration(input)` validates direct X/Y/rotation without estimating.
- `solveAdvancedCalibration(pageSizeMm, measurements)` returns `SideCalibration`, per-point residuals, and mean/min/max residual magnitude.
- `parseMillimeterInputToUm(text)` accepts comma or point decimal separators through three decimals and rejects ambiguous grouping.

- [ ] Write failing tests for known translation/rotation/anisotropic scale, a small X shear, residuals, fewer than four points, duplicate IDs, collinear/nearly-zero targets, non-finite values, and over-bound solutions.
- [ ] Run the focused solver test and confirm it fails on missing exports.
- [ ] Implement deterministic normalized least-squares, inversion, and QR conditioning guard from ADR 0016; leave unsupported values at identity.
- [ ] Re-run solver tests and verify hand-derived expected values.

### Task 3: Immutable profile model, hash, import/export, compatibility

**Files:**
- Create `core/calibration/profile.ts`, `profile-compatibility.ts`, and server-side `persistence/printer-profiles/hash.ts`.
- Test `tests/core/printer-profile.test.ts`.

**Interfaces:**
- `PrinterProfile` contains ID/name, front/back calibration, paper name and base dimensions, page orientation, duplex mode, optional media/quality/feed/notes, and physical-validation status.
- `PrinterProfileSnapshot` adds immutable revision and SHA-256 hash.
- `parsePrinterProfile`, `parsePrinterProfileImport`, `serializePrinterProfileExport`, `computePrinterProfileHash`, and `checkPrinterProfileCompatibility` validate strict bounded JSON and exact paper/orientation/duplex semantics.

- [ ] Write failing tests for identity defaults, valid/invalid integer µm, bounds, unknown/future import schema, 64 KiB limit, hash tampering, comma/point parsing, compatibility reasons, front-only duplex exception, and simplex duplex blocker.
- [ ] Run focused test to confirm absent behavior fails.
- [ ] Implement parser/hash/export/import/compatibility; duplicate IDs remain a repository concern.
- [ ] Re-run focused test and verify profile snapshots round-trip without paths or artwork fields.

### Task 4: SQLite migration and profile repository with CAS

**Files:**
- Modify `persistence/projects/migrations.ts` to physical schema v5.
- Create `persistence/printer-profiles/repository.ts` and `services/printer-profile-repository.ts`.
- Test `tests/persistence/printer-profile-repository.test.ts` and update `tests/persistence/projects-database.test.ts`.

**Interfaces:**
- `PrinterProfileRepository.create(profile)`, `list()`, `open(id, version?)`, `update(id, expectedVersion, profile)`, `duplicate(id, version?)`, `import(snapshot)`, and `export(id, version?)`.
- `update` inserts a new immutable revision only if the current version matches; all prior versions stay readable.

- [ ] Write failing migration/repository tests for fresh v5 schema, v1→v5 populated DB upgrade, create/reopen, rename/recalibrate revision, immutable v1, duplicate new ID, export/import, corrupt hash, and concurrent CAS conflict.
- [ ] Run focused persistence tests and confirm they fail against current schema/repository.
- [ ] Add append-only `printer_profile_versions` plus profile current-version metadata in migration 5 and implement transactions/CAS.
- [ ] Re-run focused tests; verify foreign keys and no mutation of prior version JSON.

### Task 5: Project v5 profile snapshot and recovery preservation

**Files:**
- Modify `persistence/projects/serializer.ts`, `persistence/projects/repository.ts`, `services/project-api.ts`, and `src/app/project-session.ts`.
- Test `tests/persistence/project-serializer.test.ts`, `tests/persistence/project-repository.test.ts`, and `tests/services/project-api.test.ts`.

**Interfaces:**
- `ProjectSettingsV5` adds `printerProfileSelection: PrinterProfileSnapshot | null` and explicit `printerDuplexMode`.
- Deserialization accepts v1–v4 and promotes to v5 with no profile and identity calibration; v5 validates full bounded snapshots and hash syntax.
- Repository create/save/recovery/duplicate/copy/promotion retain the embedded profile snapshot exactly; CAS includes Project revision as today.

- [ ] Write failing migration tests for v1/v2/v3/v4→v5 defaults and v5 serialization, reopen, autosave, duplicate, recovery stage/promote/copy, stale revision, and v1 Project profile v1 surviving library update to v2.
- [ ] Run focused tests and verify failures identify missing v5 behavior.
- [ ] Extend serializer/settings/session state, preserve the complete immutable selection in every project lifecycle, and verify hashes server-side without requiring the library row to render an old snapshot.
- [ ] Re-run focused Project tests; confirm prior schema snapshots retain null profile and exact nominal defaults.

### Task 6: Bounded profile and sheet Route Handlers

**Files:**
- Create `services/printer-profile-api.ts`, `services/calibration-sheet.ts`.
- Create `src/app/api/printer-profiles/route.ts`, `src/app/api/printer-profiles/[profileId]/route.ts`, `src/app/api/printer-profiles/[profileId]/duplicate/route.ts`, `src/app/api/printer-profiles/[profileId]/export/route.ts`, `src/app/api/printer-profiles/import/route.ts`, `src/app/api/calibration/sheet/route.ts`, and `src/app/api/calibration/verification-sheet/route.ts`.
- Test `tests/services/printer-profile-api.test.ts`, `tests/services/calibration-sheet.test.ts`.

**Interfaces:**
- Library handlers expose create/list/open/rename/new revision/duplicate/import/export using opaque IDs, expected versions, and bounded JSON.
- Sheet handlers accept bounded IDs, page format/orientation/duplex, side, and validated `SideCalibration`; they reconstruct matrices server-side and return vector PDFs with bounded manifest headers.

- [ ] Write failing handler tests for CRUD, stale version 409, malformed/future imports, path rejection, session/profile IDs, front-only sheet, paired front/back sheet, and verification sheet matrix use.
- [ ] Run focused handler tests and confirm expected missing-route/service failures.
- [ ] Implement handlers using the installed Next 16 Web Request/Response Route Handler contract; cap JSON and never accept arbitrary matrices or artwork bytes.
- [ ] Re-run focused tests, including `Cache-Control: no-store` and bounded diagnostic metadata.

### Task 7: Page CTM and export integration

**Files:**
- Modify `pdf-engine/document/index.ts`, `services/card-export.ts`, `services/card-api.ts`, and `src/app/api/cards/export/route.ts`.
- Test `tests/pdf-engine/pdf-engine.test.ts`, `tests/services/card-export.test.ts`, and `tests/app/card-api.test.ts`.

**Interfaces:**
- PDF requests accept validated `SideCalibration` plus side; non-identity calibration wraps all page contents once and leaves page boxes fixed.
- Content-mode export routes front pages through front calibration and paired back pages through back calibration.
- Project-based API uses only the exact persisted selection, checks profile hash/compatibility and stale Project settings, and reports profile/revision/hash/side/effective matrices in bounded headers and separate manifests.

- [ ] Write failing PDF tests for identity regression, each signed axis/side, 1 µm/arbitrary offset, ±rotation, scale/skew/combined matrix, portrait/landscape centers, all flips, 10/100 cards without accumulation, JPEG DCT hash preservation, and unchanged MediaBox/CropBox.
- [ ] Write failing service/API tests for correct side per front-only/back-only/separate/duplex and stale/incompatible profile blockers.
- [ ] Run focused tests to confirm the profile/CTM paths are absent.
- [ ] Add one page-scoped optional CTM after duplex composition; keep identity on the current PDF path and avoid touching pairing or cut export services.
- [ ] Re-run PDF/service/API tests and compare registration/cut-guide vector coordinates under the expected same page matrix.

### Task 8: Calibration preview, profile library UI, and wizard

**Files:**
- Create `src/app/printer-calibration-panel.tsx` and focused UI helpers.
- Modify `src/app/card-identity-workbench.tsx`, `src/app/project-settings-controls.tsx`, `src/app/registration-layout-preview.tsx`, and `src/app/globals.css`.
- Test `tests/app/printer-calibration-panel.test.tsx`, `tests/app/registration-layout-preview.test.tsx`, and `tests/app/project-settings-controls.test.tsx`.

**Interfaces:**
- Project controls display selected profile/version/hash, paper/orientation/duplex compatibility, and explicit “Sem calibração” state.
- Library supports create/select/duplicate/rename/recalibrate/import/export; recalibration creates a new revision and offers an explicit Project update action.
- Wizard provides Simple X/Y/rotation, Advanced measurements/solver, micro/fine/normal/coarse nudges, 0.001° rotation nudges, sheet/verification download, residuals, and nominal/calibrated/front-back opacity preview.
- Draft wizard state stays local until a profile revision is explicitly committed; comma/point policy and `+X/+Y` convention are visible beside fields.

- [ ] Write failing interaction tests for profile select, incompatibility blocker, older Project revision notice, explicit update-to-latest, duplicate/import/export, both solver modes, sheet and verification downloads, exact nudges, Y-up help text, and nominal/calibrated overlay.
- [ ] Run UI tests to confirm the controls are absent.
- [ ] Implement client interactions through the bounded APIs and use only the core transform matrices for SVG preview.
- [ ] Re-run focused UI tests and review the accessibility labels and keyboard-operable controls.

### Task 9: Cut/template regression, artifacts, production smoke, independent review

**Files:**
- Add `tests/fixtures/calibration/` numeric fixtures and `tests/physical/calibration-fixture.test.ts`.
- Add `artifacts/phase-13-calibration/README.md`, front/back calibration PDF, verification PDF, manifest JSON, example profile JSON, expected matrices JSON, and SHA-256 manifest.
- Add an artifact generator only if required for deterministic regeneration.

- [ ] Add regression proving calibrated Project settings leave SVG/DXF output, template ID/version/hash, and nominal registration reserved zones unchanged.
- [ ] Generate the stated software artifacts with no invented physical readings and label all results `software validation`.
- [ ] Run the production-build software smoke for A4 portrait/manual-long-edge with back X `-683 µm`, Y `+247 µm`, rotation `+0.031°`, all export modes, reopen, duplicate, profile revision, old Project snapshot, and explicit Project update.
- [ ] Run focused core/solver/profile/migration/Project/recovery/API/sheet/PDF/duplex/registration/cut/template/UI suites.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check 3a3ca1e584c1843ba64647814c47aaa4089da474..HEAD`.
- [ ] Request an independent review of the complete diff; correct every P1/P2 finding and rerun affected gates.
- [ ] Confirm `git status`, feature branch, final SHA, unchanged `main` SHA, no merge, and push only `origin/feature/fase-13-precision-print-calibration`.
