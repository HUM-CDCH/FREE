# M0R items 2–4: pre-implementation probes (2026-09-26)

Status: **items 2, 3 and 4 pass** on x86_64. Four findings change or add to
the [plan](../../2026-09-24-unified-durable-execution.md); they are listed first.
This record covers only the sub-items the [earlier evidence](../README.md) left
open. It does not re-prove `probe.mjs`, `admission-races.mjs`,
`queue_probe.py` or `version-probe.mjs`.

## PLAN IMPACT

1. **Studio must declare DBOS itself (M2, `prototypes/studio/package.json`
   and `vite.server.config.ts`).** Vite keeps a dependency external only if it
   resolves from Studio's own root. Studio's current SSR bundle inlines what
   arrives through the linked `db` package: it contains `pg` 8.22.0 and
   Prisma Next, and it imports neither. If DBOS were imported only from a
   workspace package, the build fails, because DBOS's optional lazy
   `require('@opentelemetry/api')` / `require('winston-transport')` cannot be
   resolved (`workspace-case`). With `ssr.external` but no declaration, the
   build passes. Startup then fails with `ERR_MODULE_NOT_FOUND`. Required:
   - `@dbos-inc/dbos-sdk` and `@dbos-inc/vercel-ai` are direct `dependencies`
     of `studio`, even if `packages/extraction` also imports them;
   - add this line to `defineConfig` in `vite.server.config.ts`:
     `ssr: { external: ['@dbos-inc/dbos-sdk', '@dbos-inc/vercel-ai'] },`.
     Vite's default already externalizes a declared DBOS. The line pins that
     choice so a later `noExternal` cannot bundle DBOS silently.
   - Consequence: the domain `pg.Client` comes from the bundled copy and DBOS
     loads its own external `pg`. `enqueueInTransaction` only calls
     `client.query` on the client it receives (`client.js`,
     `system_database.js:811-813`). Source check only; M2's integration test
     must cover it with the real Prisma client.
2. **`DBOS.launch()` twice is not refused.** The second call returns silently
   (`dbos.js`: "Do nothing if DBOS is already initialized"), and a changed
   configuration is ignored (source). "Launch once per process" must be a guard in
   `server/dbos.ts`, not an SDK guarantee. Registering a workflow after launch
   throws `DBOSConflictingRegistrationError`. That is what Studio's current
   development host hits when it re-evaluates the server module graph
   (`dev-reload`). The planned `sync+restart` is therefore mandatory, not
   cosmetic. A host-side `pnpm dev` outside Compose needs a manual restart
   after a change to a module that registers workflows. The development host
   must never re-import such a module when it recomposes.
3. **Chat dequeue latency needs a queue setting.** On the unrestricted
   `studio` queue at the SDK default (1000 ms minimum poll), the time from
   commit to the first step was p50 402–619 ms and p95 804–845 ms over two
   20-sample runs; the maximum was 904 ms. With `minPollingIntervalMs: 100` on
   `registerQueue`, p50 was 52–56 ms and p95 91–92 ms. Queue dispatch polls only
   (`wfqueue.js`); the SDK's `useListenNotify` applies to waits, not to dequeue. Proposal: register `studio` with
   `minPollingIntervalMs: 100`. That costs about 10 dequeue queries per second
   per Studio process. `suggest` can keep the default.
4. **Conversion budget (fills "budget fixed by M0R").**
   `convertTimeoutMS(pages) = max(600_000, 3 × (20_000 + 6_300 × pages))`
   = `max(10 min, 60 s + 18.9 s × pages)`. Derivation below. It is provisional
   until the M0R 6 run on a book of about 2000 pages.

Confirmed, no change: the plan rule that repeated cancellation must target
live statuses only. A second Python `cancel_workflow` on a `CANCELLED` row
moved `updated_at` forward by 201–202 ms, because dbos 3.1.0 excludes only
`SUCCESS`/`ERROR` (`_sys_db.py:1173-1190`).

## Versions and environment

