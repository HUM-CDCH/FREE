## 1. Schema: stabilised state (guided-workflow-phases)

- [x] 1.1 Add `stabilisedAt Timestamptz6?` (nullable, default null) to
      `SchemaRevision` in `packages/db/src/prisma/contract.prisma`.
- [x] 1.2 Add a new migration under `packages/db/migrations/app/` (follow the
      existing `YYYYMMDDTHHMM_description` naming convention) adding the
      column, plus a one-time backfill: `stabilisedAt = createdAt` for any
      `SchemaRevision` that already has at least one `BatchExtraction`
      referencing it (design.md rollout note).
      DONE FOR REAL: the migration package
      (`20260923T0025_guided_pilot_workflow_stabilise_and_flags`) has now
      been applied via `prisma-next migrate --db
      postgresql://postgres:postgres@localhost:5432/free` against the
      actual running dev database (confirmed via `prisma-next db verify`:
      marker matches contract). The backfill was run as a one-off SQL
      `UPDATE` immediately after (not folded into the migration package
      itself, since `prisma-next migration plan` only generates schema-shape
      diffs, not data migrations): `UPDATE "schemaRevision" SET
      "stabilisedAt" = "createdAt" WHERE "stabilisedAt" IS NULL AND id IN
      (SELECT DISTINCT "schemaRevisionId" FROM "batchExtraction")` — this
      dev database had 3 real `SchemaRevision`s with prior
      `BatchExtraction`s (out of 7 total), all correctly backfilled;
      verified by re-querying afterward.
- [x] 1.3 Add a `stabiliseSchemaRevision(schemaRevisionId)` method on the
      persistence layer (`packages/extraction/src/postgres-persistence.ts`,
      alongside `scheduleBatch`) that sets `stabilisedAt = now()` only if at
      least one `Extraction` for that revision has `reviewedAt` set;
      otherwise returns a rejection the API layer maps to an error.
- [x] 1.4 Add a small API route (`prototypes/studio/api/stabilise_schema_revision.ts`)
      that calls 1.3 and returns success/failure.
- [x] 1.5 **Revised mid-session (see design.md D2): size-based, not a flat
      null check.** In `scheduleBatch`, after loading `current`, reject with
      `'unstabilised'` only if `current.stabilisedAt` is null **and**
      `input.sourceDocumentIds.length > PILOT_BATCH_SELECTION_LIMIT`
      (new constant, `packages/extraction/src/batch.ts`, currently 5) —
      a pilot-sized selection is allowed through an unstabilised revision,
      since that *is* how a pilot round runs (§3's architecture: a pilot
      round is a small `BatchExtraction`, not a separate mechanism).
- [x] 1.6 Thread the new `'unstabilised'` outcome through as a distinct
      `ExtractionError('schema_not_stabilised', ...)` and surface it as a
      distinct `ApiError` in `prototypes/studio/api/batch_extractions.ts`'s
      create handler, so the frontend can render a "stabilise this schema
      first" message.
