# Workbench workflow integration — 2026-09-30

Status: implemented and verified; independent review complete.

Implementation request: `docs/plans/2026-09-30-workbench-workflow-integration.md`
in the original checkout. Its accepted scenarios are recorded in the active
[workflow-integration specification](../../openspec/changes/archive/2026-10-02-sample-extraction-workbench/specs/workflow-integration/spec.md)
and updated [review-transfer specification](../../openspec/changes/archive/2026-10-02-sample-extraction-workbench/specs/review-transfer/spec.md).
PR4 (description suggestions from corrections) remains pending independently.

## Frozen heads and delivery boundaries

The dedicated branch is `feat/workbench-workflow-integration`, in
`.claude/worktrees/workbench-workflow-integration`. The original checkout's
uncommitted local-development documentation, task edits, `.pi/skills`, plan
evidence and `unify-catalog-extraction` were preserved and excluded.

- Workbench: `54c22483adc25d1bd56a26cde7300d14b9fefaa6`.
- Freshly fetched dev: `81d981a9574e2c365ea0d352362e104a856775e9`.
- Integrated baseline: `93967f69e88d09961345a9d91604419dde36f2e1`.
  The dev merge had **zero conflicts**. Donor workflow commits/migrations were
  not replayed.
- Final runtime candidate and tested tree:
  `1617c51de8e7094ad2a9c72b0242ce8d399f026d`. The earlier browser/service
  expectation and workflow-status synchronization follow-ups change no runtime
  source; the last commit fixes focused Evidence repainting after PDF rendering.

Each boundary follows the preceding row; review and merge in this order after
the integrated workbench/dev baseline. These are local commits, not published PRs.

| Boundary | Base | Commit | Behavior |
| --- | --- | --- | --- |
| PR3 prerequisite / PR5a | `93967f69` | `342406c6` | Canonical optional corrections, shared pinned-cell attention, baseline fixes |
| PR5b | `342406c6` | `67fa5b86` | Stable field navigation, same-pages re-run, selected-source coverage and guidance |
| PR6 | `67fa5b86` | `6c50d036` | Bounded transient Excel preview and ordinary schema confirmation |
| PR7 | `6c50d036` | `845c5cfa` | Atomic member sample snapshots and collection review |
| Review corrections | `845c5cfa` | `ebd51ac9` | Import bounds, current-editor navigation, coverage refresh, pairing recovery/reset |
| Retry correction | `ebd51ac9` | `8ddc6a72` | Recovered pairing refresh after transient failure; preserve decision-only recovery |
| Browser expectation | `8ddc6a72` | `7a969dc0` | Incomplete zero-grounded results permit explicit review finalization |
| Test synchronization | `7a969dc0` | `1721ece4` | Wait for DBOS success before exercising interruption of a settled workflow |
| Service expectations | `1721ece4` | `14c5900e` | Count both grounding stages; finalize grounded values without treating optional templates as decisions |
| Evidence repaint | `14c5900e` | `1617c51d` | Preserve canonical focus after PDF page rendering; release replaced/source/attempt listeners |

The runtime diff adds 1,078 and removes 235 source/configuration lines; tests
add 869 and remove 46. Generated migration artifacts/lockfile account for
14,463 additions. The implementation uses the existing schema controller,
review draft API, matcher, admission transaction, Extraction rows and DBOS
enqueue. It adds no lifecycle, readiness gate, review decision kind, snapshot
table or workflow sequence.

## Verification environment

Spark is reached through SSH alias `baratheon`. Tests run in the isolated
`/home/geba/free-workbench-integration-20260930` copy with Node 24.21.0,
pnpm 12.8.1 and the frozen Parsing Service Python environment. A SHA-256
manifest checked all 1,357 tracked candidate files before and after the final
aggregate. The post-test result is `/tmp/free-workbench-candidate-integrity-after.log`.
Production services and deployment configuration were not changed.

The final aggregate command is `pnpm test:all` with caller-provisioned
`PROJECT_STORE_POSTGRES_URL`, `EXTRACTION_TEST_DATABASE_URL` and
`PARSING_TEST_DATABASE_URL`. The Spark wrapper supplies these internally;
the preserved output and exit status are `/tmp/free-workbench-all-06.log`
and `/tmp/free-workbench-all-06.exit`. The targeted complete browser command
is `pnpm --filter studio exec playwright test e2e/canonical-evidence-lifecycle.spec.ts`;
its output is `/tmp/free-workbench-canonical-final.log`. Migration verification
is recorded in `/tmp/free-workbench-migrations.log`.

