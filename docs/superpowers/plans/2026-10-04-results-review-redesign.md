# Results Review Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Results rail for a running and a settled Extraction: one header (status line, count block, chips), a list of records with flat value rows that can be decided on as soon as kei finishes a record, a "One by one" card over a queue across records, a document side whose marks select values both ways, and a review that saves only on a researcher's act.

**Architecture:** Five stacked PRs, each green on its own, in merge order a → e. (a) moves the server and the save trigger: a Review Draft is accepted on an Extraction with `outcome IS NULL`, validated against the pinned document and Schema Revision; the settled read reports `dropped`; `read()` returns the draft while RUNNING; `setDecision` answers `{ last }` and the auto-accept effect goes. (b) is the controller and data layer of review during a run, with no new UI: prepared decisions from the partial, `draftAvailable`, `decidedOn`, reconciliation at settlement, and the Part B copy and run-button rulings the spec replaces. (c) replaces the Results tab body with the rail (header, list, rows, expansion, decisions, undo, toast, Approve rest…, Run details drawer, ⋯ menu, PDF | Markdown) and deletes the shipped `PartialResults`. (d) adds One by one. (e) reworks the document side (marks as buttons, one Evidence colour, selection both ways, Markdown spans, `?value=`), narrow widths, the accessibility pass and DESIGN.md.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4 tokens, Vitest + Testing Library (`// @vitest-environment jsdom`), node:test via `tsx --test` (`packages/extraction`), prisma-next ORM, Playwright (`e2e/canonical-evidence-lifecycle.spec.ts`, kei stand-in).

