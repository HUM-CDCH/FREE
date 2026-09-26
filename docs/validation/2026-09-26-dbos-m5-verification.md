# DBOS M5 verification — 2026-09-26

Tested tree: `feat/dbos-m5` at `fcda625` (Tasks 1–9 and their review fix rounds; M4 merged at gates 1–3, the last merge `dada69c` bringing M4's done line). Executed inline by the controller session, without subagents; each task's diff had one read-only Codex review until the user's Codex usage ended during Task 10 (the Task 9 review was already written and was applied). Databases: disposable `free_test_m5_*` on the `free-m1-pg` container; Playwright on its own Compose projects (`free-studio-m5-e2e`, `…-base-path`, `free-studio-recovery-e2e`).

## Automated gates

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Passed. |
| `pnpm lint` | Passed; the three pre-existing React hook dependency warnings, no errors. |
| `pnpm test:unit` | Passed: scripts 58, studio-configuration 4, Studio 1,457, DB 61, extraction 68, export 33; parsing 949 (72 skipped, 66 deselected) on the reused `/tmp/kei-m3-t7-venv`. |
| `pnpm test:safety` | 18/18. |
| `pnpm test:postgres` | Fresh databases: DB 42/42, extraction 55/55, Studio 9 files / 47; parsing 48/48 on fresh `free_test_m5_parsing`. |
| `pnpm test:e2e` (default suite, M5 ports) | 60/60 on the recorded run (task-10-e2e-default-2.log). One earlier run in the same hour lost a batch-review case to a login navigation timeout under load; that spec passes alone 7/7. |
| `pnpm --filter studio test:e2e:recovery` | 3/3 (task-10-recovery.log; 3/3 again after the Task 9 fix round). |
| `pnpm --filter studio test:e2e:base-path` | 2/2. |
| `pnpm test:service` | 9/9 (2.7 min) with the real kei DBOS worker and native parsing, on the existing `/tmp/kei-m3-t7-venv` reached through a temporary `prototypes/parsing_service/.venv` symlink with this tree's `src` first on `PYTHONPATH` (the harness runs `.venv/bin/python`; no new environment was created). A first run failed instantly for want of that interpreter. |
| `pnpm --filter studio build` | Passed. |
| Production-bundle smoke | Passed (below). |

## Production-bundle smoke

M4 Task 14's smoke, extended: on a fresh `free_test_m5_bundle` database the built server (`prototypes/studio/dist/server/index.js`, production environment as M4 recorded it) started, and a `DBOSClient` (`applicationName: 'studio'`) enqueued `suggestSchema` on the `studio` queue as `suggestion:<random UUID>` with a `SchemaGenerationInput` naming random IDs. Output:

```
{"workflowStatus":"SUCCESS","workflowName":"suggestSchema","output":{"ok":false,"status":404,"code":"not_found","message":"Project model context was not found."}}
```

The bundle registers M5's workflows and answers with the typed 404 (its document read finds no revision). Script: the plan workspace's `bundle-smoke.sh` (no secret printed; the session secret is generated for the run).

## Residue search

Both greps of Task 10 Step 1 print nothing: no `free-document-chat`, `streamChatWithModel`, `createPostChat`, `ChatTab`, `data-dbos-superseded`, `loadOwnedSourceMarkdown`, `readCanonicalMarkdown`, `loadOwnedSchemaModelContext`, `@dbos-inc/vercel-ai`, `chatTurn`/`ChatTurn` in `prototypes` or `packages`; no `streamText`/`streamObject` call in Studio's server code.

## Live checks (Ruling 7)

Not run in this session: no real hosted model or CLI login was configured for the worktree, and the plan review left them to the M6 cutover smoke (spec *Cutover*, step 6). The Spark's deployment vLLM exists (used for e2e runs when the laptop was overloaded) but was not used for a `pnpm dev` live check here. They remain open: a reload mid-generation and a Studio restart mid-proposal on a real model; a Schema Suggestion and an edit proposal on a CLI login; an inspection of `dbos.workflow_status` and `dbos.operation_outputs` for a real generation and proposal.

## Findings outside M5

- `e2e/model-configuration.spec.ts › mixed exact route targets are saved and reopen as saved` is a pre-existing timing flake: the typed "Use <model>" option's group depends on probe order; it fails deterministically on the Spark's Chromium (also at the pre-merge tip 59c8b60) and occasionally on the laptop under load, and passes in the recorded runs. Not in M5's files; reported to the user.

## Traceability

The plan's *Traceability: M5 acceptance → tests* table (docs/plans/2026-09-26-dbos-m5-interactive.md) maps every M5 acceptance bullet to its tests and task; the chat bullets are superseded by the user's 2026-09-26 decision to delete the document chat.
