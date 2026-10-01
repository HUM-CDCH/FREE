# Review-counter code-quality review

Requested reviewer: Claude Code, `claude-fable-5-1`, `--effort max`.
Result: **PASS WITH NOTES**, no P1 or P2 findings. Reviewed the frozen 11-file implementation diff and supporting validation evidence. Claude used only Read/Grep/Glob, completed successfully, and made no source edits. SHA-256 checks confirm all 30 scoped code and evidence files match their pre-review snapshot; `git diff --check` passed.

## Coordinator adjudication

- **Accepted P3: hook state after finalization.** `useExtraction.ts:672` can expose `draftSaved: true` after a review is finalized. Current ResultsTab correctly hides the draft label for finalized attempts, so this is a hook-contract inconsistency without a current visible regression. Clear or gate that state and assert it after finalization.
- **Qualified P3: empty persisted drafts.** A restored empty draft with version > 0 really was persisted, so “Draft saved” is truthful. Showing it alongside no completed decisions is unnecessary and differs from the batch surface. Treat this as a UX consistency choice. Claude's “reverse every decision” trigger is inaccurate: Reverse decision sets an explicit approved decision; an actual reset to an empty draft is the relevant case.
- **Qualified P3: accessible persistence feedback.** The new visible “Draft saved” suffix has `aria-live="off"`; progress announcements describe decisions, not successful persistence. Consider a concise polite announcement when persistence completes, retaining quiet in-progress updates. This is a source-level semantic concern; no assistive-technology session was run. W3C describes announcing success status without moving focus, and also cautions against overly chatty live regions: https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- **Qualified P3: read-only count.** Read-only attempts count Evidence links, while editable attempts count the prepared server decision list. The preparation drops links whose anchor is absent from the pinned document's ownership map. A valid published anchor is present even if its occurrence set is empty, so “no occurrences” alone does not establish a discrepancy. No reachable valid-data failure was demonstrated; verify the publishing invariant before treating this as a defect.
- **Accepted coverage gaps:** changed pairing-write accounting, batch recovery/reset, and finalization failure after a successful draft save lack targeted tests in the reviewed changes. These are coverage gaps, not demonstrated production failures.
- **Rejected rapid-write concurrency claim.** Claude overlooked `saveExtractionReviewDraft` in `prototypes/studio/src/api.ts:312-325`. It queues writes per extraction and submits the previous acknowledgement's version, not the stale version supplied by the hook. `api.reviewDraft.test.ts:101` already tests two rapid saves and asserts versions 0 then 1. The reported same-version conflict does not follow from the production call path.

## Validation limits

Claude inspected existing evidence for 229 passing unit tests, successful typechecking, lint with the same two baseline warnings, and a passing controlled browser check; it did not execute those checks itself. Database-backed Playwright remains unexecuted because the Docker socket is unavailable. This review did not deploy changes or verify the deployed app.

## Unedited Claude review

**Verdict: PASS WITH NOTES.** No P1. Core behaviour matches the accepted intent and the server contract; four P3 defects/notes and one test-gap finding below. Read-only review: I used only Read/Grep/Glob, invoked no write tool and ran no commands, so the worktree is unchanged by me.

## Findings, severity ordered

**1. P3, qualified. "Draft saved" shown with zero decisions when the persisted draft is empty.** `useExtraction.ts:384` sets `draftSaved` from `reviewDraft.version > 0` alone. Server reset writes `reviewDraft: []` and bumps the version at `packages/extraction/src/postgres-reviews.ts:63-67`; an undo-all also persists an empty draft. Trigger: batch grid Revert on a reviewed member (`useBatchExtractionReviewGrid.ts:385`), then Open member; or reverse every decision and reload. Result line reads "N of N required decisions remaining · Draft saved" via `ResultsTab.tsx:719,726`, the UX-02 symptom again. The batch hook already guards with `dirtyCount > 0` at `useBatchExtractionReviewGrid.ts:521`. Fix: AND `recovered.touchedPaths.size > 0` at `:384`. Repro: hook test with `reviewDraft: { version: 3, decisions: [] }`, expect `draftSaved` false.

**2. P3, confirmed by trace. Hook `draftSaved` stays true after finalization.** `acceptResult` (`useExtraction.ts:510-539`) and the finalized load branch (`:344-354`) never clear it; `:672` exposes it beside `reviewedExtractionId`. Only `ResultsTab.tsx:725` hides it. Any new consumer would show "Draft saved" on a finalized review. Fix: add `!attempt?.reviewedAt` at `:672`. Test: after `accept()` resolves, expect `draftSaved` false.

