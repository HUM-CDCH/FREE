# Part B execution and review ledger

Date: 2026-10-03. Status: local implementation and review complete;
infrastructure verification unavailable; delivery unauthorized.

Delivery update, 2026-10-03: the researcher has now authorized opening a PR,
testing it on Baratheon, fixing any issues, merging into `dev` only after
successful verification, and updating Baratheon with a final smoke test.
The authorization limits below describe the earlier local implementation phase.
The delivery evidence will be recorded separately after the remote checks.

Specification: `../specs/2026-10-02-view-ordered-streaming-extraction-design.md`.
Plan: `2026-10-03-view-ordered-streaming-client.md`. This ledger records execution
rulings, per-task findings and their disposition, verification, and limitations.

## Boundary and base

The supplied `/home/gennaro/projects/FREE` path is absent on this machine. The
actual repository is `/home/gebbaro/Progetti/FREE`. The initial fetch found
`origin/dev` at `b09fc8df` without the redesign exports; execution stopped.
The researcher authorized an early start from the redesign branch by choosing
option 2. The subsequent fetch found PR #167 merged: `origin/dev` at
`6788bd7c1255ea16916f260e21d207eecdf2e69a` has all three required exports and
exactly the same tree as the authorized redesign head `6e00c4c2`.
The isolated worktree `/tmp/FREE-view-ordered-streaming-client`, branch
`feat/view-ordered-streaming-client`, therefore uses the merged base.

This option 2 authorizes local implementation only. No push, PR, merge,
Baratheon operation, or production operation is authorized. Stop at the delivery
decision point after implementation and review. The production protocol was
referenced but its numbered steps were not included in the request; retrieve
or obtain those steps before any subsequently authorized delivery.

## Rulings (Ruling 8 recorded before Task 1; later rulings added during execution)

1. Preserve the server's record order (§1). Never reorder by page on the client.
2. A record without values uses the pinned schema's record-level fields as
   placeholders; a returned record uses its own keys (§1; plan Ruling 2).
3. Partial Evidence links paint without scrolling. Focus survives polls of the
   same Extraction; switching Extraction clears it (§1).
4. The partial Results view reports `['records']` for Evidence filtering. The
   settled view retains its own navigation (§5).
5. Once discovery is known, the badge and run control use the server progress
   counts, `k of n`; before discovery, use `running` (§1).
6. Retain previously server-reported finished records when a transient read
   regresses them or loses links, including across reconnects. Keep the last
   partial on a read without progress. Settlement wins (§5). Retention keeps
   complete server snapshots and their value states; it never promotes values.
   Progress counters retain the maximum server-reported counts across these
   reads; they are not recomputed from records. A temporarily absent finished
   record retains its earlier server-order neighbors, without sorting by page
   or index. This supersedes the plan's client-side counter recomputation.
7. Settlement swaps the partial component for the settled component in one
   render and restores source order. DOM continuity and focus continuity across
   that swap are not promised (§1; plan Ruling 7). Cost: expanded partial rows
   and their DOM focus may be lost at settlement.
8. **State ownership and exact presentation mapping (§5; supersedes the plan's
   fallback to `empty`).** Record-level `PartialRecordState` means
   `PartialRecord['state']` (`queued | reading | checking | finished`); it is not
   a separately exported contract type. The redesign's `ValueState` means
   `grounded | checking | reading | queued | empty | contested`. Part A's
   per-leaf `PartialValue.state` is authoritative: map every supplied state to
   the identically named `ValueState`, without deriving it from page, Evidence,
   timing, record completion, or settled values. For placeholder fields without
   leaf metadata, the explicit presentation mapping is record `queued` → UI
   `queued`; record `reading` → UI `reading`; record `checking` or `finished`
   with missing leaf metadata → UI `queued` (unavailable authoritative value,
   text hidden). These placeholders make no claim about extraction progress.
   Container paths have no leaf state; only their leaves carry states. Never
   default a missing leaf to `empty`, nor use a link to promote it to `grounded`.
   Candidate text is allowed only in the explicitly labelled checking
   presentation; no container preview may expose it as an ordinary value.
