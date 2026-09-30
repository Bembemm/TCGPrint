# Phase 7C Projects Autosave and Recovery Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, with test-first changes and a commit for each coherent deliverable.

**Goal:** Complete Phase 7 by automatically saving the current Project, serializing concurrent edits, and recovering staged snapshots safely after interruption or revision conflict.

**Architecture:** Keep the existing SQLite v1 database, `ProjectSnapshotV1` serializer, repository, and server API boundary. The client stages each autosave snapshot in `project_recovery` before promoting it with the repository's existing revision CAS; the UI offers explicit restore/discard decisions when opening a Project with a staged candidate.

**Tech Stack:** Next.js App Router, React, TypeScript, Vitest, `better-sqlite3`.

**Spec:** `IMPLEMENTATION_PLAN.md` sections 68–70, 128–130, 153–154; `docs/decisions/0010-project-persistence.md`; `docs/decisions/0001-sqlite-driver.md`; `docs/decisions/0005-card-identity-artwork-cache.md`.

## Global Constraints

- Projects persist in `.tcgprint/projects.sqlite`, separate from `.tcgprint/artwork-cache.sqlite`.
- SQLite access stays server-side in the Node.js runtime; client components do not import the SQLite module.
- `ProjectSnapshotV1` remains the only logical Project format and is validated at persistence/API boundaries.
- Preserve each `WorkingCard.id`, face selections, selected artwork, and all settings included by the existing serializer.
- Do not persist active selection, undo/redo history, provider request state, errors, or other transient UI state.
- Project open must not start Scryfall/MPC/OCR lookup, artwork download, prepare, or other provider work.
- A save based on a stale revision must never overwrite canonical Project data silently.
- Originals and shared artwork cache remain outside Project deletion, duplication, autosave, and recovery writes.
- Do not add authentication, cloud storage, social, marketplace, or unrelated editor/export features.
- No SQLite schema bump, second serializer, second repository, or application-wide database.

## Review Focus

- A newer edit arrives while a save is in flight: the latest snapshot must be saved after the earlier CAS advances the revision.
- The server commits promotion but the response is lost: retry/reconciliation must not duplicate or lose the successful save.
- A staged recovery is based on an obsolete revision: the canonical Project must remain intact and the candidate must remain recoverable or be explicitly discarded.
- Two tabs save from the same revision: one CAS wins; the other surfaces a conflict without silently retrying over it.
- The active Project is deleted while a client has queued work: late responses must not recreate it or switch the session to a deleted record.

---

### Task 1: Expose recovery through the existing persistence API

**Files:**
- Modify: `persistence/projects/repository.ts`
- Modify: `services/project-api.ts`
- Create: `src/app/api/projects/[projectId]/recovery/route.ts`
- Create: `src/app/api/projects/[projectId]/recovery/promote/route.ts`
- Create: `src/app/api/projects/[projectId]/recovery/copy/route.ts`
- Modify: `src/app/project-api-client.ts`
- Test: `tests/persistence/project-repository.test.ts`
- Test: `tests/services/project-api.test.ts`
- Test: `tests/app/project-api-client.test.ts`

**Interfaces:**
- Consumes: existing `ProjectRepository.stageRecovery`, `readRecovery`, `promoteRecovery`, `discardRecovery`, `save`, and existing snapshot serializer.
- Produces: `ProjectOpenDto` with nullable recovery metadata/snapshot; client methods `stageRecovery(projectId, expectedRevision, snapshot)`, `promoteRecovery(projectId)`, `discardRecovery(projectId)`, and `copyRecovery(projectId)`.
- `copyRecovery` creates a new Project from the staged snapshot and deletes the old recovery row in one transaction, preserving `WorkingCard.id`s and leaving the source canonical snapshot unchanged.

- [x] Add service/repository tests for staging without changing the canonical snapshot, CAS promotion, discard, idempotent recovery staging, and copying a stale recovery into a new Project.
- [x] Run the targeted tests and confirm expected failures before implementation.
- [x] Implement only the recovery API/repository boundary; retain schema v1 and the existing serializer.
- [x] Run recovery, repository, API, serializer, and SQLite tests.
- [x] Commit: `feat(projects): expose recovery operations` (`71c6342`).

### Task 2: Add a debounced, serialized autosave queue

**Files:**
- Create: `src/app/project-autosave.ts`
- Modify: `src/app/project-session.ts`
- Test: `tests/app/project-autosave.test.ts`
- Test: `tests/app/project-session.test.ts`

**Interfaces:**
- Consumes: canonical snapshot string from `projectSnapshotKey`, current Project ID/revision, and the recovery-aware API client.
- Produces: an injectable `ProjectAutosaveQueue` that accepts the latest snapshot, schedules a 600 ms trailing debounce with a 2,000 ms maximum wait, allows one save operation in flight, and drains the newest queued snapshot after each successful revision advance.
- Transient failures retry with bounded exponential backoff; HTTP 409 is terminal for that queue generation and requires an explicit conflict decision.

- [x] Test trailing debounce, maxWait, one in-flight save, edits during save, stale response suppression, retry, and terminal CAS conflict using fake timers/deferred promises.
- [x] Run the queue tests and confirm expected failures before implementation.
- [x] Implement the queue with injected timers and save callbacks so timing and serialization are deterministic in tests.
- [x] Add reducer actions/status needed to represent retryable failure and conflict without advancing the revision.
- [x] Run the queue and session tests.
- [x] Commit: `feat(projects): add serialized autosave queue` (`700d1d7`).

### Task 3: Integrate autosave and recovery/conflict UX

**Files:**
- Modify: `src/app/projects-panel.tsx`
- Modify: `src/app/project-session.ts`
- Modify: `src/app/card-identity-workbench.tsx` only if restore handoff requires it.
- Modify: `tests/app/projects-panel.test.tsx`
- Modify: `tests/app/project-restore-provider-gate.test.ts`
- Test: `tests/app/project-session.test.ts`

**Interfaces:**
- Consumes: `ProjectAutosaveQueue`, `ProjectOpenDto`, and recovery API operations from Tasks 1–2.
- Produces: autosave status, a manual “Salvar agora/Tentar novamente” action, and explicit recovery actions before replacing the active Working Set.

- [x] Add tests for opening with a current recovery (promote or discard), stale recovery conflict (copy or discard/open canonical), and server-write conflict preserving local state.
- [x] Run the provider-gate regression for artwork/identity lookups; verify that reload/open/recovery smoke sends no card, download, or prepare requests.
- [x] Run the UI/session/provider-gate tests and confirm expected failures before implementation.
- [x] Integrate queue lifecycle with project activation/deletion and use snapshots from the existing serializer.
- [x] Present recovery choice before loading project cards/settings; use the existing restore gate after the user chooses.
- [x] Run all focused Project tests, including API client, repository, service, session, panel, and restore gate.
- [x] Commit: `feat(projects): integrate autosave and recovery UX` (`96a51e1`).

### Task 4: Full validation and branch audit

**Files:**
- Review the complete branch diff; change files only for findings that violate the spec or block acceptance.

- [x] Run the focused Project tests and the full `npm test` suite (53 files passed; 601 tests passed, 1 skipped).
- [x] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [x] Start the local app and perform a browser smoke of create/edit/autosave/reload/recovery/open; verify recovery decisions and absence of provider requests on open.
- [x] Review the complete diff against the plan, ADRs, and preserved 7A/7B guarantees; blocking findings were fixed before completion.
- [x] No additional final fix was required after the review; all gates passed on the implementation commit.
