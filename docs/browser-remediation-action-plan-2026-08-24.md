# FREE browser remediation action plan — 2026-08-24

## Mandate

Resolve every defect recorded by the integrated-browser run, close the coverage gaps that prevented the run from satisfying its exit criteria, and repeat the deterministic, live-model, base-path, developer-UI, security, accessibility, durability, export, and batch journeys until the full-feature test plan has a defensible final disposition.

Source material:

- Test report: `D:/progetti/FREE/docs/browser-remediation-evidence-2026-08-24/report.md`
- Test plan: `D:/progetti/FREE/docs/codex-integrated-browser-full-feature-test-plan-2026-08-24.md`
- Tested Git state: commit `baaffed8b722fee9997d6675e91eb6ea8ec09204`, branch `codex/fix-researcher-auth-review`
- Repository instructions: `D:/progetti/FREE/AGENTS.md`

The implementation is complete only when the defect matrix below is closed with regression coverage, the ordinary workspace checks pass, and the test plan is rerun with every remaining case classified from new evidence. Do not change assertions merely to make failures green: establish the intended behavior first, fix the implementation or harness at the correct layer, and retain a focused regression test.

## Working rules

1. Preserve unrelated user changes. Start by recording the exact Git state and reading the report, plan, `AGENTS.md`, and only the architecture/domain documents relevant to the subsystem being changed.
2. Use CodeGraph before text search for code discovery because this repository is indexed. Add or update tests before each behavioral fix where practical.
3. Keep fixes modular. Prefer existing dialog, schema, extraction, XState, database, and export primitives instead of introducing parallel abstractions.
4. Do not add backward-compatibility layers. Remove obsolete behavior and make database/API/UI contracts agree on the current requirement.
5. Use the disposable database and isolated config/data roots from the report for destructive or failure-path verification. Never reset a remote database or a local database other than the named disposable `free_test_*` database.
6. Keep a live defect ledger in the implementation task. For every defect record: root cause, changed files, regression test, command/browser evidence, and final status.
7. Commit in coherent workstream-sized changes. Do not leave the repository with a failing intermediate migration or partially switched contract.

Database release precondition: this pre-release branch does not support
upgrading a database that already contains duplicate Source Documents for the
same `(projectContextId, contentSha256)`. Such a database must be replaced by a
freshly initialized local database named `free`. A lossy merge of revision and
ingestion histories is intentionally excluded by `AGENTS.md`'s
no-backward-compatibility rule.

## Execution order

### Phase 0 — Establish a trustworthy automated baseline

Close `DEF-PREFLIGHT-001` and `DEF-PREFLIGHT-002` before product refactors so later failures are attributable.

- Reproduce the Vite handler-count failure in `server/app.test.ts:691`. Determine why the development client fallback is invoked ten times. Fix the extra invocation if it is unintended; otherwise replace the brittle total-count assertion with behavior-specific assertions that prove each route/fallback exactly once.
- Diagnose the authenticated Playwright bootstrap rather than masking `Workspace unavailable`. Trace the first failed workspace request, align auth/session mocks with the current lazy workspace contract, and make failures print the responsible request and response.
- Add one minimal authenticated workspace E2E smoke that reaches the empty shell, then layer the existing cases back on top.

Exit gate:

```powershell
pnpm test
pnpm --filter studio lint
pnpm --filter studio build
pnpm --filter studio test:e2e
```

All four commands must pass before Phase 7. During implementation, focused suites may be used for fast feedback.

### Phase 1 — Authentication, dialogs, project editing, and model-combobox semantics

Close `DEF-AUTH-001`, `DEF-DIALOG-001`, `DEF-PROJ-001`, and `DEF-MODEL-001` together because they share form, focus, Escape, and commit semantics.

- Password mismatch: retain both entered values, perform no request, keep focus on a repairable confirmation field, and associate the error with that field.
- Dialog primitive: implement one consistent focus contract for create/delete/provider/export dialogs—deliberate initial focus, focus containment, Escape and explicit Cancel equivalence, and focus restoration to the exact opener. Do not put dialog-specific document listeners beside a shared primitive.
- Project rename: make Enter invoke the same trimmed, validated, durable save path as the Save button. Escape must cancel without writing, and failed saves must retain the draft and focus.
- Model combobox: Escape closes only the expanded listbox. A second Escape may close the provider dialog. Preserve the draft until the dialog itself is intentionally dismissed; support ArrowUp/ArrowDown/Enter and exact free-form model IDs.

Regression coverage must include AUTH-10, PROJ-04/09/10, SHELL-06, MODEL-10/17, SRC-16, EXP-02, and A11Y-03/04.

### Phase 2 — Source ingestion correctness and privacy

Close `DEF-SRC-001`, `DEF-SRC-002`, and `DEF-SEC-001` at the server boundary, then verify the UI mapping.

