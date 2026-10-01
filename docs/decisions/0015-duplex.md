# ADR 0015: Duplex backs and physical page pairing

- Status: Accepted
- Date: 2026-10-01
- Supersedes: none
- Related: ADR 0002 (PDF fidelity), ADR 0005 (card identity and artwork cache), ADR 0006 (MPC artwork provider), ADR 0010 (Project persistence), ADR 0013 (registration geometry), ADR 0014 (SVG/DXF cut export)

## Context

Phase 12 adds card backs, double-faced cards (DFC), paired pages, and print flip modes. Duplex must preserve each physical copy's slot, leave blank/skipped positions stable, and place back artwork upright. The existing `WorkingCard.faces`, `selectedArtworkByFace`, MPC face references, and shared page-placement engine remain the source of identity and artwork state.

## Back identity and resolution

There are three distinct concepts:

| Concept | Stored as | Meaning |
| --- | --- | --- |
| DFC back face | `WorkingCard.faces.back` and `selectedArtworkByFace.back` | The real back face of the same logical card identity. It may resolve from a different provider than the front. |
| Provider physical manual back | `WorkingCard.manualBackArtwork` | A user-locked provider artwork assigned to the physical back. Its `faceId` identifies the source artwork face; it does not add or imply a `CardFace.back` or DFC identity. It can be Scryfall, MPC, or a validated local upload. For simple cards, the picker queries MPC source-face references on both sides while Scryfall follows the selected identity's front artwork. |
| Generic Project back | immutable Back Library reference `{assetId, sha256, format}` | A reusable cardback inherited by cards in `project-default` mode or chosen as a manual generic override. |
| MPC shared cardback | `sharedMpcCardback` | The imported order-level MPC cardback. It is never implicitly a DFC face or a Project default. |

Every `WorkingCard` has an explicit back mode:

| Mode | Effective source |
| --- | --- |
| `auto` | The DFC's provider-backed back face when its semantic layout and face metadata prove two named faces. |
| `project-default` | The current immutable Project Back Library reference. |
| `manual` | A locked DFC back face, provider physical manual artwork, or immutable Back Library reference. Only one generic/manual source is active at a time. |
| `none` | An intentionally blank physical slot. |

DFC detection requires a supported provider layout (`transform`, `modal_dfc`, `double_faced_token`, or `reversible_card`) and exactly two named faces. Provider metadata stays attached to one `CardIdentity`; front and back selections resolve independently. Provider refresh, re-resolution, and other-face changes cannot replace a manual back lock. Restoring automatic selection is an explicit action and clears a user-selected back face before auto-resolution resumes.

The Project default is stored as `assetId + SHA-256 + format`, never as a temporary URL. Back Library upload validates actual JPEG/PNG bytes, dimensions, and limits, then stores the original without recompression. The content-addressed original is the PDF source. Retiring a library item only hides it from new choices: the list DTO marks it `selectable: false`, while a retired asset currently referenced by the Project or active card remains present as that select's current value. Project create/save/recovery APIs validate every Back Library reference against its immutable record and reject a retired reference unless the same Project already has that exact reference at the same setting/card location. The byte-free metadata tombstone and original stay resolvable by immutable ID/hash so existing Projects remain reproducible. Re-uploading the same bytes revives the same identity.

## Missing backs

Project settings store one explicit policy:

| Policy | Result |
| --- | --- |
| `use-project-default` | A missing non-DFC `auto` back can use the configured Project default. A DFC back, manual override (including an unavailable manual reference), and explicit `none` are never replaced. Any remaining missing back stays blank and is reported. |
| `blank` | Keep every unresolved/missing back blank in its paired physical slot. |
| `warn-and-continue` | Keep missing slots blank, report each affected physical copy, and continue. |
| `block` | Return `BACK_REQUIRED` with the preflight list before creating any PDF. |

No generic Magic back is synthesized. Blank slots retain page and slot positions; following cards do not move.

## Shared pagination and page pairing

Quantity is expanded once into an ordered physical-copy list at composition time. The existing `calculateGridPagePlacements` paginator creates the only front page sequence. `core/duplex/shared-placement.ts` builds that shared page plan, including page dimensions in mm, card orientation, bleed envelope, skipped slots, registration-reserved zones, and template geometry. Preview and PDF export consume the same helper. The duplex core transforms each shared placement; it does not paginate again.

For each page, the plan records one-based front/back page numbers, a slot pair for every grid slot (including empty, skipped, and reserved slots), the physical-copy index when present, the reflection axis, the transformed placement, and artwork orientation metadata. A final partial page remains paired to its corresponding partial back page.

### Slot transform and artwork orientation are separate

The physical slot transform reflects placement coordinates around the full physical page in millimeters. It transforms the trim and slot bounds and remaps row, column, and slot index. It does not transform artwork pixels. The PDF engine places each artwork in its normal supplied orientation, respecting `cardOrientation`; no `scaleX(-1)`, raster rotation, or arbitrary image mirror is applied.