9. The merged redesign uses a completion toast with "Review now", and its
   current lifecycle journey differs from the plan's stale second-run/dialog
   anchors. Apply the page-2 blocked-result progress assertions to its first
   UI run, preserving all existing toast, review, export, and reopen assertions.
   The Catalog stand-in supplies an explicit Evidence link for the finished
   field; completion alone does not ground it. This changes test anchors only.
10. Empty objects and arrays have no Part A leaf metadata. During streaming,
    describe their returned structure neutrally (`0 fields`, `0 items`,
    `No fields returned.`, `No items returned.`); do not infer an `empty` value
    state or display a Missing badge. Settled rendering remains compatible.
11. A no-review partial's supplied `checking` or `grounded` state must not be
    overwritten by null/blank text. For wire-schema-valid but semantically
    inconsistent payloads, retain the supplied state presentation with neutral
    `No value text supplied.` copy: a labelled candidate marker for checking,
    and the supplied Evidence affordance for grounded, without asserting
    Missing. Current Part A normally excludes such combinations; this is a
    defensive presentation rule, not a claim of a published runtime defect.
    Explicit settled researcher rejection or edit-to-absence still uses the
    existing Missing review presentation and its extracted Evidence.

## Per-task Codex triage

### Task 1

- Focused state/helper tests: 58 passed. Test-first failures established missing
  partial state, start-page handoff, and retention. Static verification found
  an incorrectly inferred union in the test fixture's conditional values map;
  fixed with a `PartialRecord` callback return type, without a cast. Client
  typecheck and 58 focused tests then passed.
- **T1-P3-1 accepted:** retaining complete server-finished snapshots from two
  incomplete reads can display two finished records while the maximum
  server-reported counter is one. The reviewer reproduced this with a `tsx`
  probe. Ruling 6 deliberately preserves server counters rather than deriving
  extraction progress on the client. Cost: the header, badge, and bar may
  temporarily undercount the cached finished rows; settlement resolves it.
- **T1 retention gaps fixed:** omitted finished records retain their earlier
  server-order neighbors; replacement snapshots must retain prior link
  identities (equal counts alone are insufficient). These strengthen plan
  Ruling 6 without promoting any value state.
- Reviewer rejected inference, cross-run cache contamination, stale-response,
  and settlement concerns after tracing the monitor's ownership checks and
  terminal state conversion; focused tests cover these paths. Open P0/P1: 0.

### Task 2

- Initial component/badge tests failed before implementation. The nested
  preview test reproduced ordinary candidate text in the existing object
  preview. Guarded previews now use only explicit grounded states while the
  partial view supplies a state for every displayed leaf.
- Initial independent focused verification: 132 tests passed, scoped lint
  and diff whitespace checks passed.
- **T2-P2-1 confirmed and fixed:** empty containers displayed Missing without
  authoritative metadata. The reviewer reproduced a reading/failed progress
  response with `{}` and `[]`, no leaf metadata, and a Missing badge. Ruling 10
  resolves the gap with neutral shape presentation and converter-backed
  reading/failed and checking regression tests. Tests failed before the fix.
- **T2-P3-1 confirmed and fixed:** filtering previews whenever any state callback
  existed also hid legacy settled previews when the production callback
  returned `undefined`. The legacy case is preserved and tested with the actual
  callback shape; partial callbacks always return an explicit state. Tests
  failed before the fix. Independent rereview closed both findings and passed
  all five focused files (142 tests), lint, and diff checks; no new findings.
- Re-anchor: `RecordHeader` is exported by `ui/ResultValue`, not the UI barrel.
  Raw records supply field/container shape; `PartialValue.value` supplies
  displayed leaf text. Evidence affordances require the explicit grounded
  state and never determine that state. Open P0/P1: 0.

### Task 3

- Test-first run: 77 passed, four expected new assertions failed (partial
  highlights, poll focus, start-page request, partial headline). Focused final
  run: 84 tests passed. Owned lint and diff checks passed.
- **T3 test findings fixed:** seven exact request expectations needed the new
  `startPage: 1`; the source-switch stub must echo the posted admission ID so
  the real monitor's lookup succeeds; a restored-run response must use the
  strict wire attempt, without reopen-only metadata. These preserve backend
  behavior and strengthen the tests rather than changing polling.
