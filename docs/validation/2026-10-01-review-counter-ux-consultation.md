# Review-counter UX consultation — 2026-10-01

Status: consultation completed; recommendation recorded, no application changes made and no tests executed for this consultation.

Implementation outcome: the later [local counter fix and verification record](2026-10-01-review-counter-fix.md) applies the adopted scope without changing review authority. The remote deployment remains unverified after that change.

Requested consultant: Claude Code Fable 5.1, max effort. The successful CLI invocation used `--model claude-fable-5-1 --effort max`; response metadata confirms canonical model `claude-fable-5-1`, a successful result, and no permission denials. Claude was restricted to Read, Grep and Glob tools. This is a dated review record, not an adopted product contract.

Observed issue and screenshot: [UX-02 exploratory finding](2026-10-01-studio-exploratory-browser.md#ux-02-review-counters-use-conflicting-looking-meanings-of-pending), [counter reproduction](2026-10-01-studio-exploratory-evidence/11-review-counter-reproduction.png).

## Recommended direction

- Remove the generic Decisions chip and show one required-review progress line, such as **22 of 22 required decisions remaining**. Use the same required-remaining count for the bulk approval action.
- Explain optional work separately: **24 ungrounded values are optional. They stay recorded without Evidence and are not counted above.**
- Count an explicit approval, edit or rejection as a decision made. Count remaining decisions independently of their verdict. Distinguish sample-carried decisions and preserve their explicit-save requirement.
- Derive **Saving draft / Draft saved / Draft not saved** from the draft writer's actual state; show **Review saved** only after finalization succeeds.
- Give bulk approval an accessible, visible description of its scope and its automatic-finalization consequence. Preserve existing decisions and the deployed policy for optional values.
- Share count definitions across Results, review-attention navigation and batch review; keep them stable when navigating or filtering results. Test partial review, restored drafts, optional values, carried decisions and errors.

## Review of the consultation

The local source proves that the current pending label uses the total decision-list length, including acted-on entries, whereas the approval button uses untouched count. The deployed screenshot additionally shows required/optional semantics absent from this local source. Confirm the deployed revision before implementing: required-only approval and save eligibility are policy changes if applied to a different decision model, not merely copy edits.

Claude's deployed explanation, and its hypothesis for why Draft saved appears, are inferences. The recorded browser pass did not inspect finalization behavior or prove that backend counts are correct, and a pre-existing draft remains a plausible explanation. Do not turn these hypotheses into confirmed defects. A read of a draft's version is useful only after verifying the deployed versioning contract; it cannot establish a cause by itself.

The recommendation to use plain N-of-M text is a design choice. A determinate progress bar can represent manual task completion; its ARIA role does not inherently require an automatically running task. Avoid adding a bar unless it improves comprehension. Likewise, whether a notice needs a live announcement depends on when and how it appears: static notices can remain readable text, while asynchronous significant changes may require an announcement. Do not remove all live semantics solely to achieve a fixed live-region count.

The supplied tests are proposed acceptance checks, not verified test results. Reconcile any suggested helper/interface changes with this repository's existing contracts and fixtures before implementation. The consultation's proposed details are preserved below for review.

## UX references checked by the coordinating agent

[Nielsen Norman Group usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) support clear system status, consistent terminology, and focused information hierarchy. [W3C WCAG 4.1.3 guidance](https://www.w3.org/WAI/WCAG21/Understanding/status-messages) explains programmatically exposing status changes without moving focus and cautions against overly chatty announcements. These principles support a concise review status with accessible updates and separate persistence feedback; they do not mandate this particular layout or a ban on progress bars.

## Full Claude response

The response below is reproduced verbatim. Its confidence statements and proposed policy changes should be read with the review notes above.

Consultation complete. Everything below is read from the worktree at `54c22483` plus uncommitted changes; nothing was modified or run.

## 1. Root cause

**Local, source-proven.** The badge and the action count different sets but use near-synonyms with no scope.

- `prototypes/studio/src/ResultsTab.tsx:701-708` renders `Decisions: ${visibleReviewDecisions.length} pending`. That is the length of the prepared decision list (`:526-527`), which includes every entry the researcher has already acted on. It never decrements.
- `prototypes/studio/src/ResultsTab.tsx:734` renders `Approve remaining (${untouchedCount})`, which is the untouched subset (`useExtraction.ts:632-634`).
- So even locally, with 22 grounded values and 10 decided, the screen says "22 pending" beside "Approve remaining (12)". `reviewedCount` (`useExtraction.ts:631`) is also misnamed: it is the total, not the reviewed count, and "Draft saved" is inferred from `untouchedCount < reviewedCount` (`ResultsTab.tsx:809`), not from draft persistence state.
- Locally there is no required/optional split at all: `prepareReview` seeds one decision per Evidence link only (`packages/extraction/src/module.ts:38-60`), finalization requires exactly that set (`review-rules.ts:72-86, 246-259`), `evidenceAnchorId` is non-nullable (`shared/extraction.contract.ts:111`), and the base spec says no decision is offered for an ungrounded value (`openspec/specs/canonical-evidence-lifecycle/spec.md:127-132`). Task 3.1 that adds optional ungrounded decisions is unchecked (`openspec/changes/sample-extraction-workbench/tasks.md:29`).
- Auto-finalize: when every decision is touched and nothing is carried, an effect calls `accept()` (`ResultsTab.tsx:551-555`). So "Approve remaining (22)" is not a draft action: it finalizes the review (e2e confirms, `e2e/canonical-evidence-lifecycle.spec.ts:401-402`). The tooltip at `:731` does not say so. With carried decisions, finalization needs the explicit "Save review" button (`:747-750`), per the delta spec (`openspec/changes/sample-extraction-workbench/specs/canonical-evidence-lifecycle/spec.md:48-58`).
- `approveAllRemaining` touches every decision path (`useExtraction.ts:606-610`); `canAccept` requires every path touched (`:313-321`). Both are "all entries", not "required entries", because locally all entries are required.

**Deployed, inferred (not in any local checkout).** The strings "required decisions remaining", "Review all grounded fields to save automatically" and "They remain optional…" exist nowhere under `/home/gebbaro/Progetti` in source; only in the validation docs and the interaction log. The deployed build therefore widens the decision list to grounded plus ungrounded entries (46 = 22 + 24, matching "Fields: 46") while the action counts required untouched only (22). The chip inherited the local entries-count bug, now amplified by optional entries. The backend is not miscounting: 46 entries exist and 22 required ones remain. The UI labels two sets with "pending" versus "remaining" and no units.

**"Draft saved" with no action, hypothesis.** If the deployed build kept the local formula at `:809` with `reviewedCount = 46` entries and `untouchedCount = 22` required-untouched, then `22 < 46` is true at load and "Draft saved" shows without any write. A pre-existing server draft is the other explanation. A read-only check settles it: `GET /api/extractions/{id}` and look at `reviewDraft.version` (0 means nothing was ever saved).

**Unknowns.** Deployed build commit is unverified (the exploratory doc says so at `docs/validation/2026-10-01-studio-exploratory-browser.md:30,95`); the donor `origin/workflow` branch and an unfetched integration branch are the candidates. I could not inspect git objects without a shell.

## 2–3. Recommended design, copy, and count model

**Principle.** One authoritative required-progress line, placed directly above the action it governs. Result facts stay as static chips. Optional work gets its own non-counted sentence. Draft persistence, finalization and decision progress are three different facts and never share a numerator.

**Compact layout for the 22/24 example (initial state):**

```
[Strategy: article] [Fields: 46] [Missing: 0] [Grounded: 22] [Ungrounded: 24] [To check: 3]

22 of 22 required decisions remaining                               ← the only role="status" here
24 ungrounded values are optional. They stay recorded without Evidence and are not counted above.
[Export]  [Approve remaining (22)]  [Run Article extraction]
```

Remove the `Decisions:` chip entirely (both "N pending" and "N saved"); its information moves into the status line. If the deployed attention header stays, it keeps only presence/grounding facts (grounded, ungrounded, missing) per the plan's two orthogonal axes (`docs/plans/2026-09-30-workbench-workflow-integration.md:152-159`), and the required count lives only in the status line.

**Copy matrix** (status line unless noted; `R` = required remaining, `T` = required total):

| State | Copy |
| --- | --- |
| Loading | `Loading Review Decisions…` (keep one instance; drop the duplicate at `ResultsTab.tsx:905`) |
| Initial | `22 of 22 required decisions remaining` |
| Partial, draft persisted | `9 of 22 required decisions remaining · Draft saved` |
| Partial, draft write in flight | `9 of 22 required decisions remaining · Saving draft…` (non-live suffix) |
| Draft error / conflict | status line keeps the counts; existing `role="alert"` block at `:779-784` reports the failure |
| Required complete, carried present | `0 of 22 required decisions remaining · 12 carried from sample` + primary `Save review` + hint `Carried decisions need your explicit save.` |
| Carried with changed values | `3 of 22 required decisions remaining · 19 carried from sample · 3 changed since sample` |
| Saving final review | `Saving review…` |
| Finalize error | `Review not saved` + `Retry` (existing), counts still visible |
| Finalized (own or history) | `Review saved · 22 decisions` (add date when `createdAt` is known) |
| Read-only, not finalized | `Not reviewed · 22 required decisions` (no "remaining", no actions) |
| Zero required, no Evidence | hide the line; keep `No reviewable result` notice (`:823-828`) |
| Zero required, optional only (3.1 future) | `No required decisions · 24 ungrounded values optional` and no auto-finalize; whether such a review can finalize at all is a PR5a policy decision, not a counter fix |

**Bulk action.** Keep the visible label `Approve remaining (22)` (e2e matchers use `/Approve remaining/`). Add `aria-describedby` to a visually present description; `title` alone is not keyboard-reachable:

```
Approve the 22 required decisions not yet made. Fields you already edited or
rejected, and ungrounded values, are unchanged. When no required decision
remains and nothing was carried from a sample, the review saves automatically.
```

Replace `Review all fields to save automatically` (`:745`) with `Making all 22 required decisions saves the review automatically.`

**Accessibility.** Today the panel has up to six `role="status"` regions (`:424, :739, :808, :818, :824, :905`). Keep two: execution status (`:424`) and the single review progress line. Make the Incomplete Extraction, No reviewable result and ungrounded notices plain text or `role="note"`. Put the draft suffix in an `aria-live="off"` span so "Saving draft… / Draft saved" does not announce after every click; failures already use `role="alert"`. No progress bar: `ui/ProgressBar.tsx:24` is `role="progressbar"`, which implies a running task. "N of M" text carries the state without colour; the existing StatusDot icons (`ui/ResultValue.tsx:386-415`) already avoid colour-only meaning. On 390 px the chips wrap today (mobile screenshot); let the status line wrap and the button row wrap below it with the existing `flex-wrap`.

**Count invariants** (one pure selector, inputs: decisions, touched set, Evidence links, ungrounded paths, transfer verdicts, `reviewedAt`, draft state):

- `required` = decisions whose path has an Evidence link. Locally this is all decisions, so it is a no-op today and the correct filter once 3.1 lands.
- `T = required.length`; `R = required not touched`. Approve, Edit and Reject all count as decided; `review.undo` un-touches; "Reverse decision" sets Approved and stays decided (`ui/ResultValue.tsx:307`).
- Carried decisions are touched on recovery (`reviewDrafts.ts:64-73`, `module.ts:110`), so they are decided but shown separately and block auto-finalize. "Changed since sample" values have no draft decision, so they are in `R`.
- `Approve remaining` count === `R`; enabled iff `R > 0` and not loading/saving/editing. `canAccept` iff `R === 0 && T > 0` plus existing guards. `approveAll` touches only `required`.
- Optional (`decisions − required`, locally empty) is reported as `optionalDecided / optionalTotal` only if non-empty; it never enters `R`, `T`, `canAccept` or `approveAll`. Trade-off: this means a researcher can finalize with undecided optional entries, and bulk approval never silently writes an "Approved" on a value with no model Evidence. The opposite choice (optional in the denominator) would make finalization depend on values the base spec says are not reviewable, so I recommend against it.
- `draftState` comes from the draft writer (`useExtraction.ts:536-562`: version, in-flight writes, conflict), never from counter arithmetic. Carried-only drafts at version 0 show no "Draft saved".
- Navigation inside the result tree only changes `navPath` rendering (`ResultsTab.tsx:663-668`); counts are invariant. Document switch, new attempt and reload reset decisions and touched together (`useExtraction.ts:212-232, 354-355, 480-481`), so counts never straddle two extractions. Zero denominator hides the line.

**Policy decisions to make explicitly, not silently:** keep auto-finalize at `R === 0` (story REV-13 in `docs/validation/2026-10-01-studio-ux-user-stories.md:379`) but say so in the description; optional entries excluded from denominator and bulk approve (plan `:83-92`); batch grid gets the same label and description.

## 4–6. Implementation boundary, tests, confidence

**Smallest boundary.**

- `prototypes/studio/src/reviewProgress.ts` (new, pure): `reviewProgress(input) → { requiredTotal, requiredRemaining, optionalTotal, optionalDecided, carried, changedSinceSample }` and `reviewStatusCopy(progress, phase)` returning the matrix above. Pure so PR5a can lift it into the shared read model later.
- `prototypes/studio/src/useExtraction.ts:625-664`: expose `review.progress` and `review.draftState`; change `canAccept` (`:320`) and `approveAllRemaining` (`:609`) to iterate `required`. Keep `untouchedCount`/`reviewedCount` exported for the existing test fixtures.
- `prototypes/studio/src/ResultsTab.tsx:688-835`: drop the Decisions chip, add an Ungrounded chip, replace the status span and draft paragraph with one status line plus non-live suffix, add the description element and `aria-describedby`, demote the notices from live regions, update the ungrounded sentence.
- Parity only: `projectContexts/BatchExtractionReviewGrid.tsx:648-661` add `(N)` from the sum of `pendingReviewCount` over editable members and the same description text. Leave the grid's progress bar for a later decision.
- Docs: REV-11/12/13 wording in the user-story catalogue; add "required decision" to `CONTEXT.md` only if the word is adopted permanently.

**Rejected alternatives.** Relabel the chip to "entries" (keeps two numbers, chip still never decrements). Make the chip show `untouchedCount` (fixes drift but keeps three surfaces for one count). Progress bar (implies execution). Server-computed counts now (right destination for PR5a, too large for this fix; the client has all inputs). Always-explicit Save instead of auto-finalize (a product change beyond counters; flag it, do not bundle it). Treating "grounded-only approval" as cosmetic against local semantics (locally every decision is grounded, so scope it as a tested invariant, not a wording change).

**Existing coverage.** Approve remaining click and count (`ResultsTab.test.tsx:940-987`, `App.test.tsx:2358-2361`); untouched defaults and approve-all leaving rejects intact (`useExtraction.test.tsx:832-883`); carried line and explicit Save (`ResultsTab.test.tsx:800-828`); finalized read-only (`:989-1027, :1081-1140`); draft recovery across navigation and remount (`useExtraction.test.tsx:126-140`); e2e edit → Draft saved → second tab/reload → Approve remaining → Review saved (`e2e/canonical-evidence-lifecycle.spec.ts:372-402`); grid edit/reject/approve-remaining payload (`e2e/batch-extraction-export.spec.ts:928-957`). Nothing asserts the `Decisions:` chip text, so removing it breaks no test.

**Additions, in priority order.**

1. Component, mixed fixture: 2 grounded decisions + `ungroundedCount: 3`, untouched. Assert `2 of 2 required decisions remaining`, `Approve remaining (2)`, the optional sentence, no text matching `/pending/`, and the button's accessible description mentions ungrounded values unchanged.
2. Component, stateful fixture (pattern at `ResultsTab.test.tsx:846-881`): Reject → `1 of 2`, Edit → `0 of 2`, then `accept` called once; Reverse decision keeps it decided.
3. Component, carried: one carried `reviewed`, one `changed` → `1 of 2 … · 1 carried from sample · 1 changed since sample`, no auto-accept, `Save review` only at zero.
4. Component, draft state: `draftSaving` shows the suffix and leaves counts untouched; carried-only with version 0 shows no `Draft saved`; draft error renders the alert with counts intact.
5. Unit, `reviewProgress.test.ts`: `it.each` over the copy matrix including loading, saving, error, read-only, history, finalized, zero-required; optional entries excluded from `R`, `T` and approve-all.
6. Hook: `progress.requiredRemaining` equals `untouchedCount` for all-grounded fixtures; restored after remount with `draftState === 'saved'`; `'none'` on a fresh attempt.
7. A11y: exactly one `role="status"` inside the summary region; notices not live.
8. E2E, extend the existing lifecycle flow: assert `N of N` before the edit, `N-1 of N · Draft saved` after, same text in the second tab and after reload, `Review saved · N decisions` after Approve remaining; add the status line and button to the `expectOperableInViewport` loop at 360/390 px. Check whether the fixture has an ungrounded value; if not, add one for the optional sentence.
9. E2E batch parity: grid shows `Approve remaining (N)`, decreasing after reject/edit, same description text.

**Confidence.** High on the local mechanism, auto-finalize and approve-all scope (all read from source). Medium on the deployed explanation: 46 = 22 + 24 and the `22 < 46` draft-label hypothesis are inferred from local formulas against the recorded DOM, not from deployed code. Nothing was executed; WCAG 4.1.3 and the NN/g heuristics were applied as principles, not fetched.

**Final example copy (initial state, 22 required, 24 ungrounded):**

```
22 of 22 required decisions remaining
24 ungrounded values are optional. They stay recorded without Evidence and are not counted above.
Approve remaining (22)
  description: Approve the 22 required decisions not yet made. Fields you already edited or rejected, and ungrounded values, are unchanged. When no required decision remains and nothing was carried from a sample, the review saves automatically.
```