**Spec:** `docs/superpowers/specs/2026-10-04-results-review-redesign-design.md` (all Resolved questions take their first option). ADR: `docs/adr/0016-review-drafts-on-a-running-extraction.md`. Prototype (behaviour and copy): `docs/superpowers/specs/2026-10-04-results-review-redesign/ReviewFlow.dc.html`. Base: `origin/dev` at `db6f8b92` (PR #168, Part B, merged) with the spec commit rebased on top. Worktree `.claude/worktrees/results-review`, branches `feat/results-review-redesign` (this plan) then `feat/results-review-{a-server,b-controller,c-rail,d-one-by-one,e-document}`, each on the previous.

## Global Constraints

- No new dependency; no `pnpm add`. Install with `pnpm install --prefer-offline --frozen-lockfile --ignore-scripts` then `DATABASE_URL=postgresql://contract:emit@127.0.0.1:5432/free pnpm db:generate`; never a bare `pnpm install`.
- No change to any workflow's step sequence; nothing behind `DBOS.patch()`. Every server change here is in an HTTP read or write path (`module.ts`, `postgres-reviews.ts`, `api/extractions.ts`); `settleExtraction` is untouched.
- Tokens and type from `DESIGN.md` / `index.css`: the rail's four sizes (`text-content`, `text-secondary`, `text-compact`, `text-overline`) plus `--text-display` (20px, added in c). No hex in components, no `text-[…px]`. Colour is never the only signal; hit targets ≥ 24px; hover-revealed controls also on `:focus-within`.
- `src/ui` primitives are used, not mirrored. Copy is verbatim from the spec and the prototype; "researcher", never "user"; never "JSON" in a label.
- A candidate is never shown as a value and never gets review controls. Only a value with an Evidence link in a readable record can be decided on.
- Lint: `react-refresh/only-export-components`; a `.tsx` exports its component only; pure helpers live in `.ts`.
- Every PR: `pnpm -C prototypes/studio typecheck`, `lint`, `test`; `pnpm -r typecheck`; for (a) also `pnpm -C packages/extraction test`. For c–e the relevant Playwright specs. Commits scoped (`git add <paths>`), on the PR's branch; never on `dev` or `main`; no PR opened until asked.
- Anchors are text, not line numbers: find the text named, then edit.

## Rulings taken while planning (drift between the spec and `db6f8b92`; each cites the spec text it resolves)

1. **Part B shipped (PR #168); "do not implement the replaced parts" becomes "remove them".** §5.5 replaces: `src/PartialResults.tsx` and its test (deleted in c, when the one list renders both phases); `partialHeadline`'s ` · started at page {n}` → ` · from page {n}` (b); the run button's appended ` · {badge.label}` (b; it lives in the `App.tsx` portal into `DocumentTabBar`'s slot, not in `DocumentTabBar`); DESIGN.md's Result Card Part B line (b rewrites the run-button clause; e replaces the line with §12's entry); the lifecycle e2e assertion that the Stop button contains "1 of 3" / "0 of 1" (b; the badge assertion stays). The SDD ledger's Ruling 7 (swap at settlement, focus may be lost) is replaced by §3.1/§5.3 (c). Ledger Rulings 1–6 stand. Ruling 8 (placeholder mapping: record `reading` → `reading`, `queued`/`checking`/`finished` without leaf → `queued`) is how §5.2's placeholder rows get their state. Ruling 10 (empty objects and arrays have no leaf): §3.2 rows are leaves, so an empty container gives no row; a record with no leaf at all shows "Nothing in this record for this filter." under All. Ruling 11 (inconsistent `checking`/`grounded` with null text) keeps its neutral copy "No value text supplied." in the row's value slot.
2. **`saveReviewDraft` branches on the attempt before `prepareReview`.** `prepareReview` returns no decisions until `outcome === 'SUCCEEDED' && reviewable`, so §5.4 cannot be a patch of today's check. `outcome === null` → the running rule (`runningDraftMatchesDocument`, pinned document from `loadExtractionInputs`, `occurrenceOwnership`); `reviewable` → today's rule unchanged; otherwise `invalid_review` "This Extraction cannot be reviewed." (a FAILED or CANCELLED row is refused at the module, never surfacing as the SQL's 409).
3. **The SQL predicate is two guarded updates, not an OR.** The ORM's object `where` has no OR in this codebase. `saveStoredReviewDraft` runs, in its transaction, `where({ id, reviewedAt: null, reviewable: true, reviewDraftVersion })` and, when that updates nothing, `where({ id, reviewedAt: null, outcome: null, reviewDraftVersion })`; one row updated or `review_conflict`. Today's `reviewedAt: null` predicate stays (the spec did not name it).
4. **"A result path under `records`" holds for Article.** The kei artifact's result envelope is always `{ records: [...] }` (`acceptKeiArtifact`, `refuseRecordCardinality`); a document-scope result is one root record. The running rule requires `resultPath[0] === 'records'` and an integer index at `[1]` for both strategies.
5. **The client strips `dropped` decisions before its first save after settlement.** The settled rule refuses any decision that is not prepared from the settled Evidence; a draft still holding a dropped decision would be refused with 422 forever. `recoverReviewDraft` (b) removes every decision whose `(resultPath, evidenceAnchorId)` is in `reviewDraft.dropped` from the decisions it restores, and marks those paths "changed after you reviewed it".
6. **A populated leaf without a link in a finished record is Not reviewable "No evidence", not a candidate.** `partialFromProgress` marks such a leaf `checking` whatever the record's state ("a finished value kei kept without a link"). Once `PartialRecord.state === 'finished'` kei has published the entry (write-once), so nothing is under verification: §5.1's "No evidence until settlement names its claim state" governs. In a record not yet finished, `checking` stays the candidate presentation.
7. **Controller names as they are.** `review.available` (not `reviewAvailable`), `review.isTouched(path)` (no `touchedPaths`), `updateReview` and `recoverReviewDraft` internal. The spec's `touchedPaths` is read as `isTouched`; `draftAvailable` and `decidedOn` are added beside `available`. `setDecision` (`setReviewDecision`, today `void`) returns `{ last: boolean }`: `last` is true when, after this decision, every anchored decision is touched.
8. **Draft save state is three fields today** (`draftSaving`, `draftSaved`, `draftError`; conflict is `draftError === REVIEW_DRAFT_CONFLICT`, a client string mapped from the server's `review_conflict`). §2.2's breakdown states are derived from them in `ResultsHeader`; no new enum.
9. **There is no client `prepareReview`.** b adds `draftDecisionsFromPartial(partial, occurrenceIdsByAnchor)` to `src/partialResult.ts`: per `evidenceLinks` entry of a finished record whose anchor is in the map, `{ resultPath, evidenceAnchorId, reviewedOccurrenceIds: every occurrence, action: 'APPROVED', reviewedValue: null }`. `PartialValue` carries no link; links are record-level, matched to a value by `resultPath.slice(2)` as `partialFromProgress` does.
10. **Symbols that live elsewhere.** `evidenceCheck` is private in `ResultsTab.tsx` → moves to `src/reviewVocabulary.ts` (c). There is no `linkedBy` export: it is `ClaimStatus.linkedBy`, and `linkOrigin(link)` in `claimStates.ts`. `getValueState`/`getContested` are `ResultValue` props, not exports. `evidencePages` is a `useMemo` in `RightRail.tsx`, passed as a prop. `anchorOccurrences` and `verifiedEvidenceBbox` are in `src/evidenceNavigation.ts`. `scrollOverlayIntoView` is private in `useEvidenceOverlays.ts`. `ExtractionDiagnostics` is a local function in `ResultsTab.tsx` (moves with the drawer). `ModalDialog` takes `ariaLabel`, not `aria-label`.
11. **`ReviewAttention.tsx` is not deleted.** `projectContexts/BatchExtractionReviewGrid.tsx` mounts it and the batch grid is out of scope. c removes it from `ResultsTab` only. `resultStats.ts` has no other consumer and is deleted. `ui/ResultValue.tsx` loses its last mount in c. Decided with the researcher on 2026-10-04: delete what is unused. The batch grid imports `CheckIcon`, `PencilIcon`, `XIcon`, `UndoIcon` and `StatusDot` from it (via `ui/index.ts`); those move to `ui/icons.tsx`, and the component, `RecordHeader`, `ValueState` and `src/ResultValue.test.tsx` are deleted. Its editor becomes `ui/ReviewedValueEditor.tsx` first (c3).
12. **"Run details" is a modal today** (`AttemptDetails`, a `ModalDialog` with `MethodUsed` and `ExtractionDiagnostics`). c replaces it with the non-modal drawer of §8.
13. **The document toolbar is inline JSX in `App.tsx`** (`section[aria-label="PDF document"]`), with no "Evidence marks" switch. c adds `DocumentViewSwitch` (PDF | Markdown) there; e adds the marks switch before it.
14. **Marks today** are `div`s with `pointer-events: none`, `aria-hidden`, four hardcoded rgba per-field colours and a `#d97706` focus border. e makes them buttons with one Evidence style from tokens (classes in `pdf-viewer.css` using `var(--color-…)`).
15. **`?value=` goes through `projectNavigation.ts`** (`Route` document variant, `parseRoute`, `href`), not `studioUrl.ts`, which only handles the base path.
16. **`Button` variants today are `positive | danger | secondary | pill`.** c adds `outline-positive`, `outline-danger`, `ghost`. `Overline` hardcodes `text-[10.5px]`; c switches it to `text-overline`.
17. **The count word while a run reads is "to check so far"** (prototype `toCheckWord`), "to check" after settlement. The spec's §2.2 names only "to check"; the prototype is the source of truth for copy and the spec's number is explicitly "the read records so far". *Flagged for the researcher.*
18. **`useToast` takes a `string` message.** The rail toast is a second `useToast()` instance owned by `ResultsTab`, rendered with `Toast` docked in the rail (§2.5).
19. **Saving stays researcher-triggered from (a) on.** Removing the effect in (a) without a trigger would ship "reviews never save": (a) wires `last` → `accept()` into today's ResultsTab decision handlers and "Approve remaining" calls `approveAll()` then `accept()`. The e2e's "saves automatically" description on Approve remaining (lifecycle spec) holds until c replaces the control.
20. **The Results tab's key holds across settlement.** `RightRail` keys `ResultsTab` on `inspection.attempt?.extractionId`; `inspectedAttempt` is `pinnedAttempt ?? extraction.attempt`, set from the run's first read, so settlement keeps the key and §3.1's "settlement moves nothing" needs no re-keying. The one remount is `'none'` → id when the first read arrives, before any record exists.
21. **The server draft is adopted once per attempt while it runs.** `read()` returns `reviewDraft` on every two-second poll (a4); overwriting local decisions with it would revert a decision made between a poll's request and its reply. The controller adopts it on mount and on reconnect; afterwards local state owns the decisions and a poll only adds prepared decisions for newly finished records.
22. **Test tiers this machine cannot run.** No Docker: PostgreSQL integration tests (`pnpm test:postgres`) and Playwright (compose with mock OIDC and Postgres 17) are written and listed, but run only on a Docker host. Coverage that must be verified here sits in `packages/extraction/src/module.test.ts` (mocked persistence), `review-rules.test.ts` and `prototypes/studio/api/extractions.test.ts`.

## File structure

| PR | New | Edited | Deleted |
|---|---|---|---|
| a | — | `packages/extraction/src/{module,postgres-reviews,review-rules,types}.ts` and tests; `prototypes/studio/shared/extraction.contract.ts`; `prototypes/studio/api/extractions.ts` (+test); `src/useExtraction.ts` (+test); `src/ResultsTab.tsx` (+test) | — |
| b | `src/reviewReconcile.ts` (+test) | `src/partialResult.ts` (+test); `src/useExtraction.ts` (+test); `src/reviewDrafts.ts` (+test); `src/App.tsx`; `e2e/canonical-evidence-lifecycle.spec.ts`; `DESIGN.md` | — |
| c | `src/ResultsHeader.tsx`, `src/ReviewList.tsx`, `src/ReviewRow.tsx`, `src/RunDetailsDrawer.tsx`, `src/ResultsMenu.tsx`, `src/DocumentViewSwitch.tsx`, `src/reviewVocabulary.ts`, `src/reviewHistory.ts`, `src/evidenceQuote.ts`, `src/ui/ReviewedValueEditor.tsx` (+tests) | `src/ResultsTab.tsx`, `src/ui/index.ts`, `src/ui/Button.tsx`, `src/ui/Overline.tsx`, `src/index.css`, `src/App.tsx`, `src/RightRail.tsx`, `src/DocumentTabBar.tsx`, `src/resultsBadge.ts` (+tests); e2e lifecycle spec | `src/PartialResults.tsx` (+test), `src/resultStats.ts` (+test), `src/ui/ResultValue.tsx` (+`src/ResultValue.test.tsx`; icons and `StatusDot` → new `src/ui/icons.tsx`) |
| d | `src/reviewQueue.ts`, `src/ReviewFocus.tsx`, `src/useReviewKeys.ts` (+tests) | `src/ResultsTab.tsx`, `src/useEvidenceOverlays.ts` (dimming), e2e lifecycle spec | — |
| e | `src/MarkPopover.tsx` (+test) | `src/useEvidenceOverlays.ts`, `src/pdf-viewer.css`, `src/App.tsx`, `src/projectNavigation.ts`, `src/ResultsMenu.tsx`, `src/ReviewList.tsx`, `src/ReviewFocus.tsx`, `DESIGN.md` (+tests) | — |

---

## PR a — server and contract: drafts on a running Extraction; saving is an act (§5.4, §6, ADR 0016)

Branch `feat/results-review-a-server` on `feat/results-review-redesign`.

### Task a1: `runningDraftMatchesDocument` (§5.4)

**Files:** Modify `packages/extraction/src/review-rules.ts` (beside `reviewDecisionMatchesSchema`). Test `packages/extraction/src/review-rules.test.ts`.

**Interfaces:** Produces

```ts
/** A draft decision made while the Extraction runs (ADR 0016): checked against the pinned document and Schema Revision
 * only, never kei's progress. An anchored decision under `records.<index>`, naming every occurrence of its anchor. */
export function runningDraftMatchesDocument(owned: ReviewAuthority['occurrenceIdsByAnchor'],
  nodes: readonly ExtractionSchemaNode[], decision: ReviewDecisionInput): boolean {
  return decision.evidenceAnchorId !== null && decision.resultPath[0] === 'records' && Number.isSafeInteger(decision.resultPath[1])
    && reviewsAnchor(owned, decision.evidenceAnchorId, decision.reviewedOccurrenceIds)
    && reviewDecisionMatchesSchema(nodes, decision) && correctionEvidenceIsPublished(owned, decision)
}
```

- [ ] **Step 1: failing tests**: accepts an APPROVED decision on a known anchor with all its occurrences; refuses a null anchor (an optional decision), an anchor absent from the document, a subset of occurrences, a path not under `records`, a non-integer index, an EDITED value the schema refuses.
- [ ] **Step 2:** run `pnpm -C packages/extraction exec tsx --test src/review-rules.test.ts` → FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit.

### Task a2: `saveReviewDraft` on a running Extraction; the save predicate (§5.4; Rulings 2, 3)

**Files:** Modify `packages/extraction/src/module.ts` (`saveReviewDraft`), `postgres-reviews.ts` (`saveStoredReviewDraft`). Test `module.test.ts` (mocked persistence, runs here), `postgres-reviews.integration.test.ts` (PostgreSQL).

- [ ] **Step 1: failing tests** in `module.test.ts`: on `outcome: null` a draft of a known anchor saves without calling `prepareReview`'s Evidence; refused with `invalid_review` "Draft decisions do not match the pinned document and schema." for an unknown anchor, an optional decision, a duplicate path, a negative or unsafe version; on `outcome: 'FAILED'` refused `invalid_review` "This Extraction cannot be reviewed."; on a settled reviewable row today's rule unchanged (existing tests stay green); finalization with a decision the read reports as `dropped` is refused as today (finalization unchanged). In the integration test: a draft saves while `outcome IS NULL`; its version continues across a `settleExtraction` call; a FAILED row is refused; a finalized row conflicts.
- [ ] **Step 2:** `saveReviewDraft` reads the extraction first (`persistence.readExtraction`); `reviewedAt` → `review_conflict` as today; `outcome === null` → `loadExtractionInputs`, `occurrenceOwnership(decodePinnedDocument(inputs.parsedDocument))`, `parsePinnedSchema`, then the version/duplicate checks and `runningDraftMatchesDocument` over every decision; `reviewable` → today's body; else `invalid_review`.
- [ ] **Step 3:** `saveStoredReviewDraft`: the two guarded `updateAll`s of Ruling 3 in its transaction.
- [ ] **Step 4:** `pnpm -C packages/extraction test` PASS (integration tests skip without a database; run `pnpm -C packages/extraction test:postgres` on a Docker host). Commit.

### Task a3: `readReviewDraft` reports `dropped`; the contract (§5.3, §5.4)

**Files:** Modify `packages/extraction/src/module.ts` (`readReviewDraft`), `types.ts` (`ReviewDraft.dropped`), `prototypes/studio/shared/extraction.contract.ts` (`extractionReadResponseSchema.reviewDraft`). Tests `module.test.ts`, `prototypes/studio/shared` contract test if one covers the read response.

**Interfaces:** `ReviewDraft` gains `dropped?: readonly { resultPath: ResultPath; evidenceAnchorId: string | null }[]`. Contract:

```ts
dropped: z.array(z.object({ resultPath: resultPathSchema, evidenceAnchorId: z.string().min(1).nullable() }).strict()).optional(),
```

- [ ] **Step 1: failing tests**: on a settled, not finalized Extraction, a stored decision whose `(resultPath, evidenceAnchorId)` matches a settled Evidence link is in `decisions`; an optional decision stays in `decisions` as today; any other is in `dropped` and not in `decisions`. A finalized one: unchanged (`decisions: []`). A running one: the stored draft, no `attention`, no `dropped`.
- [ ] **Step 2:** implement in `readReviewDraft` after the existing `result`/`evidence` guard; nothing is rewritten. **Step 3:** PASS; commit.

### Task a4: `read()` returns the draft while RUNNING (§5.4)

**Files:** Modify `prototypes/studio/api/extractions.ts` (`read`). Test `api/extractions.test.ts` (the test that asserts `readReviewDraft` is not called while RUNNING changes to: called while RUNNING, not while FAILED; `pendingReviewDecisions` stays null until COMPLETED).

- [ ] Step 1 failing test → Step 2 `reviewDraft: COMPLETED || RUNNING ? await module.readReviewDraft(id) : undefined` → Step 3 PASS → commit.

### Task a5: `setDecision` answers `{ last }`; the auto-accept effect goes (§6; Rulings 7, 19)

**Files:** Modify `prototypes/studio/src/useExtraction.ts` (`setReviewDecision`, `approveAllRemaining`), `src/ResultsTab.tsx` (the effect beginning `if (!readOnly && !inspectedAttempt && editingPaths.size === 0 &&`; the `review` callbacks handed to `ResultValue`; the "Approve remaining" button). Tests `useExtraction.test.tsx`, `ResultsTab.test.tsx`.

Today's "Save review" button renders only when no decision is anchored or after an error; a5 widens it to `canAccept` (every anchored decision touched, not saved), so a recovered complete draft can still be saved once the effect is gone.

- [ ] **Step 1: failing tests**: `setDecision` returns `{ last: true }` exactly for the decision that touches the last anchored decision, `{ last: false }` otherwise and when it is a no-op; a recovered complete draft on mount does not call `finalizeExtractionReview`; settlement does not either; deciding the last value does; "Approve remaining" saves.
- [ ] **Step 2:** implement; ResultsTab calls `void review.accept()` when `last && canAccept`; Approve remaining calls `approveAll()` then `accept()` (after the state update: `accept` reads touched decisions from the controller's ref, so check that it sees them; if not, `approveAll` returns the touched set and `accept` takes it).
- [ ] **Step 3:** typecheck, lint, studio tests PASS; commit.

**PR a gate:** `pnpm -r typecheck`; `pnpm -C packages/extraction test`; studio `typecheck`, `lint`, `test`. Unrun here: `test:postgres`, e2e (Ruling 22).

---

## PR b — controller and data: review during a run, reconciliation, Part B copy (§5.1–5.3, §2.4; Rulings 1, 5, 6, 9)

Branch `feat/results-review-b-controller` on a. No new UI: the shipped `PartialResults` stays as the running body until c; everything here is tested through the hook and pure helpers.

### Task b1: prepared decisions from the partial (§5.1; Ruling 9)

**Files:** `src/partialResult.ts` (+test). Produces `draftDecisionsFromPartial(partial: PartialResult, occurrenceIdsByAnchor: ReadonlyMap<string, readonly string[]>): ReviewDecisionInput[]` and `readableRecords(partial)` (`state === 'finished'`).

- [ ] Tests: only finished records; one decision per link whose anchor is in the map, with every occurrence; a link whose anchor is missing gives none; a `queued`/`reading`/`checking` record gives none. Implement; PASS; commit.

### Task b2: `occurrenceIdsByAnchor`, `draftAvailable`, decisions during a run (§5.1)

**Files:** `src/useExtraction.ts` (+test), `src/App.tsx`.

**Interfaces:** option `occurrenceIdsByAnchor?: ReadonlyMap<string, readonly string[]> | null` (App derives it from `parsedDocument` with `anchorOccurrences`, memoised); `review.draftAvailable: boolean` (attempt RUNNING on the current Source Representation and at least one readable record); during a run `review.decisions` = prepared decisions from the partial overlaid with the read response's `reviewDraft.decisions`, `isTouched` = the draft's paths; `canAccept` false while running; `setDecision` allowed when `available || draftAvailable`; draft saves go through today's `updateReview` path (`rememberReviewDraft`, version, conflict).

- [ ] Tests: decisions appear as records finish across polls; a draft returned by the RUNNING read is overlaid; a decision during the run saves a draft (API mock asserts body) and `canAccept` stays false; a refused draft (422 `invalid_review`) reverts the decision to untouched and surfaces the message for the toast "This value can’t be reviewed: its Evidence is not in this document."; a decision made between two polls survives the second poll (Ruling 21); a cancelled/failed attempt drops the decisions and reports the count discarded. Implement; PASS; commit.

### Task b3: `decidedOn` and reconciliation at settlement (§5.3; Ruling 5)

**Files:** `src/reviewReconcile.ts` (+test), `src/reviewDrafts.ts` (+test), `src/useExtraction.ts` (+test).

**Interfaces:** `reconcileAtSettlement({ draft, decidedOn, settled, dropped }) → { kept: number; changed: ResultPathKey[] }` (kept: same path, same anchor in the settled links and the settled value equals `decidedOn`; else changed); `review.decidedOn: ReadonlyMap<string, unknown>`; `review.changedAfterReview: ReadonlySet<string>`; `review.settlement: { kept: number; changed: number } | null` (set once at the terminal read, for c's toast). `recoverReviewDraft` removes `dropped` from the restored decisions and returns them as changed.

- [ ] Tests (spec Testing): kept by path and anchor; a value change in session; a dropped record; the toast counts; the first draft save after settlement carries no dropped decision. Implement; PASS; commit.

### Task b4: Part B's replaced copy and the run button (§2.4, §5.5; Ruling 1)

**Files:** `src/partialResult.ts` (`partialHeadline` ` · from page {n}`), `src/App.tsx` (the run button: drop ` · {badge.label}`; add `min-w-43` (172px on the 4px grid) and `tabular-nums`), `DESIGN.md` (the Result Card line's "started at page p" and "the badge and run button read" clauses), `e2e/canonical-evidence-lifecycle.spec.ts` (the Stop button's "1 of 3"/"0 of 1" assertions removed; the badge's kept), tests beside.

- [ ] Tests updated first; implement; PASS; commit.

**PR b gate:** studio `typecheck`, `lint`, `test`; `pnpm -r typecheck`. Unrun here: e2e.

---

## PR c — the rail (§1–3, §2.5, §5.2–5.3 in the list, §6, §7.4, §8, §11, §12 tokens)

Branch `feat/results-review-c-rail` on b. The largest PR: splitting header, list and drawer leaves the Results tab half old, half new.

### Task c1: tokens and primitives (§12)

`index.css` `--text-display: 20px` (`--text-display--line-height: 1.25`); `Button` variants `outline-positive`, `outline-danger`, `ghost` (+`Button.test`); `Overline` → `text-overline`. Tests first for the variants.

### Task c2: `reviewVocabulary.ts` (§1)

Pure: per value `{ kind: 'to-check' | 'approved' | 'edited' | 'rejected' | 'not-reviewable' | 'missing' | 'contested' | 'reading' | 'checking' | 'queued'; glyph; srLabel; chip: { text, style: 'link' | 'rule' | 'doubtful' | 'neutral' }; evidence: { label, detail } | null; doubt: string | null }` from the claim status (`claimStatuses`, `describeClaimStatus`, `linkOrigin`), the link (`evidenceCheck` moved here), `diagnostics.contested`, the partial value state and record state (Rulings 6, 8, 11), the decision and `evidencePages`. Also the leaf rows of a record (relative path joined " › ", 1-based indexes) in schema order, and document-level fields (`valueSource: 'document'`, "document" chip, "Read once for the whole document; not verified."). Tests: every row of §1's tables, verbatim.

### Task c3: `evidenceQuote.ts` (§7.1) and `ui/ReviewedValueEditor.tsx` (§3.5)

Quote: block text per anchor kind (list items joined, cell with row cells joined " · "), first case-insensitive occurrence of `grounding.raw` else the value, clipped to the two lines around the mark when longer than four, none for `input` precision. Editor: extracted from `ResultValue`'s `PrimitiveRow` edit branch (select for `allowedValues`/booleans, date, number with step 1 for integers, text; arrays as comma text); "Enter a value." for empty. Tests first.

### Task c4: `reviewHistory.ts` (§3.4)

`push({ pathKey, before: { action, reviewedValue, touched } })`, `pop()`, undo of an undo. Tests first.

### Task c5: `ResultsHeader.tsx` (§2.1–2.3)

Status line for every state of §2.1 (incl. stopping, cancelled, failed with "Show details", not-all-of-it with "Why?", saved, historical with `headerExtras`, previous schema note); transient alert line (monitor error + "Reconnect", cancellation failure); count block (display number, "to check so far"/"to check" per Ruling 17, review bar `role="img"` label, "One by one" / "Approve rest…" / "Save review" with their disabled titles, the breakdown line states of §2.2 from Ruling 8); chips `role="group" aria-label="Show values"` with counts over readable records. Tests: header copy for every §2.1 state; chips' counts grow with reads; filter kept across settlement.

### Task c6: `ReviewList.tsx`, `ReviewRow.tsx` (§3.1–3.3, §5.2, §5.3)

One list for both phases, React key = record index; order of the partial while open, source order on a fresh mount; "Finding the records in the source…" before discovery; record header `button[aria-expanded]` with its right-hand state; open-by-default rules with the researcher's toggles remembered in a session `Map`; Document section; Article flat; empty Catalog; "Nothing in this record for this filter."; rows on the three-column grid with placeholder/checking rows of the same height; the 200ms entry fade (none under `prefers-reduced-motion`); pinned "outside the current filter"; "changed after you reviewed it" (stale ink). Selected-row expansion, items 1–8 of §3.3, incl. the last-value warning and "… and save review" labels (never during a run), joined decision group, "Review from here" (disabled until d; rendered in d), the editor. Tests: expansion parts, last-value warning and labels, Not reviewable detail, a finished record's unlinked value as "No evidence", settlement keeps filter/selection/open records (same DOM node for the selected row).

### Task c7: decisions, undo, rail toast, live region, Approve rest…, Save review (§2.5, §3.4, §3.6, §5.2–5.3, §6, §10)

In `ResultsTab`: `setDecision` → history push → toast "{Word} {name}." with "Undo ⌨Z" → focus back to the row (undo: restored row, selected); `accept()` on `last && canAccept`; Approve rest… `ModalDialog` (`ariaLabel="Approve the rest and save the review"`) with the scope copy variants and the edit guard; "Save review" toast; settlement toast and live message (Ruling: from `review.settlement`); run stopped toast "Run stopped · your {d} decisions on it are discarded"; App's completion toast only when the rail is not open on Results. Tests: Approve rest… scope copy and edit guard; Save review at count 0 (incl. empty Catalog, no linked values); no auto-save at settlement; the live region's messages.

### Task c8: `RunDetailsDrawer.tsx`, `ResultsMenu.tsx`, `DocumentViewSwitch.tsx` (§8, §7.4; Rulings 12, 13)

Drawer (non-modal `role="dialog"`, focus to heading, return to opener, Escape) with Extraction (`CatalogReview`/`RecipeReview` moved unchanged), Schema (used-schema preview), Evidence (the old Completion lines' numbers and the "Checks not completed" list), Review, Method (`MethodUsed`, `ExtractionDiagnostics`). Menu `role="menu"`: Export… (hidden once saved; Export `Button` in the status line then), Values as code (body swaps to the `<pre>` with "Back to review"), "Edit field {name} in the schema…" (disabled "Select a value first"); "Copy link…" arrives in e. `DocumentViewSwitch` in App's toolbar; Markdown view in the document pane (page-shaped `<pre>`, unavailable copy); the Results tab's Markdown panel and its Review | Values as code | Markdown tabs go.

### Task c9: compose `ResultsTab`; ring and badge; deletions

`ResultsTab` composes header, list (or code view), toast, drawer, live region; removes the summary chips, Completion lines, breadcrumb navigation (`navPath`, back/forward stacks; `onResultPathChange` reports `['records']` — every link paints, as the partial does), result-view tabs, Markdown panel, `ReviewAttention` mount, `AttemptDetails`. `DocumentTabBar` tab ring (18px, `aria-label` per §2.4); `resultsBadgeFor` unchanged except nothing once saved (already). Delete `PartialResults.tsx`(+test), `resultStats.ts`(+test), `ui/ResultValue.tsx`(+test) after moving its icons and `StatusDot` to `ui/icons.tsx` (Ruling 11); grep for consumers again before deleting. Rewrite the `ResultsTab.test.tsx` cases that assert removed UI; `RightRail.test`, `App.test` updates.

### Task c10: e2e

Lifecycle spec: replace the Approve remaining / review-progress / Values as code / Markdown steps with the new controls; add the spec's Testing scenario up to "the decided row keeps Approved" and "Approve rest… saves; Review saved; reload: read-only" (One by one steps arrive in d).

**PR c gate:** studio `typecheck`, `lint`, `test`; `pnpm -r typecheck`; Playwright `canonical-evidence-lifecycle`, `critical-flows`, `unified-catalog` (Docker host). Visual check against the prototype at 1280×720, 344px and 264px.

---

## PR d — One by one (§4, §7.3)

Branch `feat/results-review-d-one-by-one` on c.

- **d1 `reviewQueue.ts`** (tests first, spec Testing): every To check value of readable records keyed by `resultPathKey`, record order, doubtful first then schema order; `next` wraps within the record then the next record with an undecided item; `previous` within the record, decided or not; skip postpones; a record read during a run appends; settlement adds what changed.
- **d2 `useReviewKeys.ts`** (tests first): keydown on the rail; A E R J K Z Enter Escape per §4.4; ignored on `repeat`, with a modifier, while typing (except Enter with an open edit, Escape); only Escape while nothing is readable; Escape order: edit → dialog → drawer → menu → leave one-by-one; ignored while saving.
- **d3 `ReviewFocus.tsx`**: the card of §4.3 (queue line `ol` with 24px squares, breadcrumb, `h2[tabindex=-1]` value at `text-display`, figure/blockquote, doubtful box, last-value warning, 44px actions with `kbd` badges `aria-hidden`, decided bar, Previous / Skip, Up next); end cards of §4.5 (Record checked, Caught up, Review saved); focus to the heading after every step; live messages. Entering/leaving per §4.1 (filter, chips, scroll restored; focus on the row). "Review from here" and the settlement toast's "Review one by one" enter it.
- **d4 dimming** in `useEvidenceOverlays`: current value with `cell`/`segment` precision and a bbox → four `--color-canvas` rectangles at 45% around the bbox + 24pt on its page, no pointer hits; removed on leaving; unaffected by the marks switch.
- **d5 e2e**: One by one; A, J, Z.

**PR d gate:** as c, plus `ReviewFocus`/`useReviewKeys`/`reviewQueue` tests; Playwright lifecycle.

---

## PR e — the document side, narrow widths, accessibility, DESIGN.md (§7, §9, §10, §12)

Branch `feat/results-review-e-document` on d.

- **e1 marks** (`useEvidenceOverlays`, `pdf-viewer.css`; Ruling 14): every link of the inspected attempt or of finished partial records; `button` marks, `pointer-events: auto`, `aria-label="{name}: {value}[, {word}]"`, `aria-current`; one Evidence style (ghost fill, 2px ev bottom border; dotted rule, dashed doubtful; decided 1px no fill; selected ev-soft + 2px accent outline); "Evidence marks" switch (`aria-pressed`) in the toolbar; rail selection scrolls once, mark selection never, partial links never; focus survives a poll of the same Extraction. Tests: accessible names, no scroll on a partial link, one style.
- **e2 selection both ways + popover** (`MarkPopover.tsx`, `role="dialog" aria-label="Values in this passage"`): a mark selects its row (opens its record, scrolls the rail) or, in one-by-one, makes it current; shared anchors open the popover. Tests.
- **e3 Markdown marks**: spans at the anchor's `markdown_span` in the Markdown view, same styles, selection both ways.
- **e4 `?value=`** (Ruling 15): `Route` gains `value?`, `parseRoute`/`href` round-trip; the menu's "Copy link to the selected value" (toast "Could not copy the link" on failure); a URL selects that value once the attempt loads.
- **e5 narrow widths** (§9): container queries on the rail: 344px status line drops "Catalog ·" and the schema link, count actions wrap under the bar full width, chips scroll horizontally; 264px chips → labelled `<select>` "Show", actions on their own lines, expansion indent, queue squares wrap, Up next truncation. Tests for both layouts.
- **e6 accessibility pass** (§10): tab/tabpanel, row `aria-controls`, one polite atomic live region, targets, motion. `ui/a11y` checks in the lifecycle spec's accessibility helper.
- **e7 DESIGN.md** (§12): `--text-display` in §3; Button variants in §5; the "Results rail" entry replacing the Result Card's streaming line. CONTEXT.md's glossary changes stay proposals (spec: "not edited here").

**PR e gate:** as c; Playwright lifecycle and `authentication-accessibility`; the visual check at 1280×720, 344px and 264px: a streamed run, review while it reads, settlement with no layout drift, One by one, the last-decision save.

## Self-review

- Spec coverage: §1 c2; §2 c5/c9; §3 c6/c7; §4 d; §5.1–5.3 b/c6/c7; §5.4 a; §5.5 Ruling 1, b4, c9; §6 a5/c7; §7.1 c3; §7.2 e1–e2; §7.3 d4; §7.4 c8/e3; §8 c8/e4; §9 e5; §10 e6; §11 copy throughout; §12 c1/e7; Error handling b2/c7/e4; Testing per task.
- Not implemented: CONTEXT.md glossary edits (spec says proposed only); out-of-scope list unchanged.
- Open for the researcher: Ruling 17 (count word during a run). Docker is available (2026-10-04).
