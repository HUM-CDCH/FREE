# Workbench and compact page navigation integration

The user authorized bringing the complete `feat/workbench-workflow-integration`
branch and compact page navigation UI directly onto `dev`.

## Reconciliation

- Remote `dev` at `152772ae055888ac389c08988ddabe392c1db7e7` is an ancestor of
  workflow integration at `bdbf208da8e7a3c7426dd878a5113c02b5cd1574`.
  The five recent dev fixes are retained by ancestry.
- Work was performed in an isolated worktree. The primary research checkout and
  its uncommitted `package.json` edit were left untouched.
- The UI commit was reconciled with the newer active-sample cancellation fix.
  Cancel, cancellation errors, running status and Reconnect remain available
  when sampling controls and page navigation are closed, including a reopened
  active sample with no next selection.
- Numbered page tiles remain visible by default in a collapsible left pane.
  `Select sample pages` reveals shortcuts and checkboxes. Hiding them preserves
  the selected pages and the Run sample action. These are the existing numbered
  navigation tiles, not rendered PDF thumbnail images.
- Integration testing exposed a required-review counter regression: optional
  decisions without Evidence were included in the total. The total now excludes
  them, consistently with the remaining count. Mixed and optional-only cases
  have regression coverage.
- The model-configuration E2E test now opens the second Connections page before
  selecting its fifth connection, matching the existing paginated UI.

## Verification

Executed on the integrated candidate on 2026-10-02:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed; two existing hook dependency warnings in `useExtraction.ts` |
| `pnpm test:unit:node` | 2,132 passed |
| `pnpm test:safety` | 28 passed |
| `pnpm test:postgres:node` | 213 passed: db 52, extraction 92, Studio 69 |
| `pnpm test:e2e` | 72 passed: main 67, recovery 5 |
| Focused App and useExtraction unit tests | 94 passed |
| Whitespace and bloat audit | Passed; no blockers |

PostgreSQL checks used a task-owned disposable PostgreSQL 17 container on
loopback port 5432 with `free_test_project_store` and `free_test_extraction`.
Both databases were migrated from empty. Browser suites owned and removed their
separate PostgreSQL/mock-OIDC stacks. The browser suite exercised Article and
Catalog review/export lifecycles, import to sample/review, same-pages re-run,
whole-source extraction and collection review, plus restart recovery.

The first browser run exposed the counter and paginated-test failures, and a
transient `ERR_NETWORK_CHANGED` workspace bootstrap failure. After the two
bounded fixes, the full suite passed, including the unchanged bootstrap test.

Claude Code Fable 5.1 reviewed the UI and cancellation reconciliation read-only,
approving it conditional on the integrated E2E passing. Its suggested exact
collapsed-pane/no-selection cancellation assertion was added and passes.

Python, real-service and live-model tiers were not rerun. Scripted model
boundaries in these tests establish deterministic integration behavior, not
extraction quality or production model performance. No production migration or
deployment was performed. Remote CI is checked separately after the push.
