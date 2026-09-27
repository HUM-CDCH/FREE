# DBOS M6 local verification — 2026-09-26

Tested tree: `feat/dbos-m2-m6` at base commit `83a43db` plus the Task 14 documentation, smoke kit, acceptance-test and test-concurrency diff committed with this record. All database targets here were disposable `free_test_m6_*` databases on `free-m1-pg`; no Spark deployment or live hosted-model run was performed. The [M6 traceability table](../plans/2026-09-26-dbos-m6-gc-docs-cutover.md#traceability-m6-acceptance--tests) maps requirements to the earlier task tests and the final gates below.

## Automated gates

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Passed. |
| `pnpm lint` | Passed with the same three existing React hook dependency warnings and no errors. |
| `pnpm test:unit` | Passed, including 1,502 Studio tests across 127 files and the parsing unit tier. |
| `pnpm test:safety` | 18/18 passed. |
| `pnpm architecture:check` | Passed. |
| `pnpm test:postgres` | Passed after applying the baseline domain migration to fresh store and extraction databases: DB 47/47, extraction 56/56, Studio 11 files / 59 tests, parsing 54/54 (1,051 deselected). The first attempt on unmigrated fresh databases failed with missing-table errors; those databases were recreated and the full command rerun. After the aggregate, the deleted-project acceptance case was extended to cover completed and cancelled extractions across boots; its focused PostgreSQL rerun passed 1/1. |
| `pnpm --filter studio build` | Passed; Vite reported the existing large-chunk advisory. |
| `pnpm test:e2e` | Passed: 60/60 default and 3/3 recovery. At the original default of 12 workers, two earlier attempts hit mock Entra callback failures (59/60 and 56/60, with two tests not run on the latter). Bounding the shared-host suite to four workers made the exact command green. This addresses the observed gate flake; it does not establish the callback's internal failure cause. |
| `pnpm --filter studio test:e2e:base-path` | 2/2 passed (ARTICLE and CATALOG lifecycles). |
| `pnpm test:service` | 13/13 passed again against the real Python DBOS worker, native PDFs and scripted model boundary. This includes four GC browser cases. |
| `pnpm test:system` | 16/16 passed after Task 9 on its isolated Compose project. A one-day self-signed certificate was generated in the ignored `.certs` directory because `mkcert` was unavailable. The stack and its volume were removed by the harness. |

## Production-bundle smoke and pool observation

Built Studio started on a fresh `free_test_m6_bundle` after the domain migration and a one-shot Python DBOS migration for `kei_dbos`. A disposable local certificate and synthetic Entra IDs supplied startup configuration; `KEI_EXP_URL` pointed at an unused loopback port. The built host registered its workflows, opened on `127.0.0.1:41906`, and `pnpm --filter studio gc:now` returned:

```json
{"workflowId":"sched-collectGarbage-trigger-2026-09-26T21:22:21.391Z","summary":{"cancelledStudio":[],"cancelledKei":[],"deletedStudioHistory":0,"keiRequest":null,"removedStagedSources":0,"removedPackages":0,"removedLeftovers":0,"failedPhases":[]}}
```

`dbos.workflow_schedules` contained `collectGarbage|collectGarbage|gc|f` (name, workflow, queue, automatic backfill). The database was empty of domain work, so this validates the production host's registration and an empty sweep; cross-process and real kei deletion behavior is covered by the PostgreSQL and service tiers.

`pg_stat_activity` grouped by user, application and state for this database showed `postgres|dbos_transact_studio_studio@1|idle|5` before the sweep. Sampling during one `gc:now` invocation (122 samples) observed per-group maxima of `postgres|dbos_transact_local_|idle|3`, `postgres|dbos_transact_studio_studio@1|active|1`, `postgres|dbos_transact_studio_studio@1|idle|5`, and `postgres||idle|1`. These are observed group maxima, not a simultaneous total or a capacity bound; the Python kei worker was not running in this bundle smoke.

## Residue and structural checks

The Task 14 case-insensitive residue search covered `prototypes`, `packages`, `scripts`, `docker`, Compose, tests, `.github`, `.env.example`, operations and architecture docs, the product README and CONTEXT, and current OpenSpec specs. Every remaining match falls into these groups:

| Match and files | Reason retained |
| --- | --- |
| `Procrastinate`, `result_version 4` in Parsing Service `docs/job-backend.md` and `docs/superpowers/specs/2026-09-21-canonical-evidence-design.md` | The first document is explicitly superseded; the second is an imported dated design. They preserve measurements and old result-shape discussion, not runtime instructions. |
| `procrastinate`, `keyring`, `dbus`, `KEI_EXP_MODEL` in `tests/safety.test.mjs`; `procrastinate` in Parsing Service `tests/test_api_reads.py` | Negative checks that removed packages, services and environment variables stay absent. |
| `retryOfId`, `ingestionKey`, `llm_inspector`, `result_version: 4` in Studio contract, route, navigation and transport tests and Parsing Service `tests/test_result.py` | Rejection and removal tests for obsolete request fields, route and result version. |
| `options.model_spec` in Parsing Service transcription and conversion tests, `options.models` in KIE and extraction code/tests, `options.modelKeys` in Studio app code/tests | Current model selection, recipe validation and key custody; the broad `options.model` pattern matches their prefixes. |
| `BatchExtractionMember` in extraction and Studio batch types, components and tests | The current batch response member type; there is no `BatchExtractionMember` persistence table. |
| `follower` in Parsing Service `tests/test_lanes.py`; `admission wait` in extraction integration test | Queue-order test variable and a concurrency assertion, not a legacy follower or admission-wait mechanism. |
| `Procrastinate` in `docs/operations/deployment.md` | The intentionally one-time clean-slate cutover instruction. |

The live Python `failures.py` module had three historical Procrastinate comments; Task 14 removed them. The search found no live `ChatTurn`, `chatTurn`, `streamChatWithModel`, `ChatTab`, `vercel-ai`, legacy lease/claim/checkpoint machinery, or obsolete configuration mode. `git diff fcda625..HEAD -- packages/db/src/prisma/contract.prisma packages/db/migrations` was empty: M6 added no domain schema or migration.

## Spark smoke kit and boundary

`m6-spark/make_scans.py` generated image-only `large41-scan.pdf` (41 pages), `small3-scan.pdf` (3) and `layout2-scan.pdf` (2) under `/tmp/free-m6-spark/`, with no text layer. They are not committed. `planted-key-scan.sh` passed `bash -n`. The read-only sections of `queries.sql` ran against the disposable bundle database with zero orphan payload rows in both DBOS schemas and the expected schedule. Its role probe was syntax-checked by substituting the restricted built-in `pg_read_all_stats` role for the Spark-only `kei` role, and observed SQLSTATE 42501 on the actual `public."projectContext"` table. The local disposable database had no `kei` login role; Task 15 checks it on the Spark.

The Spark cutover and authenticated, real-model smoke remain Tasks 15–16. They require the user's step-specific approval under the [M6 plan](../plans/2026-09-26-dbos-m6-gc-docs-cutover.md#task-15-controller-run--the-branch-to-the-spark-and-the-clean-slate-cutover); none ran during this local verification.