**3. P3, qualified. Successful draft persistence is no longer announced.** Baseline announced "Draft saved" via `role="status"` (diff lines 512-516, 615). Now `ResultsTab.tsx:726` and `BatchExtractionReviewGrid.tsx:578` use `aria-live="off"`. Count announcements confirm the decision registered, failures use `role="alert"`, but the visible success status is silent for AT users, which WCAG 4.1.3 covers. The consultation proposed this; the coordinating note at consultation line 26 cautioned against removing live semantics to hit a region count. Smallest fix if the author agrees: `role="status"` on the inner "Draft saved" span only, keeping "Saving draft…" silent.

**4. P3, qualified. Read-only unreviewed denominator has a second source.** `ResultsTab.tsx:630-634` uses `state.evidenceLinks.length` for inspected/read-only attempts, while editable and finalized paths use the server list. `prepareReview` drops links whose anchor owns no occurrences (`packages/extraction/src/module.ts:47-58`), so the two can differ. Disproof: confirm `occurrenceOwnership` covers every published anchor; if so, add a comment and close. Otherwise accept the approximation explicitly.

**5. P3. Missing tests for changed code.** No test calls `pairing.pair`, so the new write accounting in `pairRecords` (`useExtraction.ts:599-621`: `writes`, `setDraftSaving`, scoped reload, `finally`) is unexecuted. No batch test covers recovery of a version>0 draft or the reset path for `draftSaved`. No test for finalize failure with `draftSaved` true, which renders "… · Review not saved · Draft saved" at `ResultsTab.tsx:722,726`; truthful but worth a deliberate assertion.

**6. Environmental, not a defect.** Database-backed Playwright blocked by missing Docker socket; log confirms. Added e2e assertions are traced below but unexecuted.

## Claim adjudication and verification

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Draft ack cannot leak or report early | Confirmed, with notes 1 and 2 | Scope identity checks `useExtraction.ts:559,562,611,616`; `writes` counter gates `draftSaving`; exposed value gated at `:672`. React schedules promise-originated renders as macrotasks, so `.finally` sees the current scope. Tests cover doc switch, failure, late ack. |
| Version-zero carried decisions never imply Draft saved | Confirmed | Server returns carried decisions only at version 0 (`module.ts:110`); hook requires version>0 (`:384`); hook test mocks exactly that. |
| Carried explicit Save preserved | Confirmed | Auto-finalize gate `carried === 0` unchanged `ResultsTab.tsx:552-556`; Save review `:761-764`; tests at diff 231-236 and the carried progress test. |
| Denominator matches authority | Confirmed for editable, finalized, batch; qualified read-only (finding 4) | Batch sums member decision lists over `grid.members`, not filtered `rows` (`BatchExtractionReviewGrid.tsx:505-508`). |
| Grounded-only, no backend change | Confirmed | `prepareReview` seeds one decision per Evidence link; diff touches no server file. |
| Bulk approval described via aria-describedby | Confirmed | `ResultsTab.tsx:750,793-800`; `BatchExtractionReviewGrid.tsx:656,674-676`; visibility conditions match the button's. |
| Batch loading/error honesty | Confirmed | `:669-673`; button disabled while loading or at zero `:656`. |
| New e2e assertions sensible | Confirmed by trace | Canonical: no draft exists before the strict `^N of N$` check; fixture yields 8 paths so limit 2 gives title+year grounded and 6 ungrounded; kei artifact keeps `outcome: 'SUCCEEDED', reviewable: true` with `complete: false` (`kei-artifact.ts:230-231,302`); later "Open latest reviewed" steps unaffected. Batch: one ready member with 4 decisions, failed member contributes none; SegmentedControl renders buttons. |

Evidence supplied and read: unit log 229/229 across 7 files; tsc log clean; lint current and baseline identical two warnings, line numbers shifted; browser-check.json pass. I executed nothing. Untracked artifacts: the evidence folder, fixtures, logs and screenshots are dated validation evidence; `main.tsx`/`server.cjs`/`check.cjs` import app source through absolute `/@fs/` paths and are outside every build and test tier. Consultation is intent. REV-11/12/13 rows match implemented behaviour. Removed strings have no stale references in src or e2e.

## What is right, and remaining risk

Right: one atomic status region per surface with one `role="status"`; "Decisions: N pending" chip gone; Retry on failed initial read instead of "0 of 0"; `pairRecords` now mirrors `updateReview` accounting and no longer reloads a different document after a late ack; batch bulk approval counted and filter-invariant; test fixtures updated consistently; no shared helper introduced for the two count expressions, which is correct here.

Unchanged pre-existing risk, outside this diff: two rapid decisions send both draft writes with the same `scope.version` (`useExtraction.ts:555-556`), and the server predicate at `postgres-reviews.ts:47-54` can 409 the second, surfacing the conflict alert. Disproof: hook test resolving two concurrent writes out of order.
