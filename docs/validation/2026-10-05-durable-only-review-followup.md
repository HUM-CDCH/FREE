# Durable extraction and review follow-up

Date: 2026-10-05.
Status: local code checks passed. Infrastructure acceptance remains open.
Origin: [PR #185](https://github.com/HUM-CDCH/FREE/pull/185).
Change: [durable-only-extraction-review](../../openspec/changes/archive/2026-10-06-durable-only-extraction-review/proposal.md).

The source review covers commit `9675e9901c0c605c90e6454e0d331e39eda25fee`.
Its base is `2c4469e2098491d50c37bc0401d5f7f1f5125fe5` on `dev`.
This record adds documentation to that source commit.

Claude Code Opus 5.5 at medium effort wrote the implementation in an isolated checkout.
Codex reviewed the source and repeated the local checks after the update to `dev`.
The last Opus transcript stopped at a disk quota error after its test runs.
Codex completed this review and handoff from the saved code and check outputs.
No command ran on Spark.

## Risk dispositions

| Risk | Change | Evidence | Limit |
| --- | --- | --- | --- |
| F1: the OFF branch starts the old workflow | Delete the old execution, review, export, and worker paths. Refuse admission before work. | Gate and workflow registration unit tests pass. A source scan finds no obsolete runtime symbols. | The PostgreSQL no-write test remains unrun. |
| F2: a late save replaces a newer draft | Check the selection generation before the save advances the review. | The newer-mark, closed-review, and normal-advance component tests pass. | Browser integration remains unrun. |
| F3: Latest reviewed opens later live work | Pass both finalized versions through selection, routes, and the results view. | Same-source, cross-source, routed-cut, and ordinary live-cut component tests pass. | Both entry points still lack browser regression coverage. |
| F4: newer decisions remain unlabeled | Show selected and newer versions. Name the selected pair on Finalize. | The feedback-only lag test passes and checks the submitted pair. | PostgreSQL finalization acceptance remains unrun. |

The code has one durable execution and review path.
It adds no legacy reader or compatibility shim.
Historical migrations remain historical records.
The code preserves current extraction algorithms, producing selections, and durable history.

The fresh review also found a summary error.
A finalized Stopped, Failed, or Paused Extraction could disappear from project totals and activity.
The fix counts a finalized Extraction as extracted and reviewed.
Processing completion remains a separate fact.
The database regression also checks that a tombstoned head contributes nothing.

Source references for review:

- [Admission gate](../../packages/extraction/src/postgres-admission.ts)
- [Durable readers](../../packages/extraction/src/postgres-attempts.ts)
- [Results view and regression tests](../../prototypes/studio/src/DurableResults.test.tsx)
- [Latest reviewed entry points](../../prototypes/studio/src/App.test.tsx)
- [Project summary regression](../../packages/db/src/project-store.test.ts)
- [Pinned source protection](../../packages/db/src/garbage-references.test.ts)
- [Worker registration](../../prototypes/parsing_service/tests/test_worker_registration.py)

## Local checks

These commands run from the named package or service folder.
Use the versions in `pnpm-lock.yaml` and `prototypes/parsing_service/uv.lock`.
The local environment reused installed packages without changing the shared checkout.

| Check | Command | Result |
| --- | --- | --- |
| Studio | `vitest run --maxWorkers=3` | 1,927 passed. Three live-model tests skipped. |
| Extraction | `node --import tsx --test` with the files in the package test script | 99 passed. |
| Database | `node --import tsx --test src/*.test.ts` | 87 passed. |
| Export | `node --import tsx --test src/*.test.ts` | 10 passed. |
| Package types | `tsc --noEmit -p .` in Extraction, Database, and Export | All passed. |
| Studio types | `tsc -b --pretty false` | Passed, including API and browser test types. |
| Studio lint | `eslint` on the 89 added or modified TypeScript files | Passed. |
| Change specification | `openspec validate durable-only-extraction-review --strict` | Passed. |
| Current specifications | `openspec validate --specs --strict` | All 12 passed. |
| Diff whitespace | `git diff --check` | Passed. |

The Opus Python run used real packages from the local cache at the locked versions.
The command was `pytest -m "not postgres and not live_model"`.
It reported 1,391 passed, 72 skipped, and 85 deselected.
Tracing and xgrammar tests ran and passed.
The same environment reported 1,446 passed and 72 skipped on baseline `5fa6673359efbb1696eeb48f0747f4d70726bcb3`.
The reduced count reflects deleted tests for the old path.
The update to `dev` did not change Parsing Service source.
Earlier Python runs with a test stub do not support the final acceptance claim.

The source scan checked obsolete workflow, route, and interface symbols in tracked production files.
Examples include `RUN_EXTRACTION`, `kei-extract:`, `ResultsTab`, `postgres-reviews`, `approveRest`, and `keiRunId`.
It found no matches.
This bounded scan supports source review. It does not prove runtime recovery.

## Open acceptance work

The following checks did not run:

- Extraction, Database, and Studio PostgreSQL tests.
- Parsing Service PostgreSQL, slow, live-model, lane, and worker recovery tests.
- Playwright tests against the FREE services.
- Root Compose system and safety tests.
- Spark acceptance and release verification.

The [OpenSpec tasks](../../openspec/changes/archive/2026-10-06-durable-only-extraction-review/tasks.md) keep infrastructure acceptance open.
The main specifications now describe the durable review contract.
The change remains active until acceptance passes.

`DURABLE_RELEASE_VERIFIED` remains hard `false`.
Admissions remain OFF.
The local checks do not authorize release, merge, deployment, or admission enablement.