Caller-authorized test PostgreSQL is the existing `free-validation-pg`
container on `127.0.0.1:5432`, labelled `free.test=parsing`. The final aggregate
uses newly provisioned `free_test_workbench_project_06` and
`free_test_workbench_extraction_06`; the Parsing Service harness creates its
own disposable `free_test_parsing_*` targets through `free_test_gates`.
No existing caller database was reset or dropped. The wrapper reads test
credentials internally. Raw validation logs are restricted to their owner;
no credentials are recorded in this receipt.

An initial laptop-wide unit run hit its user disk quota in the 65 MiB PDF
fixture. The corresponding full unit tier passed on Spark. An earlier Spark
aggregate stopped at an obsolete zero-grounded-values browser expectation;
another stopped in decision-only authentication recovery. Both defects were
corrected and the aggregate restarted before acceptance. A later aggregate
passed all Node/DBOS tiers but stopped at the unchanged Parsing Service
worker-slot termination test: its lock was free for one poll before the
process exit was observable. The isolated test passed in 15.20 seconds without
code changes. A fresh run then exposed an unchanged DBOS test precondition:
the fixture waits for the Extraction row to settle, which can precede workflow
`SUCCESS`. Commit `1721ece4` waits for that exact status through the existing
bounded helper before clearing the outcome; both interruption assertions are
unchanged. Its isolated PostgreSQL test passed. The next aggregate passed
every earlier tier, including all 57 Python PostgreSQL checks, 66 browser
tests and five recovery tests. Its service tier passed 14 of 16 cases: two assertions omitted existing
Catalog grounding calls or assumed optional-field templates were decisions.
Commit `14c5900e` corrects the exact call count and verifies that only six
grounded decisions are finalized and survive restart; the two optional
templates remain undecided. Runtime code is unchanged by these test fixes.
The corrected recipe case then exposed a real focus-rendering defect:
pdf.js clears custom page children when loading an unrendered page, while
the focus overlay was painted only once. `1617c51d` repaints on the existing
`pagerendered` event, scrolling only at initial selection and unsubscribing on
replacement/source/attempt/unmount. Six focused tests passed, and both native
PDF and recipe CATALOG review/Evidence/restart cases passed on Spark (59.7s).
That targeted output is `/tmp/free-workbench-service-final-rerun.log`.
The final fresh aggregate on the frozen `1617c51d` tree passed with exit status
**0**, including the worker termination check and all corrected browser and
real-service lifecycles.

| Check | Result on final runtime candidate |
| --- | --- |
| Typecheck | Passed |
| Lint | Passed; two existing hook dependency warnings, zero errors |
| Node unit | Passed: scripts 61, configuration 4, Studio 1,728, DB 70, extraction 135, export 35 |
| Parsing Service fast tests | 1,114 passed, 72 skipped, 75 deselected; three warnings |
| Safety | 18 passed |
| DB PostgreSQL | 51 passed |
| Extraction PostgreSQL | 91 passed |
| Studio PostgreSQL / DBOS | 68 passed across 13 files |
| Parsing Service PostgreSQL | 57 passed, 1,204 deselected; two warnings |
| Authenticated browser and recovery | Standard browser: 66 passed, including the complete import-to-collection flow; recovery: 5 passed. Targeted lifecycle: 3 passed |
| Real Parsing Service workflow | 16 passed; separate targeted native PDF/recipe CATALOG lifecycle: 2 passed |
| `pnpm test:all` | Passed, exit status 0, fresh Spark run 06 |
| OpenSpec strict validation | Passed after the acceptance checklist update |
| Production build | Passed; Vite reports its client chunk-size advisory |

The deterministic browser fixture exercises import preview without writes,
explicit revision confirmation with stable IDs, sample correction with
canonical Evidence, reload/finalization, field rename, acknowledged revision
and same-pages fresh admission, whole-source review and collection member
finalization. The standard recovery/service tiers cover durable restarts and
review persistence. Live-model and full Compose system tiers are outside
`test:all` under README's verification contract.

## Forward migration and bounded admission

Only `20260929T2308_optional_review_evidence` extends the integrated migration
chain. Its operation drops NOT NULL on `reviewDecision.evidenceAnchorId`;
older reviews remain readable. Fresh migration, baseline-to-current upgrade
and `db:verify` passed on isolated Spark targets.

- Start contract: `sha256:424d472a6f39150605a9e365e55222f32318931abf50fb897df4b1c245033afd`.
- End contract: `sha256:d99fd42d4913a99f4b36604cfd191ab07f781fe6e43ee123f129213d2e3f8cd3`.
- Migration: `sha256:1dde3f2094051496c430e1d9e850c6a8da9257fcaffe8422bed12e54f98a4850`.

