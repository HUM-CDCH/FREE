# PR 188 independent review follow-up

Date: 2026-10-06 (Europe/Rome). Status: **A–D implemented; requested Python
tiers and deterministic checks below passed on Baratheon. Full merge acceptance
remains open in the active OpenSpec tasks.**

This records the repair verification phase. The subsequently completed
[Baratheon merge acceptance](2026-10-06-pr188-merge-acceptance.md) supersedes
the remaining-acceptance status below; the original results retain their source cuts.

Review: `/tmp/free-pr185-opus55/opus-review-a7a0919b.md` and its adjacent JSON,
against `a7a0919b235c877d7c4e044aabb42953f6c9e2e4`.
Verified implementation commit: `b6b3cbe2e8c755585db135050494400867dfb942`.
PR: <https://github.com/HUM-CDCH/FREE/pull/188>.

The reviewed checkout is `/tmp/free-pr185-opus55/repo`. Verification used the
separate native ARM64 checkout
`/home/geba/Projects/FREE-pr188-review-fixes-20261006` on `baratheon` /
`spark-a892`, with its own frozen Node installation and Python 3.13 environment.
Baratheon's tracked source was verified identical to the implementation commit.
Production `/srv/free/checkout`, its database, images and services were not changed.

## Findings addressed

Section A was implemented before B–D:

| Finding | Result and regression |
| --- | --- |
| A1 | Durable batch identity includes the protocol; headless-only batches are omitted. PostgreSQL seeds the occupied historical hash and admits/replays an independent durable batch. |
| A2 | Selection identity checks use the raw schema tree. PostgreSQL saves nonempty Article identity fields and still refuses nonexistent fields. |
| A3 | Workspace monitoring survives Results unmount and older review inspection; terminal reports share one updater. App tests cover collapsed, older-review and open-latest Results, and clicking Review now selects the latest attempt. |
| A4 | Run and its handler use latest-attempt eligibility; the hook refuses resumable latest attempts while preserving schema-draft flushing. |
| A5 | Uncertain re-runs retain their descriptor and identity, show an alert/toast and Reconnect, and offer an explicit original-request retry. App tests change the page after POST 502 / GET 404 and prove the retry posts identical inputs and ID. |
| A6 | Real-process Python fixtures run authored migrations and production role provisioning, then boot restricted workers. Capability, permission and protocol-refusal checks use PostgreSQL. |
| A7 | Deployment documents drain/cancel of both deleted functions with pinned native clients, stopped writers and a mandatory zero-active-row recheck; optional terminal cleanup is an explicit operation. |
| B | Added ID/method/context/locked-supersession refusals, equal-selection replay and suggested-batch rollback including schema counts and suggestion pointers. Added wrong-anchor occurrence ownership, worker-produced Evidence compatibility, fenced GC history and missed cancellation recovery, monitor replacement fences, pinned-schema Retry and invoked password-redaction doubles. |
| C | Completion survives Stop/adoption through attempt history, including batch totals. Headless IDs return conflicts. Invalid schemas map to 422. Summary reads use sequential current-version groups, bulk metadata and lightweight summary validation; a real PostgreSQL test checks the current cuts and checkout count. |
| D | Updated current contracts, ADR supersession, pipeline/onboarding pointers, verification claims, comments and proposal impact. Effective model/settings/protocol history is shown per producing selection. Removed the undefined-column fallback. Exact-candidate Spark acceptance is an explicit merge prerequisite. |

There is no admission release flag, environment switch, disabled-admission
response, historical reader/shim, or deleted-workflow stub registration.
The new batch `completed` field is required and produced from durable history;
it has no compatibility default.

## Executed checks

Logs are retained under the Baratheon checkout's
`artifacts/review-verification/`. Test configuration and credentials are not
committed. `FREE_SKIP_PYTHON` was unset during verification.

| Command / tier | Result | Log |
| --- | --- | --- |
| `pnpm typecheck` / `pnpm lint` | Passed | `typecheck.log`, `lint.log` |
| Node units | Scripts 65, configuration 4, db 88, extraction 97, export 10 passed | `node-unit.log` |
| Final `pnpm --filter studio test` | 1,947 passed, 174 files | `studio-unit-final.log` |
| `pnpm --filter parsing-service test` | 1,397 passed, 72 optional-fixture skips, 86 tier deselections | `python-unit-final.log` |
| Python `test:postgres` | 45 passed; 18 durable fixture cases deferred to the wrappers below | `python-postgres.log` |
| Python `test:recovery` | 5 passed, no skips | `python-recovery.log` |
| Python `test:service` | 1 passed, no skips; real restricted worker and native parsing API | `python-service.log` |
| Native durable lifecycle/recovery wrappers | All 13 lifecycle and 5 crash cases passed; two wrapper checks, no skips | `extraction-native-lifecycle-recovery.log`, also final aggregate |
| Expanded worker startup/redaction file | 23 passed, 3 PostgreSQL cases deselected | `python-worker-boot-final.log` |
| Final `pnpm test:postgres:node` | Db 57, extraction 15, Studio 63 passed | `node-postgres-final.log` |
| `pnpm test:safety` | 29 passed | `safety-final.log` |
| Final durable Playwright suite | 18 passed | `browser-durable-final.log` |
| Real-service Playwright suite | 13 passed; two live-model cases and one private scanned-PDF case skipped | `browser-service.log` |
| OpenSpec strict change / all main specs | Passed / 13 passed | Local CLI output |

The standalone Python PostgreSQL tier's 18 skips are **not unexecuted recovery
coverage**: Node provisions their durable coordination fixtures and runs all
18 cases with the actual worker dependency image and this checkout's mounted
Python source. The final aggregate runs these wrappers again without skips.
The frozen Python source manifest differs from the final source only in
`tests/test_worker_boot.py`; that expanded file was separately run and is also
covered by the final fast Python tier.

Disposable targets used only `postgres` on loopback port 5432 with
`free_test_pr188_*` / guarded per-case `free_test_*` names. Python worker roles
were unique per case and removed by fixture cleanup. Outage tests used the
task-owned `free.test=parsing` container. The previous disposable server was
first checked idle and preserved; after verification it was restored and
reported accepting connections. The task container remains stopped.
Browser stacks removed their own containers and volumes. Production Studio,
Parsing API and PostgreSQL remained healthy, and the production worker running.

## Corrections during verification

Initial local checks hit filesystem quota errors; only the disposable
checkout's generated dependencies were removed. A partially written test was
restored from the frozen remote copy and then passed the complete Studio suite.
The first aggregate PostgreSQL launch lacked the db tier's correctly named
environment variable; final targets were freshly provisioned and migrated.
An admission regression initially supplied an invalid saved-configuration
fixture; it now validates the complete fixture before testing the locked race.
Two new App assertions initially read a remounted Results header synchronously;
they now await it. The wrong-occurrence fixture initially had only one anchor;
it now contains two valid anchors/occurrences. A shared GC assertion now protects
its held conversion explicitly while allowing unrelated eligible history.
The final complete relevant suites passed after these corrections.

Scoped independent source reviews found and resolved the Review now inspection
handoff and original-request retry gaps. A bounded simplify-and-harden pass found
no remaining concrete defect in the reviewed changes.

## Remaining merge acceptance

The current-source full Compose `test:system`, complete standard/recovery browser
matrix, live-model Article/unified acceptance and final independent candidate
review remain tracked in
[the recorded tasks](../../openspec/changes/archive/2026-10-06-durable-only-extraction-review/tasks.md).
Earlier dated evidence is historical and is not counted as acceptance of this
candidate. The PR remains Draft. No merge, archive or production deployment is
part of this verification.