- Headline assertions wait up to four seconds for the unchanged first
  two-second poll. The switch test's overall timeout is eight seconds to cover
  that poll plus its existing 2.1-second stale-response guard.
- **T3 focus/review-closure claim rejected:** a throwaway probe excluded some
  occurrences in a finalized review, but `packages/extraction/src/review-rules.ts`
  requires every published occurrence. The trigger is not a valid final review;
  preserving focus on a same-ID poll is intentional Ruling 3.
- Independent archived-base overlay/App suites: 78 tests passed. This confirms
  stale request expectations were introduced test mismatches and were fixed.
- **T3-P2-1 confirmed and fixed:** when a selected Evidence anchor's page was
  not rendered yet, its active focus listener existed but its DOM overlay did
  not. A same-Extraction settlement scrolled to the first settled link, stealing
  the selection's page. An executable reviewer probe and a failing regression
  established the race. Automatic settlement scrolling now checks the active
  focus listener rather than DOM presence. The regression settles before page 2
  renders, confirms the only navigation is the researcher's page-2 selection,
  then renders it and checks focus and settled highlights. Seven overlay tests
  and scoped lint pass. Independent rereview closed the finding; Open P0/P1: 0.

### Task 4

- The browser test captures actual `start_page`, gates artifact settlement,
  asserts server order and explicit candidate/grounded presentation for Catalog
  and Article, counts in both the Results tab and run control, no partial review
  controls, and the final partial-to-settled replacement. Ruling 9 records the
  updated test anchors. Progress fixtures are typed as `ProgressDocument`.
- `playwright ... --list` loads and lists all three lifecycle tests successfully.
- Independent reviewer executed the actual `progressFor` helper through the
  progress schema, Part A converter, and client partial schema. Both fixtures
  passed: Catalog order was `1, 2, 0` with grounded/checking/absent title states;
  Article had a checking title and one of two contexts answered. No confirmed
  Task 4 findings. Open P0/P1: 0.
- **Environmental limitation:** the targeted browser run cannot start its
  disposable stack: `/var/run/docker.sock` does not exist. Rootless Podman also
  fails to create a user namespace (`newuidmap: Operation not permitted`). No
  browser assertions ran; PostgreSQL and live-model tiers remain unverified.
  The plan explicitly permits recording this gap for later Baratheon
  verification. That later verification is not authorized by the early-start
  option and remains conditional on a separate delivery choice.

## Task review and verification

Tasks 1–4 implemented and independently reviewed. Two whole-branch sparring
rounds complete. Open P0/P1: 0. All lower-severity findings are fixed, rejected
with evidence, or explicitly accepted with cost. No delivery action is authorized.

## Whole-branch sparring

### Round 1

- **WB1-P2-1 qualified and resolved:** the reviewer initially reported that a
  rerun from Values as code or Markdown would leave `resultPath` null despite
  a visible partial, disabling overlays. Further tracing disproved the normal
  production trigger: `RightRail` keys `ResultsTab` on Extraction ID, so an
  acknowledged new run remounts its default Review view. The component-level
  effect nevertheless gated Ruling 4 behind its retained view. The tiny
  precedence fix makes a visible partial always report `['records']`, without
  relying on the parent's remount. Two failing component tests reproduced the
  retained-view case; all 83 ResultsTab tests and touched lint now pass. The
  production runtime claim is rejected, the contract gap is fixed.
- **WB1-P3-2 qualified, defensive gap fixed:** an SSR probe with a
  wire-schema-valid grounded null, or checking blank, displayed Missing based
  on scalar contents. The current converter only checks populated scalars;
  Article grounding excludes null/blank claims and attaches links to the final
  root. The reviewer therefore rejected a normal published-runtime regression
  claim. Ruling 11 nevertheless guards the client against schema-valid
  inconsistent metadata without overriding its server state. It preserves
  explicit settled review actions and never displays absent candidate text.
  Eight new direct-render and schema-parsed-partial cases failed before the
  fix; the checking branch now precedes scalar absence, and grounded absence
  uses neutral text while retaining Evidence. Explicit edit/rejection review
  tests pass as well. Scoped lint passed; independent round-2 review follows.
