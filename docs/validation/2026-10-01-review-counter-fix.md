# Review-counter fix — 2026-10-01

Status: implemented and verified locally. Database-backed E2E execution is blocked by the unavailable Docker daemon/socket. The remote deployment has not been changed or rechecked.

Baseline: `54c22483adc25d1bd56a26cde7300d14b9fefaa6` plus the working tree. Unrelated concurrent edits were preserved. This follows [UX-02](2026-10-01-studio-exploratory-browser.md#ux-02-review-counters-use-conflicting-looking-meanings-of-pending) and the [Claude Code Fable 5.1:max consultation](2026-10-01-review-counter-ux-consultation.md).

## Resulting behavior

Results has one required-review status, for example **2 of 2 required decisions remaining**, and no generic total-labelled-as-pending chip. Approving, editing or rejecting a value reduces the numerator; the denominator remains the server-prepared required-decision set. Raw JSON/result navigation does not change those counts. A completed historical review displays its saved decision count, while unreviewed read-only results show a factual required count without actionable remaining-work wording.

Ungrounded values retain their warning and are explicitly excluded from required review. Incomplete Extraction warnings remain visible. Local server contracts prepare decisions only for grounded values; this change does not introduce the separate optional-decision behavior seen in the deployed build, modify finalization validation, or create Evidence for ungrounded values.

Draft feedback is separate from decision progress. Fresh or version-zero sample-carried decisions do not imply a saved draft. Saving draft reflects an in-flight write; Draft saved requires an acknowledged write or recovery of an acknowledged server draft. Failed writes, conflicts and writes still in flight cannot report the current draft saved. Late acknowledgements are scoped to the document/attempt that started them.

Bulk approval retains its existing behavior and gains a visible accessible description: it preserves prior edits/rejections and ungrounded values, and ordinary complete reviews save automatically. Sample-carried decisions retain their explicit Save review requirement. Loading has one review status, and a failed initial review read has a retry control rather than misleading zero-of-zero progress.

The batch grid uses its pending-decision selector for a counted Approve remaining action and a required-progress status across loaded members. Its description explicitly includes rows hidden by filters. Loading and unavailable review data are distinguished from a complete batch denominator, and draft acknowledgement replaces touched-count arithmetic for its persistence feedback. Approval is disabled while member review data loads or no decision remains.

The review status is one atomic live region for the editable result; draft-write chatter is a separate non-live suffix. Existing significant failure and incomplete-result announcements remain intact. Responsive controls wrap using the existing design tokens and layout primitives.

## Verification

| Check | Result |
| --- | --- |
| Targeted Results, single/batch controllers, API fixtures, RightRail, App navigation and draft recovery tests | **229 passed**, 7 files; [unit log](2026-10-01-review-counter-evidence/unit.log) |
| Studio TypeScript build checks | **Passed**; [log](2026-10-01-review-counter-evidence/typecheck.log) |
| ESLint on changed executable files | **0 errors**, 2 existing effect-dependency warnings in useExtraction; [current log](2026-10-01-review-counter-evidence/lint.log), [HEAD baseline log](2026-10-01-review-counter-evidence/lint-baseline.log) |
| Chromium ResultsTab + actual useExtraction against controlled in-memory responses | **Passed**, after the final changes; [checks](2026-10-01-review-counter-evidence/browser-check.json) |
| Canonical ARTICLE/CATALOG lifecycle and batch-grid Playwright scenarios | **Not run**: stack setup failed because `/var/run/docker.sock` does not exist, including an unsandboxed retry; [failure log](2026-10-01-review-counter-evidence/e2e-stack-unavailable.log) |
| Whitespace check | `git diff --check` passed |

The Chromium fixture contains 2 grounded values and 24 ungrounded values. It uses the actual ResultsTab, review controller, API response validation and Studio stylesheet with controlled HTTP responses. It verifies accessible approval scope, rejection and edit progression, acknowledged draft feedback, reload recovery, result-tab count invariance, automatic finalization and no uncaught page errors. The panel and action fit at 390×844, 360×800 and 640×400; the last is a viewport equivalent of 200% zoom on 1280×800. This is component-level browser evidence, not authentication, PostgreSQL persistence or a full workspace layout check.

Screenshots: [initial desktop](2026-10-01-review-counter-evidence/01-required-review-desktop.png), [initial mobile](2026-10-01-review-counter-evidence/02-required-review-mobile.png), [partial mobile](2026-10-01-review-counter-evidence/03-partial-review-mobile.png), [finalized mobile](2026-10-01-review-counter-evidence/04-finalized-review-mobile.png).

The canonical lifecycle spec now asserts count changes, reload/second-tab recovery, viewport bounds, accessible bulk scope, finalized copy and a mixed 2-grounded/6-ungrounded result without finalizing that partial review. The batch-grid spec asserts decreasing and filter-invariant counts, reload recovery and zero remaining after save. Those added assertions are typechecked, but their database-backed execution remains pending.

## Reproduction

Normal verification, when Docker is available:

```sh
pnpm --filter studio exec vitest run src/ResultsTab.test.tsx src/useExtraction.test.tsx src/useBatchExtractionReviewGrid.test.tsx src/api.test.ts src/RightRail.test.tsx src/App.test.tsx src/reviewDrafts.test.ts
pnpm --filter studio typecheck
pnpm --filter studio exec playwright test e2e/canonical-evidence-lifecycle.spec.ts e2e/batch-extraction-export.spec.ts --workers=1 --grep 'real .* lifecycle|Batch review grid'
```

For the component-level Chromium check, the captured fixture sources are in [fixtures](2026-10-01-review-counter-evidence/fixtures/). These scripts use this workspace's absolute paths and node_modules. Copy them to `/tmp/free-review-browser-qa`, run `node /tmp/free-review-browser-qa/server.cjs`, and run `node /tmp/free-review-browser-qa/check.cjs` in another terminal. Each fresh server starts with an empty in-memory draft and binds only loopback port 48792. Stop and restart it between complete checks; the script finalizes its fixture's review. It never reaches the deployment or a database.

## Bounded final review

The simplify-and-harden pass reviewed only task-modified code. It tightened saved-draft feedback so a prior acknowledgement cannot claim newer in-flight or failed changes are saved, with a deferred batch-write regression test. No additional refactor, dependency, auth, database or deployment change was introduced. The final unit, type and component-browser checks were repeated after these edits. Remaining verification work is the Docker-backed browser tier; this is an infrastructure limitation, not an automatic approval rejection.

## Independent code-quality review

Claude Code Fable 5.1 with max effort returned **PASS WITH NOTES**, with no P1/P2 findings. The [review and adjudication](2026-10-01-review-counter-code-quality.md) records the remaining P3 notes, coverage gaps, rejected rapid-write finding, and verification limits. No review follow-up fixes were applied in this commit.

## Dev integration

The [dev integration record](2026-10-01-review-counter-dev-integration.md) describes branch-specific conflict resolutions and fresh verification. The original record above describes the feature-branch implementation, including its Sample Extraction behavior.