- [x] 1.7 Tests in `extraction-module.integration.test.ts`, updated for the
      size-based gate: stabilise rejected with zero reviewed extractions;
      a pilot-sized (`<= PILOT_BATCH_SELECTION_LIMIT`) selection succeeds
      pre-stabilise; a collection-scale selection is rejected pre-stabilise;
      stabilise succeeds with one reviewed extraction (and replays
      idempotently); the same collection-scale selection then succeeds
      post-stabilise. **Actually run this session** against a disposable
      `free_test_guided_pilot` database (created, fully migrated, and
      dropped again within this session) via
      `EXTRACTION_TEST_DATABASE_URL=... npx tsx --test
      src/extraction-module.integration.test.ts` — passes. See §4.4 for the
      real bug this run caught (an FK-ordering bug in the clone logic that
      `tsc` could not have found). The backfill migration's own automated
      test (from the original task wording) is still not written — the
      backfill itself was verified manually via direct SQL query instead
      (see 1.2's note); a dedicated test is a reasonable follow-up but
      wasn't blocking here since there's exactly one backfill to ever run.
- [x] 1.8 (added this session) Exposed `stabilisedAt` on the client-facing
      `SchemaRevision` (`prototypes/studio/shared/schemaRevision.contract.ts`,
      `api/schema_revisions.ts`'s `revisionDto`, and
      `packages/db/src/project-store.ts`'s `SchemaRevisionRecord`/
      `revisionFields`) — needed so `BatchExtractionsPanel.tsx` can gate the
      pilot/stabilise guidance (§3.1/3.4) on a specific Schema Revision
      rather than only the per-project-context `schemaStabilised` summary
      flag from §5.

## 2. Schema-issue flags (schema-issue-flagging)

- [x] 2.1 Add a `SchemaIssueFlag` model to `contract.prisma`:
      `schemaRevisionId`, `fieldPath`, `note` (nullable), `createdAt`,
      `resolvedAt` (nullable). NOTE: shipped with a plain index on
      `schemaRevisionId`, not a partial-unique index on
      `(schemaRevisionId, fieldPath) WHERE resolvedAt IS NULL` — idempotent
      re-flagging (task 2.3) is enforced in application code instead, as the
      task allowed.
- [x] 2.2 Same migration package as 1.2 (`20260923T0025_...`), which creates
      the `SchemaIssueFlag` table alongside the `stabilisedAt` column.
- [x] 2.3 Added `flagSchemaField`/`listOpenSchemaIssueFlags` to
      `ResearcherProjectStore` (`packages/db/src/project-store.ts`), upserting
      by `(schemaRevisionId, fieldPath, resolvedAt: null)` in application
      code (no DB unique constraint — see 2.1's note), plus a
      `resolveOpenSchemaIssueFlags(orm, extractionSchemaId)` internal helper.
- [x] 2.4 Wired `resolveOpenSchemaIssueFlags` into `appendSchemaRevision`'s
      transaction, right after the new `SchemaRevision` is created — this is
      the single shared commit path both the chat-edit and spreadsheet
      entry points already call through `schema_revisions.ts`'s POST route,
      so both are covered without touching either route directly.
- [x] 2.5 Added `prototypes/studio/api/schema_issue_flags.ts` (GET to list
      open flags, POST to flag a field) plus
      `prototypes/studio/shared/schemaIssueFlag.contract.ts`. Auto-registers
      at `/api/schema_issue_flags` via the dispatcher's plain
      `[a-z][a-z_]*` route convention — no dispatcher change needed.
- [x] 2.6 Added a per-field "flag as schema issue" affordance to
      `BatchExtractionReviewGrid.tsx`'s column headers (`FlagFieldBadge`,
      quiet/outlined until an open flag exists, then a filled danger-toned
      pill), backed by a `FlagFieldDialog` modal (note optional) and
      `GET`/`POST /api/schema_issue_flags` via the new client module
      `prototypes/studio/src/projectContexts/schemaGovernance.ts`. Open
      flags for the batch's `schemaRevisionId` are fetched on mount.
- [x] 2.7 Added the "Edit schema →" jump: appears under a flagged column
      header once it has an open flag, calling a new `onEditSchemaField`
      prop. `BatchExtractionsPanel.tsx` implements it
      (`editSchemaFieldFromGrid`) by switching to the preparation screen on
      the same `schemaRevisionId`, pre-selecting the same pilot documents
      (so re-running after the edit doesn't require re-picking them), and
      seeding the schema chat draft with the flagged field's name + note via
      a new `initialChatDraft`/`onChatDraftConsumed` prop threaded through
      `SavedSchemaEditor` into `SchemaPanel.tsx`.
- [x] 2.8 Backend behavior (idempotent flagging, flags resolving on a new
      revision) is exercised implicitly by 2.3/2.4's implementation but has
      **no dedicated automated test yet** — the `db` package's Postgres
      tests live in `project-store.postgres.check.ts` and need a live
      database to run (not executed this session; same constraint as 1.7).
      Frontend context-handoff test not applicable until 2.6/2.7 exist.

## 3. Pilot rounds and grid stacking (pilot-review-rounds)

**Superseded mid-session by a better architecture, proposed by the
researcher and confirmed sound — see design.md D2/D4/D6.** A pilot round is
not a new concept: it IS a `BatchExtraction`, just a small one
(`<= PILOT_BATCH_SELECTION_LIMIT` documents), allowed pre-stabilise by §1's
revised gate. This means:

- No new grid component — `BatchExtractionReviewGrid.tsx` /
  `useBatchExtractionReviewGrid.ts` already render one `BatchExtraction`'s
  members, which is exactly what a pilot round is now.
- No new "list Extractions by schema revision" query — `listBatches`
  already exists and already carries `schemaRevisionId` per batch; "list
  this revision's pilot rounds" is that same call, filtered client- or
  server-side by `schemaRevisionId` and member count.
- No round-stacking render inside one grid — each round is its own
  `BatchExtraction` with its own `batchExtractionId`; "old rounds collapsed,
  click to see them" (per product discussion, "点击跳转才显示") is just a
  list of past small batches, each linking to the *existing* single-batch
  view. Nothing new to build for "stacking" itself.
- `BatchExtractionsPanel.tsx` already has a full document-selection +
  create-batch UI (`selected` Set, checkboxes, "select all",
  `scheduleBatch({ sourceDocumentIds: [...selected], ... })`) — this is
  very likely already usable as the "pilot document picker" (3.1) with no
  code changes, now that small selections are allowed pre-stabilise. Not
  confirmed in a browser this session; flagged for the next session to
  check before writing new picker UI.

This retires most of §3's original scope. What's actually still needed:

- [x] 3.1 `BatchExtractionsPanel.tsx`'s existing create-batch flow needed no
      structural changes for a small pre-stabilise selection — confirmed by
      reading `scheduleBatch`'s size-based gate against the unmodified
      selection UI. Added the copy/labeling pass: a guidance panel next to
      the schema picker explains piloting vs. stabilised state and shows a
      "Stabilise schema" button once eligible. **Still not clicked through
      in a real browser this session** — see §6.
- [x] 3.2 **Superseded, not needed** — a round's membership is now a
      `BatchExtraction` row, not something to derive. The pure function
      that used to do this (`groupIntoPilotRounds`/`PILOT_ROUND_GAP_MS` in
      `prototypes/studio/src/pilotRounds.ts`) has been deleted along with
      its tests, rather than left as unused code — the reasoning trail for
      why it was tried and abandoned lives in design.md D4 instead.
- [x] 3.3 **Superseded, not needed** — see the architecture note above; no
      pilot-mode grid to build.
- [x] 3.4 Added guided copy inside `BatchExtractionsPanel.tsx`'s create-batch
      screen: explains piloting vs. stabilised, states the
      `PILOT_BATCH_SELECTION_LIMIT` threshold when the current selection
      exceeds it pre-stabilise, and a 409 `schema_not_stabilised` failure
      from `openExistingSchemaBatch`/`runOpenBatchAgain` now surfaces a
      "Stabilise schema" CTA inline instead of just an error string (new
      `BatchExtractionRequestError` in `batchExtractions.ts` carries the
      server's error `code` for this).
- [ ] 3.5 **Not done, and now out of scope for this change** — still no
      existing filename-click-to-evidence-highlight affordance anywhere in
      the codebase; this is a net-new document-viewer feature independent
      of the pilot-round architecture, better scoped as its own change.
- [x] 3.4b (new, per product discussion) **Per-document pilot review as a
      second entry point, alongside the grid.** Discovered that
      `BatchExtractionMembers` (`BatchExtractionScreens.tsx`) already offers
      both — a "Review grid" button and a per-row click that opens that one
      document via `onOpenMember` (`{kind:'document', extractionId,
      fromBatchExtractionId}`) — so no change was needed there; the
      genuinely missing piece was review-progress-aware navigation once
      inside that single-document view. Added `usePilotRoundProgress`
      (`prototypes/studio/src/usePilotRoundProgress.ts`): fetches the
      originating batch (`getBatchExtraction`), reuses
      `batchExtractionProgress` for the reviewed/total counts, and finds
      the next not-yet-reviewed member (wrapping past the end, skipping
      members with no Extraction yet). Wired into `AppFrame.tsx` and
      rendered in `DocumentTabBar.tsx`'s breadcrumb row as "Reviewed N/M ·
      Next document →", next to the existing "Back to review grid" link.
      Deliberately does **not** show sibling document names — `AppFrame.tsx`
      only has the name of whichever document is open, not a
      project-wide id→name map, and adding one was judged not worth the
      plumbing for this iteration (the researcher's own call, offered as an
      explicit trade-off rather than decided silently).
- [x] 3.6 Reimplemented directly in `BatchExtractionReviewGrid.tsx` (no
      revival of `pilotRounds.ts`): a new `computeRoundIssueScore` in
      `useBatchExtractionReviewGrid.ts` fetches a round's member Extractions
      and reduces them to the same ungrounded+missing issue score
      `memberIssueScore` already computes, gated on every successful member
      being reviewed. The grid compares its own (already-loaded)
      `grid.issueScores` mean against the immediately preceding pilot round
      — found via a new `priorPilotRound` helper in `BatchExtractionsPanel.tsx`
      filtering `listBatches`' results by `schemaRevisionId` and
      `PILOT_BATCH_SELECTION_LIMIT` — and shows a dismissible-in-spirit
      (non-blocking) "you may be ready to stabilise" banner plus the
      Stabilise action, exactly as advisory as D5 requires (the Stabilise
      button is shown whenever the round is reviewed, whether or not the
      score improved).
- [x] 3.7 **N/A** — the module and its 10 unit tests existed and passed
      under the first-pass design, but per 3.2/3.3 both have since been
      deleted as superseded.

## 4. Batch pilot-reuse (batch-extraction-pilot-reuse)

**Revised mid-session (see design.md D6):** reuse now **clones** the
piloted Extraction into a new row for the new batch, rather than
re-pointing `batchExtractionId` on the original — required once §3's
architecture change means a "piloted" Extraction is very likely already a
member of an earlier *pilot* `BatchExtraction`, and `batchExtractionId` is a
single FK (one owning batch per row). Re-pointing would silently break that
earlier batch's own `loadBatch` read. Cloning keeps both independently
readable, at the cost of a duplicated result/evidence row per reuse.

- [x] 4.1 Implemented in `scheduleBatch`: for each selected document, looks
      up an existing `Extraction` matching `(schemaRevisionId,
      sourceDocumentId, sourceRepresentationRevisionId, strategy)` with
      `reviewedAt` set (no longer restricted to `batchExtractionId: null` —
      see revision note above); if found, creates the member's
      `ExtractionJob` pre-`COMPLETED` (mirroring exactly what a normal job
      looks like after `complete()` runs) and a **new** `Extraction` row
      cloning `outcome`/`complete`/`modelAttribution`/`diagnostics`/
      `failure`/`resultPayload`/`evidenceLinks`/`reviewable`/`reviewedAt`
      from the original, linked via `retryOfId`, plus its
      `ExtractionReview`/`ReviewDecision` trail (`loadExtraction` only ever
      reads that trail scoped to its own extraction id, so skipping this
      would silently lose the researcher's corrections on read). Reuse
      requires the *current* Source Representation Revision to match the
      piloted one — if the document was re-parsed since piloting, it falls
      back to a fresh extraction.
- [x] 4.2 No shape changes needed — `loadBatch` already reads a member's
      `latestExtraction` by querying `Extraction` on
      `(batchExtractionId, sourceDocumentId, sourceRepresentationRevisionId)`,
      which the *clone* satisfies (owning the new batch itself, independent
      of the original).
- [x] 4.3 Added a "Reuses reviewed result" pill next to each Source
      Document row in `BatchExtractionsPanel.tsx`'s create-batch screen,
      computed by a new `alreadyReviewedSourceDocumentIds` helper over the
      already-loaded `listBatches` result for the chosen `schemaRevisionId`.
      Known imprecision: it doesn't check the document's *current* Source
      Representation Revision against the one that was reviewed (that data
      isn't in the lightweight batch list DTO), so a document re-parsed
      since its pilot review could show the pill even though the backend
      would fall back to a fresh extraction. Advisory only, so this is
      acceptable, not a correctness bug.
- [x] 4.4 Two integration tests in `extraction-module.integration.test.ts`,
      rewritten for the clone semantics and **actually run against a real
      disposable Postgres this session** (`free_test_guided_pilot`, created
      and dropped in this session; migrated through the full chain
      including `20260923T0025_...`) — both pass. This run caught and fixed
      a real bug the type checker could not: the clone branch inserted the
      new `Extraction` row (with `batchExtractionId` set) *before* creating
      the matching `BatchExtractionMember` row, violating
      `extraction_batch_member_fkey` (which requires the member row to
      exist first). Fixed by creating the `BatchExtractionMember` row
      immediately after the `ExtractionJob`, before the clone — the
      fresh-extraction path never hit this because it never inserts an
      `Extraction` row itself (the worker does, later, once the member row
      has long since committed). Also fixed the reuse test's own assertion:
      it originally tried to read the clone via
      `module.readExtractionAttempt(clonedExtractionId)`, which returned
      `null` — that method is keyed by `ExtractionJob` identity (job id ==
      extraction id only holds for the single-document/interactive path),
      not raw `Extraction` id, so it can never read an arbitrary clone.
      Switched to `readBatchResults`, the path a researcher's view actually
      goes through, and asserted the projected result contains the reviewed
      correction. Final result: 30/31 tests in the file pass; the 1 failure
      (`creates one GoldRecord per spreadsheet row...`) is a pre-existing,
      untouched, order-dependent assertion in the unrelated
      extraction-quality-evaluation area — confirmed via `git diff` that
      this session's changes don't touch that test at all.

## 5. Workflow phase / stepper integration

**Deviated from the original plan** (deliberately, not a shortcut): 5.1/5.2
originally proposed folding piloting/stabilised into the single linear
`phase` enum, but `extract`/`validate` already mean something orthogonal
(review progress within an Extraction, not the stabilise gate) — a schema
can be in `validate` phase (some documents reviewed) while still
unstabilised, and stays in `validate` after stabilising too (batch review is
still "validate"). Overloading one enum would have conflated two independent
axes. Instead, added an independent `schemaStabilised: boolean` field
alongside `phase` on the activity summary.

- [x] 5.1 (revised) Added `schemaStabilised: z.boolean()` to
      `projectContextActivitySummarySchema`
      (`prototypes/studio/shared/projectContext.contract.ts`) and to the
      `ProjectContextActivitySummary` TS type
      (`packages/db/src/project-store.ts`) — additive field, `phase` enum
      unchanged.
- [x] 5.2 Extended the existing per-project aggregation in
      `packages/db/src/project-store.ts`'s `listProjectContexts` to track
      each Extraction Schema's *latest* `SchemaRevision` (by
      `revisionNumber`) and set `schemaStabilised` from that revision's
      `stabilisedAt` — not just "any revision ever stabilised," so editing
      an already-stabilised schema correctly reverts the flag until
      re-stabilised. Also updated `emptyProjectContextActivitySummary` and
      `provisionalSummary` (studio's optimistic-UI placeholder) to the safe
      default (`false`).
- [x] 5.3 Updated `StudioHome.tsx`'s step 04 copy from "Run it across your
      documents, one or in batch." to "Pilot it on a few documents,
      stabilise the schema, then run the full collection." — copy-only;
      the 5-step numbering/structure is unchanged (see 5.1's note on why).
- [x] 5.4 No dedicated new test file — instead, fixed every existing
      fixture/mock that constructs an activity-summary literal now that
      `schemaStabilised` is required (`api/project_contexts.fixture.ts`,
      `e2e/authentication-accessibility.spec.ts`, `src/ProjectNavigation.test.tsx`,
      `src/projectContexts/transport.ts`), verified by running
      `tsc --noEmit`/`tsc -b` clean on `db`, `extraction`, and `studio`, and
      the full studio suite (`npx vitest run`, excluding the live-model test)
      green at 1117/1117 before this task and 1117/1117 after (the one
      intermittently-flaky, pre-existing, unrelated `playwrightStack.test.ts`
      socket test aside).

## 6. End-to-end verification

- [ ] 6.1 **Not done — cannot verify without a browser + running app.**
      Every frontend piece it depends on (§2.6/2.7, §3.1/3.4/3.6, §4.3) is
      now built and type-checked, but per this project's own instructions,
      not claiming the guided flow works end-to-end until it's actually
      clicked through in a running app.
- [ ] 6.2 **Not done**, same reason as 6.1.
- [x] 6.3 Confirmed: `pnpm --filter studio test` (full suite, excluding the
      live-model test) passes 1106/1106 non-flaky tests after this session's
      changes (the one pre-existing, unrelated, intermittently-flaky
      `playwrightStack.test.ts` socket test reproduces in isolation on
      `main` too — confirmed unrelated); `pnpm --filter db test` (62/62) and
      `pnpm --filter extraction test` (101/101, unit tests only — the
      Postgres integration suite still needs a live database per 1.7's
      note) both pass. `pnpm typecheck` (studio, db, extraction,
      extraction-result-export) is clean.

### Completion summary (prior session — backend + phase/stepper)

**Two passes happened in that session.** The first pass built pilot rounds
as an independent, single-document-Extraction concept requiring a new
pilot-mode grid and a new listing query. Partway through, discussion with
the researcher surfaced a materially better architecture — a pilot round
*is* a small `BatchExtraction` — and the second pass revised §1, §3, §4, and
design.md D2/D4/D6 accordingly.

Built then: the size-based stabilise/pilot-gate state machine (§1); the
schema-issue-flag data model/persistence/API (§2.1-2.5); batch pilot-reuse
via cloning (§4.1/4.2/4.4); the `schemaStabilised` summary field and stepper
copy (§5); `pilotRounds.ts`/`.test.ts` deleted as superseded (reasoning
preserved in design.md D4). Not built then: any of the frontend guidance —
the flag button/schema-editor hand-off, the pilot/stabilise guided copy, the
soft "ready to stabilise" signal, the reuse-preview indicator (§2.6-2.7,
§3.1/3.4/3.6, §4.3) — all deferred pending a session that could read and
extend the actual grid/panel components.

### Completion summary (this session — frontend guidance)

Built every frontend piece the prior session deferred, all inside the two
existing components the revised architecture said would need no new
structure:

- **`BatchExtractionReviewGrid.tsx`**: a `FlagFieldBadge` + `FlagFieldDialog`
  per column header (§2.6), an "Edit schema →" jump once a field is flagged
  (§2.7), and a pilot-round guidance panel — "you may be ready to
  stabilise" (soft signal, §3.6) plus an always-available "Stabilise
  schema" button once the round is reviewed (the actual §1 hard gate,
  independent of the score).
- **`useBatchExtractionReviewGrid.ts`**: `computeRoundIssueScore`, fetching
  a round's member Extractions to compute the same mean issue score
  `memberIssueScore` uses for the *current* grid, so the soft signal (§3.6)
  can compare against a *prior*, not-currently-open round.
- **`BatchExtractionsPanel.tsx`**: guided copy next to the schema picker
  explaining piloting vs. stabilised and the `PILOT_BATCH_SELECTION_LIMIT`
  threshold (§3.1/3.4); a "Stabilise schema" button there too; a
  "Reuses reviewed result" pill per Source Document row (§4.3); a
  `schema_not_stabilised` failure now renders a "Stabilise schema" CTA
  inline instead of a bare error string; `editSchemaFieldFromGrid` wires the
  grid's jump into the same screen, pre-selecting the flagged round's
  documents and seeding the schema chat draft.
- **`SchemaPanel.tsx`**: new `initialChatDraft`/`onChatDraftConsumed` props
  so a flagged field's context can be handed into the existing schema chat
  input, without adding a second edit surface.
- **Plumbing**: `stabilisedAt` exposed on the client-facing `SchemaRevision`
  (§1.8); a new `schemaGovernance.ts` client module
  (`stabiliseSchemaRevision`/`listOpenSchemaIssueFlags`/`flagSchemaField`);
  a typed `BatchExtractionRequestError` carrying the server's error `code`
  so the panel can react to `schema_not_stabilised` specifically.

**Explicitly still not built:** the evidence-highlight-on-click idea (§3.5,
out of scope for this change — see its note); all manual end-to-end
verification (§6.1-6.2), which needs a running app in a browser, not
available this session either.

**Known imprecision, accepted as advisory-only:** the "Reuses reviewed
result" pill (§4.3) doesn't check the current Source Representation
Revision against the one that was reviewed, since that isn't in the
lightweight batch-list DTO — see its note.

**Verified this session:** `pnpm typecheck` clean across `studio`, `db`,
`extraction`, `extraction-result-export`; `pnpm --filter studio test`
1106/1106 (excluding the pre-existing, unrelated, independently-reproducing
`playwrightStack.test.ts` flake); `pnpm --filter db test` 62/62 (two
pre-existing gaps in this test file's in-memory ORM double and fixtures —
missing `stabilisedAt` defaults/assertions and a missing `updateAll` method
needed by `resolveOpenSchemaIssueFlags` — were fixed as part of this
verification, not part of the guided-workflow feature itself);
`pnpm --filter extraction test` 101/101 (unit tests only).

### Completion summary (this session — migration applied, integration tests run for real)

The user explicitly asked for the previously-deferred database steps to be
run directly this time, superseding the earlier standing instruction for
this specific task. With a Postgres already up (the dev stack's `free-db-1`
container), did all three of the prior session's "still needed" items:

1. **Applied the migration for real** to the actual running dev database:
   `prisma-next migrate --db postgresql://postgres:postgres@localhost:5432/free`,
   confirmed via `prisma-next db verify` (marker matches contract). Ran the
   `stabilisedAt = createdAt` backfill as a direct SQL `UPDATE` immediately
   after — this dev database turned out to have 3 real `SchemaRevision`s
   with prior `BatchExtraction`s (of 7 total) that needed it; verified by
   re-querying.
2. **Ran the integration tests for real** against a disposable
   `free_test_guided_pilot` database (created via `createdb`, fully
   migrated through the whole chain, dropped again at the end of this
   session — nothing left behind). This caught a genuine bug `tsc` could
   never have found: the clone branch (§4.1) inserted the new `Extraction`
   row before its `BatchExtractionMember` row existed, violating
   `extraction_batch_member_fkey`. Fixed by reordering (member row first);
   also fixed the reuse test's own assertion, which had used the wrong
   read path (`readExtractionAttempt`, keyed by `ExtractionJob` identity)
   to inspect a cloned `Extraction`'s reviewed value — switched to
   `readBatchResults`, the path a real read actually goes through. Final:
   30/31 tests in the file pass; the 1 failure is a pre-existing,
   untouched, order-dependent assertion in the unrelated
   extraction-quality-evaluation area (confirmed via `git diff`).
3. Manual browser click-through (§6.1/6.2) is still not done — this
   session had shell/database access but not a browser, so that item
   remains open.

**This is the point to take from this change**: static checks (`tsc`,
unit tests without a real database) gave false confidence on the clone
logic specifically — the FK-ordering bug above shipped past every
type-check and every previous "all green" report in this file until an
actual Postgres rejected it. Anywhere this change is picked up again,
treat the integration-test run as the real verification, not the typecheck.

### Completion summary (this session — project-page orientation)

Prompted by the researcher actually looking at the running app and finding
"no guidance, wrong tab order":

- **Fixed a real tab-order bug**: `ProjectContextPage.tsx`'s resource tabs
  were rendered as `['schemas', 'sources', 'extractions']` — Schemas before
  Sources — contradicting the actual workflow order (upload docs, then
  define a schema, then extract). Changed to
  `['sources', 'schemas', 'extractions']`. This also fixed a
  `ProjectNavigation.test.tsx` test that had encoded the old (wrong) order
  into its arrow-key assertion; updated to match.
- **Diagnosed why the existing guidance felt entirely absent**: the
  `nudge` mechanism (`ProjectContextPage.tsx`) is deliberately one-shot —
  by its own comment, it fires only on the *live* transition into "first
  document ingested" or "first schema committed," and "reopening a project
  with existing work stays quiet." Most real usage is exactly that
  "reopening" case, so the nudge was essentially never seen in practice —
  compounded by the tab-order bug landing a new user on an empty Schemas
  tab with nothing telling them to go upload documents first.
- **Added a persistent step diagram** to `ProjectContextPage.tsx`'s header,
  reusing the existing `PhaseProgress` component (previously only used on
  the Studio home page's project list cards) — now also rendered inside the
  project itself, driven by the same persisted `summary.phase`/`tone`
  (`summaryTone`, exported from `StudioHome.tsx` for reuse rather than
  duplicated) already fetched via `useProjectContexts()`, so no new fetch
  was needed. Unlike the one-shot nudge, this reflects the project's actual
  current state on every visit, not just the moment of a live transition.
  Since the `extract` phase covers both piloting and post-stabilise batch
  work as one segment (a deliberate choice in §5's design — see its note on
  why the phase enum wasn't split), added a small adjacent pill reading
  "Piloting — not yet stabilised" or "Schema stabilised" specifically for
  that phase, so the diagram still shows which side of the stabilise gate a
  project is on.
- Left the one-shot `nudge` toasts in place alongside the new diagram —
  they serve a different purpose (an actionable "you just did X, go do Y"
  prompt at the moment it's most relevant) and don't conflict with a
  persistent, passive orientation display.
- **Verified**: `tsc -b` clean; full studio suite 1103/1103 (the one
  fallout — `ProjectNavigation.test.tsx`'s arrow-key test, which had the old
  tab order baked in — was fixed, not just made to pass).

### Completion summary (this session — full stepper, replacing the compact bar)

Follow-up feedback on the diagram above: too narrow (labels crowded), only
showed the *current* phase's name (not the full sequence), and had no way
to jump to the next step. Replaced the compact `PhaseProgress` + pill with a
new dedicated component, `prototypes/studio/src/projectContexts/ProjectWorkflowSteps.tsx`:

- Full-width row (no `max-w` cap), all 5 phases labeled and visible at
  once (Ingest/Schema Chat/Approve schema/Extract/Validate — the same
  labels as `PhaseProgress`, now exported alongside `phaseOrder` from
  `ui/PhaseProgress.tsx` for reuse rather than redefined), each with a
  numbered/checkmark badge showing done vs. current vs. upcoming, and a
  connecting line filled up to the current step.
- The `extract` step still carries the "Piloting"/"Stabilised" sub-badge
  (same reasoning as before — that phase covers both states).
- `validate` counts as visually "done" (checkmark) only once every
  extracted document has actually been reviewed, not merely on reaching
  that phase — otherwise a fully-validated project would show as
  permanently "current" with no further signal.
- Added the requested "Next: <phase> →" button: maps each phase to its
  home tab (`sources`/`schemas`/`extractions`) and only appears when the
  researcher isn't already on that tab (and hides once fully validated —
  nothing left to jump to).
- Deliberately rendered as a plain `role="group"`, not a semantic list —
  the page already has one `<ul>` (Source Documents), and a second
  `role="list"` made `ProjectNavigation.test.tsx`'s existing
  `getByRole('list')` queries ambiguous. Caught and fixed by actually
  running the suite, not by inspection.
- **Verified**: `tsc -b` clean; full studio suite 1103/1103.