- Both independent whole-branch reviewers finished round 1 with Open P0/P1: 0.
  No other confirmed new P2/P3 findings. The counter display limitation remains
  accepted with its cost above; the infrastructure gap remains unverified.

### Round 2 (final)

Both reviewers re-audited the complete feature surface and the latest
Ruling 4/11 changes. Open P0/P1: 0; no new P2/P3 findings. WB1-P2-1 is resolved
as a component contract alignment, and WB1-P3-2 is closed as a defensive
presentation fix. Explicit reviewed absence and extracted Evidence remain
compatible. The first reviewer independently ran 12 focused regression cases;
all passed. Both verified diff whitespace checks and made no changes.

The final static gate caught a union type in the lazy-focus regression fixture:
cloning an un-narrowed text/table anchor combined their observation shapes.
Fixed with a runtime text-anchor kind guard, without casts or production edits.
Studio typecheck and all seven overlay tests passed, followed by the final
workspace typecheck. This verification finding is closed.

## Integrated verification

- `pnpm -r typecheck`: PASS after the fixture annotation fix.
- Studio lint: PASS, zero errors. Two unchanged hook dependency warnings at
  `useExtraction.ts` are outside this change; they concern existing lifecycle
  effects and are accepted without altering their restart/monitor semantics.
  Cost: the existing warning noise remains; no new warning was introduced.
  Archived-base ESLint reproduced the same two warnings (base lines 293/409).
- Full Studio unit suite with two workers: 166 files, 2103 tests PASS before
  the two additional whole-branch component regressions. The initial default
  concurrent run failed stale request assertions (fixed above), concurrent
  in-progress fixtures (fixed above), and six unchanged PDF/provider timing
  assertions; every one passed in the constrained full suite. Archived-base
  PDF/provider suites also passed all 55 tests with two workers. The initial
  failures are classified as concurrent timing/resource-sensitive harness
  failures, rather than product regressions; the untouched suites stayed green
  under bounded concurrency. No timeout or product change was made for them.
- `git diff --check`: PASS. No dependency or server/database/workflow changes.
- Targeted lifecycle browser execution: blocked before browser startup by the
  absent local Docker daemon, as recorded under Task 4. It is not a passing tier.
- Final Studio unit gate: `pnpm -C prototypes/studio test --maxWorkers=2
  --reporter=dot` PASS, **166 files / 2114 tests**, in 148.27 seconds. Log:
  `/tmp/FREE-part-b-studio-final-tests.log`. The subsequent fixture-only type
  narrowing was verified with all seven overlay tests; no production code
  changed after the full unit gate.
- Final `pnpm -r typecheck`: PASS. Final Studio lint: PASS, zero errors and the
  same two verified baseline warnings. Final lifecycle Playwright listing:
  all three tests loaded. Both Article/Catalog progress fixtures passed the
  actual server and client schemas/converter under independent review.
- Final `git diff --check`: PASS; all five untracked files separately checked
  for trailing whitespace and final newlines. The original checkout is clean.
  No commits, pushes, PRs, merges, Baratheon actions, or production actions.

## Delivery decision and remaining limits

The implementation is an uncommitted local diff on
`feat/view-ordered-streaming-client` in `/tmp/FREE-view-ordered-streaming-client`.
All implementation/test files, including untracked files, were reviewed.
The local gate is complete within the available environment. Browser,
PostgreSQL, real-service, and live-model verification remain unexecuted here;
neither listing nor fixture conversion substitutes for those tiers. Any
required tier must pass before a subsequently authorized delivery progresses.

Accepted limitations: cached finished records may temporarily exceed the
server counter (T1-P3-1); settlement remounts the results and can lose expanded
partial rows/DOM focus (Ruling 7); two pre-existing lint warnings remain.
The numbered Baratheon protocol and prescribed production wrapper were
referenced but not supplied. Obtain those exact steps before delivery, including
preservation of Phoenix edits, merged-commit deployment, GPU idleness before
real-model checks, and working-state restoration after a failed deployment or
smoke. No `.env` contents were read or exposed, and no containers stopped.

Delivery choices: **1** keep the implementation local; **2** separately authorize
PR → Baratheon verification → dev merge → production deployment under the
numbered protocol, which must first be supplied. The earlier early-start choice
2 is not this delivery authorization.
