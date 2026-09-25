# M0R 1 ARM64 rerun — 2026-09-26

Status: **all five focused probes reproduced the x86_64 results on ARM64.**
`fk-probe.mts` was skipped: it needs the pre-cutover FREE checkout and its
original ten migrations, and its expected failure is obsolete after the
planned schema replacement.

This is the ARM64 half of M0R 1 in the
[plan](../../2026-09-24-unified-durable-execution.md). The x86_64 results table
is in the [evidence README](../README.md#environment-and-findings).

## Environment

| Item | Value |
| --- | --- |
| Host | DGX Spark (FREE production host), `uname -m` = `aarch64` |
| Free resources before the run | 47 GB available memory, 3.2 TB free disk |
| Node | v24.21.0, `process.arch` = `arm64` (image `node:24`, arm64) |
| Python | 3.13.11, `aarch64` (image `ghcr.io/astral-sh/uv:python3.13-bookworm`) |
| PostgreSQL | 17.11 (Debian 17.11-1.pgdg13+2) on aarch64-unknown-linux-gnu (image `postgres:17`, arm64, already present on the host and not re-pulled) |
| npm pins (installed versions verified) | `@dbos-inc/dbos-sdk` 5.1.10, `@dbos-inc/vercel-ai` 0.4.4, `ai` 7.0.93, `pg` 8.22.0 |
| Prisma Next (for `probe.mjs` atomicity) | `@prisma-next/postgres` 0.16.0 (the lockfile version) |
| Python pins | `dbos` 3.1.0 (psycopg-binary aarch64 wheel) |

Staged from FREE commit `84013ee` (branch `feat/dbos-m2-m6`). The Node and uv
images were pulled for this run and removed afterwards. The production
`postgres:17` image was reused as-is so that its tag did not change under the
production containers.

## Method

Everything ran in throwaway containers. No port was published on the host.
The PostgreSQL container ran detached with a tmpfs data directory and the
synthetic password from the evidence README. Every probe container joined its
network namespace (`--network container:<pg>`), so the probes' loopback
`127.0.0.1:5432` / `free_test_*` guard was satisfied unmodified. Production
containers, compose, the production checkout, its `.env` and the secrets
directory were not touched.

The probe scripts are unmodified copies. They need `FREE_REVIEW_ROOT` for
`packages/db/src/database-url.ts` (the disposable-target guard) and, in
`probe.mjs`, for `packages/db/src/prisma/contract.json` plus
`@prisma-next/postgres/runtime` resolved from `packages/db`. Instead of the
Spark's production checkout, [`stage.sh`](stage.sh) copies just those two files
from the local worktree into a minimal `free-root/packages/db` stand-in, and
[`run.sh`](run.sh) installs `@prisma-next/postgres@0.16.0` there.

Commands (from the FREE repository root on a workstation):

```bash
STAGE="$(mktemp -d /tmp/free-m0r-stage.XXXXXX)"
bash docs/plans/2026-09-24-unified-durable-execution-evidence/m0r-arm64/stage.sh "$STAGE/free-m0r"
SPARK_DIR="$(ssh "$SPARK" 'mktemp -d /tmp/free-m0r-arm64.XXXXXX')"
scp -r "$STAGE/free-m0r/." "$SPARK:$SPARK_DIR/"
ssh "$SPARK" "bash $SPARK_DIR/run.sh"   # logs in $SPARK_DIR/logs
```

`run.sh` names every container `free-m0r-arm64-{pg,node-<step>,uv}-<epoch>`,
runs Node and uv as the invoking user, and removes its containers on exit. In
order it: installs the npm pins; starts `postgres:17` with
`POSTGRES_DB=free_test_dbos_review`; creates `free_test_dbos_races` and
`free_test_dbos_version`; runs `probe.mjs`, `admission-races.mjs`,
`stream-probe.mjs`, `version-probe.mjs` with `node`; then
`uv run --no-project --python 3.13 --with 'dbos==3.1.0' python queue_probe.py`.
All ran against one fresh database server, in the README's order.

## Results compared with x86_64

Every probe exited 0 and each key output matches the x86_64 table.

| Probe | ARM64 output | Same as x86_64 |
| --- | --- | --- |
| `probe.mjs`: admission poison | `ADMISSION_POISON {"retryResult":"not_admitted","rowExists":true}` | Yes |
| `probe.mjs`: Prisma/DBOS atomicity | `{"commit":false,"row":false,"workflow":false}`, `{"commit":true,"row":true,"workflow":true}` | Yes |
| `probe.mjs`: active dedup | `QUEUE_DEDUP {"same":true,"result":"first"}` | Yes |
| `probe.mjs`: publication crash | `CRASH_FIRST` signal `SIGKILL`; `CRASH_RECOVER` `SAVE_RESULT 2`; `REVISION_REPLAY [{"revision":1},{"revision":2}]` | Yes |
| `admission-races.mjs`: same turn | `[{"id":"same","action":"created"},{"id":"same","action":"replayed"}]` | Yes |
| `admission-races.mjs`: different turns | `different-a` created, `different-b` rejected with `DBOSQueueDuplicatedError`; `persistedQuestions":1` | Yes |
| `admission-races.mjs`: cancellation | `{"status":"CANCELLED","cancelUpdatesTimestamp":true,"dedupCleared":true,"newAdmission":"created"}` | Yes |
| `stream-probe.mjs` | `providerCalls:1`, `outerCatchSanitizedButStepContainsSecret:true`; replay ends `finish-step`, `finish` with no `error` part | Yes |
| `version-probe.mjs` | `requestBodyIn:[]`, `responseHeaderIn:[]`, `providerMetadataIn:["operation_outputs"]`; `CANCEL_SIGNAL` `hadSignal:true`, `fired:true`, `cancelToSignalMs:1001`, `providerCallsAfterWait:0`, `status:"CANCELLED"` | Yes (1001 ms on both) |
| `queue_probe.py` | `next_status: "ENQUEUED"` while the cancelled step blocks; `NEXT_RESULT following`; `NO_OVERLAP` shows `cancelled end` before `following start` | Yes |
| `fk-probe.mts` | Skipped (see status) | n/a |

As on x86_64, the Python SDK logged the awaited-cancellation traceback
(`DBOSAwaitedWorkflowCancelledError: ... blocked was cancelled`) during the
intentional cancel. The assertions and event ordering are the result. npm
reported the `@prisma-next` scope as deprecated (continued as Prisma ORM v8).
That warning did not affect the probe.

No live provider, GPU, browser or deployment behavior is claimed. This run
covers the library behavior on ARM64 only.

## Cleanup

- `docker ps -a | grep free-m0r` on the Spark returned nothing (grep exit 1).
- The Spark temp dir `/tmp/free-m0r-arm64.*` and the local staging dir were
  removed. The pulled `node:24` and uv images were removed.
- The nine production `free-*` containers were still up with unchanged uptimes.