Node 24.21.0, `@dbos-inc/dbos-sdk` 5.1.10, `@dbos-inc/vercel-ai` 0.4.4,
`ai` 7.0.93, `pg` 8.22.0, Vite 8.2.0 (Studio's installed version), `tsx`
4.23.4. Python 3.13.13, `dbos` 3.1.0 (SQLAlchemy 2.1.1, psycopg 3.3.6).
PostgreSQL 17.11 in a disposable loopback container, x86_64. Every database
was a fresh `free_test_m0r_*` database, dropped afterwards. Workflows and data
were synthetic; no model, GPU or credential was involved.

## Commands

The scripts take the database from `M0R_DB_URL`, and each one refuses
anything but a loopback `free_test_m0r_*` database. From the FREE root:

```bash
set -e
M0R="$(mktemp -d /tmp/free-m0r.XXXXXX)"
cp -r docs/plans/2026-09-24-unified-durable-execution-evidence/m0r/. "$M0R/"
(cd "$M0R" && npm init -y >/dev/null && npm pkg set type=module && \
  npm install --prefix . --save-exact --no-audit --no-fund \
    @dbos-inc/dbos-sdk@5.1.10 @dbos-inc/vercel-ai@0.4.4 ai@7.0.93 pg@8.22.0 \
    vite@8.2.0 tsx@4.23.4)
# Start the disposable container as in ../README.md (FREE_REVIEW_CONTAINER), then:
for db in lifecycle admission admission_neg kei; do
  docker exec "$FREE_REVIEW_CONTAINER" createdb -U postgres "free_test_m0r_$db"
done
BASE='postgresql://postgres:review-disposable-only@127.0.0.1:5432'
(cd "$M0R/lifecycle" && M0R_DB_URL="$BASE/free_test_m0r_lifecycle" node driver.mjs)
(cd "$M0R/workspace-case" && M0R_NODE_MODULES="$M0R/node_modules" node setup-and-run.mjs)
# admission.mjs also uses "${M0R_DB_URL}_neg"
(cd "$M0R/admission" && M0R_DB_URL="$BASE/free_test_m0r_admission" node admission.mjs)
(cd "$M0R/kei" && M0R_DB_URL="$BASE/free_test_m0r_kei" \
  uv run --no-project --python 3.13 --with 'dbos==3.1.0' python kei_lanes.py)
```

Each script needs a fresh database, because workflow IDs are fixed. The
Python probe prints `DBOSAwaitedWorkflowCancelledError` tracebacks for
workflows it cancels on purpose. The `RESULT` lines and the exit code are the
outcome. Raw `RESULT` lines from the recorded run are in
[`results.txt`](results.txt).

## Results

### Item 2: in-process lifecycle (`lifecycle/`, `workspace-case/`)

`lifecycle/server/` is a small Node HTTP host shaped like Studio's
`server/index.ts`. It launches DBOS once and runs one named workflow: step A
records a row; step B records `B-start`, sleeps 8 s in `setTimeout`, then
records `B-end`; step C records a row. `vite.server.config.ts` is Studio's
file unchanged. `driver.mjs` starts each runtime, waits for `B-start`, sends
SIGKILL to the process mid-sleep, restarts it, and waits for recovery.

| Check | Observed | Plan consequence |
|---|---|---|
| (a) Studio's config, DBOS declared by the app | `dist/server/index.js` keeps `import { DBOS } from "@dbos-inc/dbos-sdk"` (4 kB bundle) | Externalized by default |
| (a) `ssr.noExternal: ['@dbos-inc/…']` | Build fails: cannot resolve DBOS's optional `@opentelemetry/api` / `winston-transport` requires | DBOS cannot be bundled as is |
| (a) noExternal, with winston/OTel set as `rollupOptions.external` | Builds (629 kB) and launches | Bundling is possible but brittle; keep DBOS external |
| (a) DBOS imported from a linked workspace package | Undeclared by the app: build fails; undeclared + `ssr.external`: `ERR_MODULE_NOT_FOUND` at startup; declared: works with or without the line | **PLAN IMPACT 1** |
| (b) `kill -9` of `node dist/server/index.js` mid-step, then restart | PENDING after the kill; SUCCESS after the restart. A ran once, in the first PID. B started twice and ended once, in the second PID. C ran once, in the second PID | Recovery works for the production bundle |
| (c) Same with `node --import tsx server/index.ts` | Same result | Recovery works in the tsx host |
| (c) Same through Vite `ssrLoadModule` (Studio's dev loader, `dev-host.mjs`) | Same result. A native `import` of the SDK sees the SSR-launched DBOS (`isInitialized() === true`), so dev SSR externalizes DBOS and there is one singleton | Recovery works in the Vite dev host |
| Explicit `name` | Two modules each declare `async function job`. In the bundle the unnamed registration is `job$1`; under tsx and Vite dev it is `job`. The named one is `namedJob` everywhere | A work item started under one build cannot be recovered by another unless it has an explicit `name`. Plan rule confirmed |
| `DBOS.launch()` twice in one process | Resolves without error (all runtimes) | **PLAN IMPACT 2** |
| Re-evaluate a workflow module after launch (dev recomposition) | `DBOSConflictingRegistrationError: DBOS code is being registered after DBOS.launch()` | **PLAN IMPACT 2** (`sync+restart` is required) |

The tsx host is started as `node --import tsx`: the `tsx` CLI forks a child
that a SIGKILL of the CLI would leave running. Recovery needs a stable
`executorID` and `applicationVersion` (here `local` and `m0r@1`). Recovery
only takes PENDING rows of the same executor and version.

### Item 3: admission (`admission/admission.mjs`)

The Studio app (`name: 'studio'`) registers queue `studio` and workflow
`chatTurn`. `chatTurn` blocks in `DBOS.recv` until the probe releases it, so
it is still live during the races. The admission client uses
`applicationName: 'studio'`. `admit()` is the `admission-races.mjs` shape:
domain row first, `enqueueInTransaction` in the same transaction.

| Check | Observed | Plan consequence |
|---|---|---|
| (a) Same turn ID twice, concurrently | `created` + `replayed`; row PENDING, `application_name='studio'`, `executor_id='local'`; runs to SUCCESS after release | Studio owns and runs the admitted workflow |
| (a) Two turns, one source revision | `created` + `rejected` (`DBOSQueueDuplicatedError`); 1 question persisted; winner runs to SUCCESS | Unchanged from `admission-races.mjs`, now with a consuming owner |
| (a) Row owned by `someone-else` on queue `studio`, Studio polling | Stays ENQUEUED (4 s) | Studio never runs another app's rows |
| (a) Row with no owner on queue `studio` | Dequeued by Studio, which stamps `application_name='studio'` | Any app may take unowned rows (plan's ownership rule) |
| (a) App `other` registers and polls a queue named `studio` (separate DB) | Owns the queue. A studio-owned row stays ENQUEUED; an unowned row is taken and stamped `other` | Wrong-name clients strand or leak work; set `applicationName` on every client |
| (b) `duplicationPolicy: 'return-existing'` inside a caller transaction | `DBOSError: … is not supported in a caller-owned transaction` (before any SQL) | Plan rule confirmed |
| (b) Same, outside a transaction, while the holder is live | Returns the holder's ID (`rx-holder`); creates no row for the new ID | Usable for non-transactional admission only |
| (c) Dequeue latency, commit → first step, 20 spaced samples | Default: p50 402 / 619 ms, p95 845 / 804 ms (two runs). `minPollingIntervalMs: 100`: p50 52 / 56 ms, p95 91 / 92 ms. Bursts of 10: 841 / 545 ms default, 63 / 37 ms at 100 ms | **PLAN IMPACT 3** |
| (d) SIGKILL after `enqueueInTransaction`, before `COMMIT` | No domain row, no `workflow_status` row, before or after Studio restarts | Rollback leaves nothing |
| (d) SIGKILL right after `COMMIT` | Row present, workflow ENQUEUED; the restarted Studio dequeues it, runs to SUCCESS | Commit is recovered |
| (d) SIGKILL after the workflow's first step, in the admitting process | PENDING, step `start` recorded; the restarted Studio (same `executorID`) recovers it. `start` ran once and `answer` once | Checkpointed step not re-run |

The latency is measured on the database clock: `clock_timestamp()` after
`COMMIT`, compared with `clock_timestamp()` in the workflow's first step.
Samples are spaced by a random 0–1000 ms so they do not lock onto the poll
phase. The SDK polls each queue from `minPollingIntervalMs` (default 1000 ms,
`wfqueue.js:460-505`) with ±5 % jitter, and backs off only on contention.

### Item 4: kei queues (`kei/kei_lanes.py`)

This runs four queues as in the plan (`kei-convert-large` 1/1,
`kei-convert-small` 1/1, `kei-extract` 2/2, `kei-gc` 1/1; global/worker),
polled every 0.1 s. The step is a native-like blocking call: a `time.sleep`
loop in the step thread, which DBOS cannot interrupt.

| Check | Observed | Plan consequence |
|---|---|---|
| Cancel right after claim, each lane (on `kei-extract` both slots are busy) | Follower stays ENQUEUED while the cancelled step is blocked; it starts 7–109 ms after that step exits. On one lane per run, our log shows the step body starting *after* `cancel_workflow` returned: most likely the step's pre-check read the status before the cancel committed (`_sys_db.py:3300-3331`) | Worker limit holds the slot; a cancel racing a claim can still start one step |
| Cancel mid-step, each lane | Same: follower ENQUEUED until the step exits | Plan's physical-capacity rule confirmed on all four lanes |
| Other lanes while one lane holds a cancelled blocked step | Quick jobs on the other three lanes finish in 0.09–0.18 s | Lanes are independent |
| Control: global limit 1, no worker limit | Follower started and finished while the cancelled step was still blocked | Worker concurrency is what holds the slot (reproduces the rev-8 review) |
| Priority on `kei-extract` (one slot free), enqueued 10a, 10b, 1a, 10c, 1b | Start order 1a, 1b, 10a, 10b, 10c | Priority 1 before 10, FIFO ties; no queue flag needed in 3.1.0 |
| Dequeue-relative `workflow_timeout` on `kei-extract` | 2 s timeout, 3.5 s ENQUEUED: still ENQUEUED, deadline NULL; after dequeue deadline − start = 1999–2000 ms; SUCCESS | Queue wait does not consume the budget |
| Deadline mid-step, both conversion lanes and `kei-extract` | CANCELLED 124–890 ms after the deadline (1 s sweep). `updated_at` falls inside a database-clock window taken around the transition. The follower stays ENQUEUED until the native step exits | Deadlines behave like cancels for capacity |
| Python cancel stamps the database clock | `updated_at` inside the `clock_timestamp()` window, with Python's `time.time` skewed +3600 s during the call | Boot boundary may compare `updated_at` with a DB-clock boot timestamp |
| Repeated cancel of a CANCELLED row | `updated_at` moves forward by 201–202 ms | Plan rule confirmed (target live statuses only) |
| Boot boundary | Before `DBOS.launch()`, read `bootTimestamp` from the DB. Cancel a blocked `kei-gc` step: `updated_at > bootTimestamp`, not eligible. SIGKILL, restart, new `bootTimestamp`: status still CANCELLED, `updated_at` unchanged and `< bootTimestamp`, eligible. The step is not re-run | `deleteRuns` eligibility rule works as specified |

Deadline mechanics in dbos 3.1.0, from the source: the deadline is set at
dequeue, from kei's Python clock (`start_time_ms + workflow_timeout_ms`,
`_sys_db.py:4861`). A sweep thread in each kei process runs every 1 s and
cancels its own application's overdue rows. It decides "overdue" with Python
`time.time()` but stamps `updated_at`/`completed_at` with the database `now()`
(`_sys_db.py:4582-4620`, `_workflow_commands.py:131-148`). Deadlines therefore
fire only while a kei process runs. The boot boundary needs only the database
stamp.

### Item 4: per-page conversion budget (derived, not run)

The inputs are from [rev-8 tests](../rev8-tests/README.md), Surya at 4 client
threads:

- Book: 40 pages and 73 crops (1.83 crops/page). Cut 108 s (2.70 s/page, serial
  CPU, before any OCR request), OCR 142 s (1.95 s/crop), total 250 s.
- Small document: 3 pages and 3 crops; 32.8 s alone. Its per-page share is
  3 × (2.70 + 1.95) = 14 s, which leaves about 19 s of fixed overhead.
- Under contention the book took 275 s (+10 %) and its cut 124 s (+15 %). The
  small document took 40.8 s (+24 %). At Surya's default width the book took
  306 s (+22 %).

Model: `PER_PAGE = 2.70 + 1.83 × 1.95 ≈ 6.3 s`, `FIXED = 20 s`. A straight
line through the two measured documents gives 5.9 s/page + 15 s, which is
consistent. Safety factor **3**, for the following reasons:
- The contention measured was +10–24 %.
- Crop density comes from one real book. A factor of 3 absorbs about 8
  crops/page at the measured speed, or a 3× slowdown at the measured density.
- The ~2000-page run (memory, cut behavior) has not been made.
- The deadline guards against runaway work; it is not a service level. It
  cancels without stopping the native step (above). An early expiry throws
  away hours of GPU work; a late one keeps only the large lane busy longer.

The floor is **10 min**: 18× the small document's contended time. It covers
the fixed overhead and short documents that land beside a large conversion's
OCR.

```text
convertTimeoutMS(pages) = max(600_000, 3 × (20_000 + 6_300 × pages))
                        = max(10 min, 60 s + 18.9 s × pages)
```

| Pages | Budget | Measured / estimated |
|---|---|---|
| 3 | 10 min (floor) | 33–41 s |
| 30 (`SMALL_DOCUMENT_PAGES`) | 10.5 min | ~3.5 min estimated |
| 40 | 13.6 min | 250–275 s |
| 2000 | 10.5 h | ~3.5 h estimated (plan) |

The floor gives way to the per-page term at 29 pages, close to
`SMALL_DOCUMENT_PAGES` = 30, so `kei-convert-small` runs effectively on the
10-minute floor. The budget is measured from kei dequeue (verified above).
The page count must be the PDF page count known at enqueue. Recheck the
constants after the M0R 6 run on a book near 2000 pages and on
`page_source=ingest`.

## Not covered

- ARM64 / the Spark (tracked separately).
- The real Studio `host.ts`, `developmentHost.ts`, Prisma client and
  Compose `sync+restart` behaviour. These are M2 acceptance tests.
- `shutdown({ deregister: true })` and in-place relaunch. The plan forbids
  them; they were not probed.
- `deleteRuns` itself. The probe checks the eligibility rule on
  `workflow_status`, not file deletion.