| Page orientation | Print flip | Physical slot transform | Back artwork in PDF page coordinates |
| --- | --- | --- | --- |
| Portrait | Long edge | Mirror X | Supplied orientation: 0° rotation, no mirror |
| Portrait | Short edge | Mirror Y | 180° vector placement rotation, no mirror |
| Landscape | Long edge | Mirror Y | 180° vector placement rotation, no mirror |
| Landscape | Short edge | Mirror X | Supplied orientation: 0° rotation, no mirror |

The numbered 3×3 fixture pairs every `nF` with `nB` and carries an asymmetric `TOP ↑` marker on each face. The PDF engine distinguishes slot coordinates from artwork orientation: slots are remapped by the physical page reflection, while the back artwork's PDF placement is rotated 180° for a Y reflection. The four fixtures prove the arrow's final direction after composing artwork rotation with the sheet flip. PDF tests inspect the emitted vector matrix, exact trim translation, and original JPEG stream bytes. No image pixels are edited or re-encoded for duplex.

`pageOrientation`, `cardOrientation`, and `registration.orientation` remain separate. Registration marks and reserved zones are generated from Project settings in mm and reflected into the paired back page's physical coordinate frame using the same sheet axis as slot mapping. The back preview applies that page matrix to cut-path and cut-guide overlays as well, so custom asymmetric cut paths stay aligned to back placements. This is a preview-coordinate transform only: SVG/DXF Cut Export retains the nominal template geometry and source hash. The PDF draws registration marks as page vectors, not artwork. Slot reflection never changes the template ID/version/package hash, cut source identity, or nominal 63.5 × 88.9 mm Magic trim.

A known DFC in `auto` mode always requires its provider-backed back face. If metadata identifies two faces but that back artwork is unresolved, the Project generic back does not substitute for it: the missing-back policy reports, leaves blank, or blocks the slot. Project defaults apply to cards explicitly in `project-default` mode and ordinary missing backs, while a manual DFC back remains locked.

## Export modes

| Mode | Contract |
| --- | --- |
| `front-only` | Existing front PDF path and default for Projects created from v1/v2/v3 snapshots. Artwork selection and front geometry are unchanged. |
| `back-only` | A standalone back PDF using the shared front page count and transformed paired placements. It can be reprinted without creating fronts. |
| `front-back-separated` | Two independently printable PDF members, `front.pdf` and `back.pdf`, plus `manifest.json`, packaged as a ZIP. The manifest records Project revision, page/card orientation, flip mode, matching page numbers, every slot mapping and state, and SHA-256 for each PDF. The package does not replace independent front-only/back-only exports. |
| `duplex` | One PDF in exact order `front page 1`, `back page 1`, `front page 2`, `back page 2`, continuing by explicit page-pair ID. |

Changing a content mode never changes card artwork selections. JPEG passthrough, PNG lossless embedding, supported SVG vector placement, bleed per original, registration, and cut guides continue through the existing PDF engine. Duplex changes page-space placement, not source pixels. Back originals are hashed and cached by their own source/settings, independently from fronts.

## Project and API state

Project schema v4 stores per-card back mode and override lock, optional `manualBackArtwork` source/provider IDs, Project default back reference, missing-back policy, flip mode, and content mode. `manualBackArtwork` is an additive v4 field containing only the exact durable artwork candidate reference and source face/provider IDs; uploads remain resolvable through their SHA-addressed original. It survives autosave, reopen, duplicate, and recovery. Front artwork changes and identity/provider re-resolution preserve the explicit manual lock. Deserialization accepts v1/v2/v3 and supplies safe defaults: front-only, long-edge, no Project default, and `use-project-default` missing policy. Artwork bytes, filesystem paths, and temporary URLs are never embedded in Project JSON.

For Project-based exports, the API reopens the supplied Project ID at `expectedProjectRevision`, compares the full normalized card list (identity, face selections, MPC refs, manual locks, order, and quantity) and every export-relevant saved setting, and uses the persisted snapshot for rendering. Stale or client-mutated state is rejected. Request bodies remain bounded; responses expose metadata and PDF bytes only through the relevant download, without leaking original storage paths.

## Calibration boundary

Flip geometry uses nominal page dimensions and identity calibration. Phase 12 does not add printer profiles, X/Y offsets, scale or rotation correction, skew, calibration sheets, or hidden Silhouette adjustments. Phase 13 owns all measured hardware correction. The core plan can accept a later explicit calibration transform without changing identity, pagination, or source-art fidelity.

## Verification artifacts

`tests/fixtures/duplex/numbered-slot-fixture.json` records the 3×3 pairing for all four orientation/flip combinations. `tests/core/duplex.test.ts` also covers 1×1, 2×2, 4×2, custom template geometry, reserved/skipped slots, partial final pages, and 100-copy multi-page mapping. Generated software validation output is kept under `artifacts/phase-12-duplex-validation/`; no artifact is evidence of physical printer alignment.
