# Durable interactive Extraction implementation evidence

Date: 2026-10-04. Status: implementation in progress; release capability OFF.
Origin: [issue 169](https://github.com/HUM-CDCH/FREE/issues/169).
Worktree: `/tmp/free-durable-extraction-implementation`.
Branch: `feat/durable-interactive-extraction`.
Base: `db6f8b92` (`origin/dev`, includes the view-prioritized streaming client).
Planning commit applied: `8be4bb805455afe9e64bc0a36b2b3f2fccf93ef6`.
ADR 0016 and the existing review-redesign specification preserved from `94328e650d4655a6fd3a5fbbad0929b97e99c324`; conflicting status headers retain the implemented streaming work and the newer review decision.

## Persistence boundary

The authored forward expansion adds only `extraction_runtime`; it does not
change public Extraction columns, original pins, artifacts, or review records.
It stores immutable selections, effective configuration, plans, finalized
inputs, checkpoints, retained snapshots, correction history, artifact
references, and dispatch handoffs. Runtime Head rows identify the new capability;
absence selects legacy readers. Worker privileges use an explicit routine
allowlist. The definer has no application-schema privileges.

Guarded check:

```sh
PROJECT_STORE_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/free_test_durable_implementation \
  pnpm --filter db exec tsx --test src/durable-extraction.postgres.check.ts
```

The target guard runs before any administrative connection. The fixture creates
and removes a uniquely suffixed `free_test_durable_*` database on the disposable
PostgreSQL server and a uniquely named restricted worker role. It does not reset
or use any runtime database, and does not modify another session's database.
The existing test server is only used to provision this isolated database.

Observed: forward migration preserves every seeded historical row byte for
byte (successful/reviewed, failed, and active legacy Extractions); repeated
migration is a no-op; worker table/schema access and internal routines denied;
only allowlisted routines granted; new capture refused after Pause; admitted
output commits during drain; Paused acknowledgement refused while in flight;
identical checkpoint publication returns the saved checkpoint; released/expired
lease rejects stale publication; original capture attribution remains unchanged;
immutable input rejects updates. No provider invocation is involved in this tier.

`pnpm --filter db test`: 85 checks passed, including the migration-reference
check. Extraction compatibility and legacy-reader checks: 4 passed. Extraction
TypeScript checking passed. These are boundary checks, not a full release claim.

## Lifecycle and call boundary

New explicitly named `extractDurableV1` and `extractionCallV1` workflows leave
the legacy workflow names, versions, and step order intact. A separate bounded
coordination pool releases every connection before provider work. Every method
yields at the call seam, publishes an immutable input including the actual HTTP
body, and replays committed outputs. Format fallback has its own dependent
capture and retains the original input. Native fields capture the native schema,
identity and counted input; guidance enters schema instructions rather than the
target source. Each method publishes structurally validated values from its
producer boundary, without reading debug progress as authoritative state.

Guarded process-recovery check:

```sh
EXTRACTION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/free_test_durable_implementation \
  pnpm --filter extraction exec tsx --test src/durable-recovery.postgres.check.ts
```

Observed: all four faults passed (after capture, after finalized input, after
checkpoint commit before DBOS acknowledgement, and after retained-result
publication). Each fault kills a fresh process and starts a replacement. The
restricted worker role owns only its disposable `kei_dbos`; migrations and
fixture setup use the guarded administrative target. The fixture removes its
unique database, role, and temporary credentials. Scripted HTTP providers run
only in the disposable test container. Provider request count equals the final
checkpoint count; retained records survive each restart. This tier does not
establish live-model or browser/service acceptance.

Python targeted checks: 143 passed (8 durable adapter/method checks plus 135
legacy routing, artifacts, progress, worker boot, and model checks). The fresh
container uses image `phoenix-tracing-parsing_worker`, with the worktree mounted
read-only and no runtime database or volume. Node checks: 229 extraction and 85
database checks passed. Studio registration/schedules: 5 passed. TypeScript
checking passed for extraction and Studio. Subsequent edits require appropriate
re-verification before these counts can be used as a final release record.

The independent persistence standards/spec reviews found transaction-disconnect
handling, malformed snapshot admission, selection/manifest digest mismatches,
missing schema-dependent settings validation, unsaved-edit adoption, and
incompatible correction projection defects. These have been corrected; final
review remains required after all four boundaries.

## Pending release evidence

The live review/export and retention/deletion boundaries, additional lifecycle
and concurrent feedback/replanning fixtures, real DBOS drain/stop faults, and
isolated authenticated service/browser checks remain in progress. No readiness
or deployment claim is made by this record. Admissions must remain disabled
until the full [release matrix](../plans/2026-10-04-durable-interactive-extraction-release.md)
has passed. Prototype browser evidence is behavioral planning evidence only.

## Incremental retained review/export and retention checks

The current worktree also contains authenticated durable controls/review API,
immutable correction publication and Project feedback, producing-schema review
projection, exact model-version binding for approvals/rejections, and fixed
version pagination. The schema-adoption fixture retains old text and its saved
text correction while excluding that correction from a new numeric target;
a newer numeric correction never appears as the old text result. Stale writers
and two simultaneous correction saves fail explicitly rather than overwriting.

Guarded controls/deletion check: **passed**, one end-to-end PostgreSQL fixture,
including 503-value fixed pagination, correction conflicts, incomplete review
refusal, changed-output approval invalidation, pending Resume cancellation by
editing, dispatch receipt replay, an unclaimed NULL-lease failure, atomic public
cascade fencing and retained source references. The fixture provisions its own
unique `free_test_durable_controls_*` database and removes only that database.

Real SIGKILL recovery: **all five faults passed** (capture, finalized input,
application output commit, retained result publication, terminal acknowledgement).
The scripted provider count equals committed outputs, and retained values survive
the replaced process. The candidate runs in fresh read-only-mounted disposable
containers against its unique guarded test database.

Local fresh test server: task-owned `free-durable-implementation-pg` (PostgreSQL
17), loopback 5432. No runtime database or another session's container is used.
The earlier caller test server became unavailable; attempts on an alternate port
were refused by the existing guard, which was retained unchanged.

Current observed checks:

- Extraction unit tier: **231 passed**.
- Database unit tier: **85 passed**; forward migration/role/history fixture passed.
- Studio targeted regressions: **8 files, 218 passed**, covering ownership,
  legacy cancellation, public browser boundaries, navigation/reopen, garbage
  workflow, durable review conflict/reload, and exports.
- CSV/XLSX export checks: **3 passed** within that tier. Typed booleans and
  composites remain intact; fixed pages ignore later appends/reviews; workbook
  JSON provenance reconstructs full provider inputs beyond the Excel cell limit.
- Safety tier: **29 passed**.
- Initial full Parsing unit run in a fresh container: **1425 passed, 72 skipped,
  84 deselected, 1 failed** because this older dependency image lacks the locked
  optional `xgrammar` dependency. A restricted mount without the repository's
  parent layout first failed collection; the full repository mount corrected it.
  Installing xgrammar alone exposed its missing `apache-tvm-ffi` dependency;
  the supported frozen environment and final rerun remain required.
- Initial full Studio tier: **2104 passed, 15 failed**. Concrete capability,
  lazy feedback and type-only browser boundary regressions have been repaired
  and their targeted tier passed. Remaining full-tier timing/worker cases need
  bounded-concurrency re-verification.

Local authenticated browser verification remains **unpassed**. One early fixture
attempted its default artifact location and was refused by filesystem permissions;
the fixture now gives both runner and server their own temporary state directory.
Subsequent Chrome runs hit repeated `ERR_NETWORK_CHANGED` while other Docker tests
changed interfaces and did not load the workspace. Rerun this case with the network
stable; none of these attempts counts as browser acceptance.

The user requires E2E verification for every changed feature on **baratheon Spark**.
Those runs explicitly wait for the other agent's results-review tests to finish.
The redesigned review implementation is independently active; further review UI
work is held for integration, and a read-only third-agent risk prompt is prepared.
No Spark run, deployment, merge or production feature enablement has occurred.
This record remains an incremental evidence record, not a completed release claim.

## Latest completion and retention checks

The bounded Standards and Spec reviews found and resolved three additional gaps:
native cancellation requires the existing Parsing boot boundary before cleanup;
scheduled, wake and admission reconciliation receipts require bounded Studio
history retention; and terminal acknowledgement failures need a durable final
publication proof. The proof is published after all final values, including empty
results, and matches the attempt, input selection and generation. Reconciliation
locks and rechecks the current Head/fence before using it. An accepted Stop wins;
Pause racing committed complete coverage repairs to Completed. A stale proof
cannot complete a new linked attempt. Legacy cancellation writers refuse the new
protocol; its authenticated compatibility route uses fenced Stop instead.

Observed after those changes:

- Guarded controls/deletion fixture passed, now also checking stale/invalid final
  proof, completion repair after Pause, Stop precedence, legacy writer refusal,
  and narrow deleted-graph reads.
- Guarded migration/role/history fixture passed on the regenerated migration.
  This fixture ran beside separately provisioned controls and recovery databases,
  verifying idempotent cluster-role creation without sharing test rows.
- All five real SIGKILL recovery faults passed again. The last case additionally
  executed `deleteDurableHistoryV1` through a real DBOS worker with its restricted
  role, removed linked execution history, and retained the tombstoned app graph
  until app cleanup. No SQL transaction spans provider or history-deletion work.
- Parsing completion, retention and boot tests: **39 passed, 3 deselected**.
- Studio retention, cancellation and browser-boundary regressions:
  **4 files, 71 passed**.
- Extraction TypeScript check and `git diff --check` passed.

The corrected full local Parsing run before the final-completion repair passed
**1434 tests, 72 skipped, 84 deselected**. It uses the full repository read-only
mount, pytest 9.1.1 and the lockfile's `xgrammar==0.2.7` plus
`apache-tvm-ffi==0.1.14.post1` in a fresh disposable container; no heavy CUDA
environment synchronization is needed. The earlier grammar/environment failure
is resolved. The corrected full Studio run at two workers passed
**168 files, 2119 tests**; the latest retention change is covered by the targeted
71-test rerun above. These checks establish local regression evidence, not Spark
or complete feature acceptance.

Both read-only review axes have no remaining concrete finding within their
backend scope after the completion/retention fixes. UI redesign integration,
all-feature Spark E2E and the complete release matrix are still required. New
admissions remain disabled by the unconditional release-verification gate.
