# Durable extraction risk resolution

Date: 2026-10-05.
Runtime source commit: `43dc5d2e8aeaf5e2222d5cebd924de9a199e7354`.
Base: `2c4469e2098491d50c37bc0401d5f7f1f5125fe5`.
Draft PR: [#188](https://github.com/HUM-CDCH/FREE/pull/188).

The implementation admits durable Extractions directly.
It has no admission release flag or environment switch.
Merging this code removes the admission block.
The PR remains a draft.
Spark acceptance and final independent review remain open.
No command ran on Spark.

## Changes and evidence

| Risk | Resolution | Evidence |
| --- | --- | --- |
| F1: a second execution and review path | Delete the old paths and the complete admission gate. Admit durable work directly. | PostgreSQL checks cover single, batch, suggested batch, replay, and enqueue rollback. Compose observes HTTP 201 and COMPLETED. |
| F2: a late save loses a newer draft | Retain the newer selection and draft when the earlier refresh returns. | Component checks and the new browser regression pass. |
| F3: Latest reviewed opens later live work | Route both finalized versions through both entry points. | Same-source and new-source browser regressions pass, including reload. |
| F4: older decisions are not labeled | Name selected and newer versions. Finalize the named pair. | The browser regression shows newer decisions and records the older selected pair. |

The admission check found a batch schema error.
The initializer received a tree with an extra `recordScope` property.
The handoff now passes the plain tree.
The initializer adds the scope after admission validates the strategy.

The worker also had a separate coordination switch.
Compose did not set that switch.
The worker now prepares coordination before DBOS launch.
It closes the pool before process exit.
Startup failures close the pool before DBOS starts.
Worker tests check startup order, cleanup, interrupts, and password redaction.

The Compose restart check found a subnet collision.
The test now reserves separate app and proxy subnets.
Test startup also refuses to reuse an existing server.
These changes affect the disposable test stack.

## Verification

[CI passed](https://github.com/HUM-CDCH/FREE/actions/runs/37332737953/job/111839663099) on the source commit above.
The CI logs report:

- Studio unit and component checks: 1,926 passed.
- Database unit checks: 87 passed.
- Extraction unit checks: 96 passed.
- Export unit checks: 10 passed.
- Safety checks: 29 passed.
- Database PostgreSQL checks: 57 passed.
- Extraction PostgreSQL checks: 12 passed, two native checks skipped.
- Studio PostgreSQL checks: 62 passed.
- Standard browser checks: 71 passed, four skipped.
- Recovery browser checks: five passed.
- Durable review browser checks: 18 passed.

Separate local runs covered the two native checks skipped by CI.
All five crash faults passed.
The lifecycle check passed for Article, generic, recipe, and unified methods.
It covers Pause, pending Resume cancellation, Resume, Stop, Retry, and queued lane release.
The first lifecycle invocation preceded PostgreSQL readiness.
The repeated invocation passed after readiness.

The local Compose contract passed all 15 checks.
A new Extraction returned 201 and reached durable COMPLETED.
The test reads saved values from the durable values endpoint.
It preserves those values through restart.
Deletion and garbage collection also passed.
It uses real parsing, DBOS, Studio, and PostgreSQL with scripted model replies.

The Python fast suite passed 1,395 checks.
It skipped 72 checks and deselected 85 PostgreSQL or live-model checks.
The worker startup file passed 21 checks.
The source uses real dependencies from the local cache.

The real-worker browser suite completed with six passed and one flaky check.
The flaky bounded-guidance check passed on retry after a local write quota error.
Two live-model checks skipped.
The suite covers all four worker lifecycles, full and bounded guidance, and project deletion.
Its test now uses the current Finalize button.
This final follow-up changes that test and validation records.
It does not change the verified runtime source.

Package typechecks and Studio lint passed.
The change and all 13 current specifications passed strict validation.
The source scan found no admission gate symbols or disabled-admission handling.
The dated plan and validation records remain unchanged.

Some local browser runs encountered network changes and write quota errors.
Those runs do not replace the passing CI result.
Their outputs remain in the local evidence folder.
The installed local Chrome differs from the browser version requested by Playwright.
The matching browser download also reached the write quota.

## Remaining acceptance

Spark checks, live model checks, and final independent review remain open.
The active OpenSpec change remains unarchived.
Passing local checks does not authorize merge or deployment.

The private inspection app shows the complete committed diff and full source.
Its review choices remain in browser storage for this commit.
The app does not approve or merge the PR.

## Reproduction and local evidence

Use the disposable targets required by the root README.
The local wrapper uses an owned container network to expose loopback PostgreSQL.
It does not target an existing FREE database.

The recorded package commands are `pnpm test:postgres` for Database, Extraction, and Studio.
The native checks also require the task-built Parsing worker image.
The root contract uses `pnpm test:system` and `pnpm test:safety`.
The browser commands use the standard, recovery, durable, and service Playwright configurations.
The local service browser selects `durable-service.spec.ts` with scripted model replies.
The Python fast tier uses `pytest -m "not postgres and not live_model"` with real locked dependencies.

Local outputs are in `/tmp/free-pr185-opus55/logs/`:

- `remaining-postgres-all-ungated.log`: all Node PostgreSQL tiers.
- `remaining-admission-ungated.log`: admission and durable reader checks.
- `remaining-native-worker-postgres.log`: all crash faults and the initial lifecycle readiness failure.
- `remaining-native-lifecycle.log`: the successful lifecycle run.
- `remaining-system-verified.log`: all 15 Compose contracts.
- `remaining-python-fast.log` and `remaining-worker-boot.log`: Python and startup checks.
- `remaining-service-verified.log`: service browser results and the local quota failure.
- `remaining-ci-source.log`: the complete passing CI output.

The private inspection app includes these outputs and the committed source diff.
This record adds evidence without changing the earlier dated records.