- Idempotency: make source ingestion atomic per `(researcher account, Project Context, content SHA-256)`. Re-uploading the same bytes—under the same or a different filename—must return the existing durable Source Document and must not create another representation, annotation set, schema input, rail row, or queue success card. Preserve the first acknowledged durable identity/name unless the product specification explicitly chooses another deterministic rule.
- Unicode filename limit: count Unicode scalars before sanitization/truncation. Accept exactly 180 and reject 181 with an item-scoped validation error. Enforce the same contract server-side so a bypass cannot persist an over-limit name.
- Error sanitization: map parsing, storage, provider, and transport failures to stable public error codes/copy. Never expose `docling-parse`, PDFium details, local paths, task endpoints, package names, hashes, credentials, or raw upstream messages. Retain technical detail only in server logs/diagnostics that are explicitly developer-gated and redacted.
- Add database/API tests for concurrent duplicate requests, cross-project same bytes, same-name/different-content, and rollback after parser failure.

Regression coverage must include SRC-01 through SRC-09, SRC-14/15, SEC-04/05, and cross-account ownership assertions.

### Phase 3 — Schema durability, revision semantics, and conversational editing

Close `DEF-SCH-001`, `DEF-SCH-002`, `DEF-SCH-003`, `DEF-CHAT-001`, and `DEF-A11Y-002` without weakening revision concurrency.

- New-field cancel: keep an added field provisional until Save/Enter commits it. Escape/Cancel must remove the provisional node and create no durable revision. Existing-field cancel must restore the acknowledged value.
- Revision history: selecting a historical revision opens a read-only preview pinned to that revision. Provide a separate explicit action to create a new Current Schema Revision from it; never rewrite history or create a revision merely by opening the preview.
- Regeneration: keep the acknowledged current schema mounted while generation is pending. Stage generated output separately and swap only after successful validation/persistence. Stop/failure/late acknowledgement must leave the last-good schema, name, revision chain, and Run availability coherent.
- Chat concurrency: pin the schema revision/draft version at request start. Before rendering a returned proposal, compare it with the current revision and local draft identity. If either changed, discard the response and show the required “Schema changed … send again” recovery copy. Repeat the check before Apply.
- Give the chat Stop button a meaningful accessible name and visible tooltip while retaining cancellation behavior.
- Add focused tests for every field type, allowed values, duplicate names, JSON errors, autosave coalescing, two-tab conflicts, regeneration failure, historical preview, chat cancel, transport/refusal/no-op responses, dependent proposal toggles, and apply failure recovery.

Regression coverage must include SCH-04 through SCH-20, CHAT-01 through CHAT-09, DUR-03, and the schema portions of DUR-07.

### Phase 4 — Complete Results review and export

Close `DEF-RES-001` and `DEF-RES-002`, then remove the Browser-run export uncertainty with first-party automated artifact inspection.

- Add the required pinned Schema view beside Review, Raw JSON, and Markdown. It must be read-only for historical extraction pins and show the exact Schema Revision used by the extraction.
- Implement per-value Approve, Edit, Reject, and change/reverse actions using the existing `reviewDecision`/review persistence domain. Cover scalar and nested values, type-aware editing, timestamps/status, reload, historical read-only behavior, and Evidence links.
- “Save Review” must persist the exact decision set atomically and update Latest Reviewed without mutating prior extraction attempts.
- For zero grounded values, render a clear “No reviewable result” state, keep successful raw values/diagnostics inspectable, and expose no impossible per-value decision controls.
- Add Playwright download tests that capture the actual download, then parse `.xlsx` and `.csv` in tests. Assert sanitized filenames, non-empty bytes, workbook/sheet structure, UTF-8/quoting/newlines, schema-led column order, rows, repeated-field policy, reviewed edits, and exactly one file on double click.
- Cover export failure/retry and batch partial-coverage notices. Do not treat a click without byte inspection as a pass.

Regression coverage must include RES-01 through RES-13, EXP-01 through EXP-07, BAT-13/14, and the export/review portions of DUR-01/DUR-09.

### Phase 5 — Batch layout, replay ordering, and suggestion state

Close `DEF-BAT-001`, `DEF-BAT-002`, `DEF-BSS-001`, and `DEF-BSS-002` while preserving server-owned batch durability.

- Layout: ensure fixed session controls cannot cover Batch Builder actions at 1280×720, 1024×768, 859×800, 390×844, or browser zoom 200%. Give the scroll container sufficient bottom inset or place actions in an accessible sticky region. Semantic click and Enter/Space must activate Run.
- Replay ordering: an identical replay reopens the existing batch and shows the replay notice without changing `createdAt`, optimistic order, or durable newest-first history.
- Per-source suggestion failures: render source name, sanitized failure category, terminal source status, and coherent progress from `suggestion.sources[]`. Retry must preserve successful sources where the contract allows and update a single durable suggestion rather than create a duplicate.
- Run gating: derive one `canRun` decision from selection count 1–50, a valid acknowledged draft, no blank record description, no blank/duplicate field name, no pending save, no save error, and no conflict. An active invalid field editor must gate Run even if the last durable draft was valid. Enforce the same validation in the API transaction.
- Retain the passing exact 50/51-member and two-tab conflict behavior with regression tests.

Regression coverage must include BSS-01 through BSS-12, BAT-01 through BAT-14, A11Y-02/08/10, and DUR-04.