Measurements below are from the final aggregate's real pooled transactions,
not a latency guarantee. Each fixture has one sampled source with two eligible
samples, unsampled members and an unrelated source with history. Queries assert
selected-source predicates; they never load the unrelated history or copy a
full result. Snapshot bytes describe that sampled source's immutable union.

| Members | Source snapshot reads | Transaction queries | Elapsed | Snapshot bytes |
| --- | --- | --- | --- | --- |
| 6 | 6 | 93 | 128 ms | 847 |
| 50 | 50 | 576 | 465 ms | 847 |

Equal-selection replay retains snapshots after sample edits; create-new
captures current decisions. Injected snapshot failures on member four roll
back all batch/member/enqueue rows, including suggested-schema confirmation.
The coverage fixture proves five samples on pages 12–13 cover two physical
pages, excludes other schema revisions, removes coverage after reprocessing,
and refuses duplicate, oversized and cross-owner selections.

## Standards

The independent baseline review's provenance and scoped pairing findings were
resolved before extending member admission. The review of frozen `845c5cfa`
found one P2 documented-contract issue: collection reset retained local hand
pairings after PostgreSQL cleared them, allowing a later save to restore them.

Final independent disposition: no new documented-standard breaches or
actionable smell regressions in `ebd51ac9..1617c51d`. Retry changes preserve the
common draft-save/read paths. Single-review recovery sends pairings only when
they differ from the server. Four independent recovery tests passed (44
skipped); the finalized-pairing → reset → edit regression also passed.
The original reset finding remains resolved. The final browser assertion
matches explicit finalization with zero grounded values. The subsequent DBOS
test synchronization retains the same SUCCESS precondition and interruption
assertions with a bounded 20-second wait. Service-test changes preserve the
exact model-call count, Evidence and restart checks and strengthen the
distinction between prepared templates and finalized decisions. Reviewers
made no file/database changes. The final Evidence repaint fix keeps ownership
inside the existing overlay hook; independent execution passed all three
focused overlay cases and confirmed cleanup and initial-only scrolling.

Standards: one integration finding, initially P2, resolved; zero outstanding.

## Spec

The baseline review found selected-page duplicate/order contamination and
equivalent-record duplicate pairing across samples. Both were resolved before
PR7; whole-document segmentation and conservative record identity remain.

The frozen integration review found five P2 issues, all resolved at
`8ddc6a72e05449dbae5564c556774368e0d4aaae`:

1. CDATA bypassed decoded-cell bounds and disappeared from previews; refuse
   unsupported CDATA before ExcelJS, with short/oversized regressions.
2. A field jump could target a historical preview; close it and retain the
   current dirty editor, including removed-field explanations.
3. Pre-admission coverage refresh discarded its response; refresh the same
   displayed read, track the acknowledged revision, and show unavailable on
   failure.
4. Recovered hand pairings lost their mapping or left carried facts stale;
   preserve mappings and reload after successful replay or explicit retry.
   Four regressions cover both clients with success and transient failure.
5. A concrete optional correction without model anchors lacked a pairing
   affordance; use its canonical correction Evidence for page eligibility,
   while retaining explicit pairing and conservative automatic identity.

Final independent execution confirmed the remaining retry branch: the first
write fails, retry succeeds, then one common member reload follows. No
additional regression was confirmed in the final narrow diff. The subsequent
test-only `7a969dc0` independently passed Spec review: the zero-grounded fixture
may finalize while retaining visible missing/ungrounded attention. The next
test-only `1721ece4` also passed independent Spec review: it synchronizes the
same SUCCESS precondition without weakening the interruption assertions.
The subsequent `14c5900e` passed independent Spec review: both strategies'
grounding calls are counted, and optional templates are neither decisions
nor a finalization requirement. Exactly six grounded decisions survive the
recipe workflow restart.
The final `1617c51d` independently passed Spec review: source Evidence remains
locatable after page rendering, repainting clears prior focus before replacing
it, and listeners are released without adding a new abstraction.

Spec: five integration findings, initially P2, resolved; zero outstanding.

## Bounded self-review

The simplify-and-harden pass removed one duplicate pinned-schema parse,
verified the accepted ownership/resource bounds and used focused regressions
for the review corrections. No structural refactor was needed. Applicable
tests, typecheck and lint were repeated after the edits. The targeted complete
browser lifecycle and corrected real-service lifecycles passed. The final
focus-rendering regression also verifies listener cleanup. The complete final
aggregate passed, and section 10 of the active acceptance checklist records
the verified workflow integration. PR4 remains independent and pending.