### Phase 6 — Close remaining recovery, security, and Browser coverage gaps

Use controlled dependencies and disposable data to execute the cases that the original run classified as partial or unexecuted. Add reusable test controls instead of one-off timing hacks.

- Authentication: AUTH-05, AUTH-11/12, AUTH-14, and the full base-path/unsafe-return matrix. Verify final password replacement through an automated isolated test rather than relying on an agent to submit the human-only Browser step.
- Routing/recovery: ROUTE-09/11, project/list failure retries, source timeout/download failure, schema persistence/history failures, batch list/detail/pin failures, and database outage recovery.
- Navigation races: deterministic deferred promises for document reopen, schema chat, probes, ingestion, and batch state; assert stale completions never paint.
- Security: isolated invalid-origin writes, expired/tampered test sessions, inert markup-like values in every name/value surface, and redaction in URLs, UI, logs, inspector, and export filenames.
- Accessibility: stable keyboard-only Playwright journeys, focus assertions, `axe` or equivalent automated checks where useful, 200% browser zoom, and all four viewport sizes. Keep PDF-canvas pointer interaction as the only allowed keyboard-path exception.
- Developer UI: capture schema generation, chat, extraction, batch suggestion, failures/retries/streams; verify newest-first ordering, redaction, Copy, and Clear in isolated process-local diagnostics.
- Durability: restart Studio and Parsing Service, use a fresh browser context, and complete two-tab/navigation/provider/database recovery journeys.

### Phase 7 — Full verification and handoff

1. Run the complete unit/API/database/frontend suites, lint, and production build.
2. Run the repository Playwright suite with deterministic fixtures and structural download assertions.
3. Execute the full Browser plan on isolated root, non-root base-path, and developer-UI deployments.
4. Execute the bounded live Ollama profile for all P0 model-dependent cases, not only schema/extraction happy paths.
5. Re-run account isolation after all storage/API changes.
6. Update the report with new screenshots, downloaded-artifact inspection results, exact commands, environment, commit, and a case-by-case matrix.
7. Do not declare completion while any in-scope ID is unclassified, any baseline command fails, any Blocker/Critical remains, or a P0 case lacks deterministic and live evidence.

Final commands from the repository root:

```powershell
pnpm install
pnpm test
pnpm --filter studio lint
pnpm --filter studio build
pnpm --filter studio test:e2e
pnpm --filter studio test:e2e:base-path
pnpm --filter studio test:e2e:developer
Set-Location prototypes/parsing_service
uv sync
uv run --no-sync python -m unittest discover -s tests
```

## Defect closure matrix

| Defect | Required closure evidence |
| --- | --- |
| DEF-PREFLIGHT-001 | Focused server test plus full `pnpm test` pass; explanation of the tenth fallback call |
| DEF-PREFLIGHT-002 | Authenticated empty-workspace E2E and full Playwright suite pass without shared bootstrap failure |
| DEF-AUTH-001 | Mismatch retains values, sends no request, and focuses/associates the confirmation error |
| DEF-DIALOG-001 | Create/delete/provider/export dialog matrix passes initial focus, trap, Escape/Cancel, and opener restoration |
| DEF-PROJ-001 | Enter and Save share one durable rename path; Escape remains non-writing |
| DEF-MODEL-001 | Listbox Escape does not close the provider dialog or discard its draft; full keyboard/free-form tests pass |
| DEF-SRC-001 | Concurrent and repeated same-byte ingestion yields one durable document per Project Context |
| DEF-SRC-002 | Exactly 180 Unicode scalars accepted; 181 rejected before persistence |
| DEF-SEC-001 | Public errors contain only stable sanitized copy; forbidden internal tokens absent from UI/console/export |
| DEF-SCH-001 | Cancelled new field vanishes after reload and creates no revision |
| DEF-SCH-002 | Historical selection is read-only; only an explicit create action appends a new current revision |
| DEF-SCH-003 | Failed/stopped regeneration visibly preserves the last-good current schema without requiring reload |
| DEF-CHAT-001 | Late response after local/revision change is rejected before proposal rendering and before Apply |
| DEF-A11Y-002 | Pending chat cancellation has a meaningful accessible name and keyboard activation |
| DEF-RES-001 | Schema view and durable approve/edit/reject controls pass nested, reload, and historical tests |
| DEF-RES-002 | Zero-grounded extraction shows the explicit no-reviewable state with no impossible controls |
| DEF-BAT-001 | Run remains visible and keyboard/pointer operable at every required viewport and 200% zoom |
| DEF-BAT-002 | Replay never reorders history and never creates a duplicate batch |
| DEF-BSS-001 | Per-source sanitized failure/progress and coherent retry pass with one failed source |
| DEF-BSS-002 | Every invalid/pending/conflicted suggestion state disables Run in UI and API |

## Completion definition

The goal is achieved only when all 20 rows above have implementation and regression evidence, every command in Phase 7 passes, every in-scope case in the original plan is Pass or carries a documented external/policy exception, deterministic and live P0 profiles pass, exports are structurally inspected, all viewport/keyboard checks pass, and the updated report states that the release gate passes or precisely identifies an unavoidable external blocker.
