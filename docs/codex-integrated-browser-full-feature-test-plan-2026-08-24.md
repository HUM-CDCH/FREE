# FREE full-feature test plan with the Codex integrated browser

Date: 2026-08-24<br>
Target: `prototypes/studio` and its same-origin APIs<br>
Primary test surface: Codex integrated browser (in-app browser)<br>
Status: execution-ready plan; no test run is claimed by this document

## 1. Objective

Verify every currently exposed FREE Studio feature as a Humanities Researcher would experience it, using the Codex integrated browser for all UI interaction and browser-visible assertions. The run must cover happy paths, validation, empty/loading/error states, recovery, persistence across reloads, concurrency-sensitive transitions, keyboard access, responsive behavior, and the integrity of durable research state.

The browser run complements—not replaces—the existing Vitest and Playwright suites. Existing automated tests are used as a risk map and regression baseline; this plan independently exercises the live product through the integrated browser.

## 2. Current implemented scope

The coverage ledger is based on the current routes, components, XState machines, API calls, and existing test suite.

| Area | Browser-visible capabilities in scope |
| --- | --- |
| Authentication | Session resolution, login, invalid login, throttling response, mandatory password replacement, logout, session expiry, retryable session/workspace load failures, safe return paths |
| Shell | Project Context rail, collapse/expand, resize, provider dialog, responsive rail behavior, session controls, loading overlays |
| Project Contexts | List, create, open, rename, permanently delete, empty/error/retry states, routed resource tabs |
| Source Documents | Multi-PDF add from rail and project dropzone, sequential ingestion queue, progress/failure/retry, filtering, sorting, open, download, permanently delete |
| Navigation | Deep links, aliases, browser back/forward, refresh, malformed IDs, missing resources, unavailable retained artifacts, Source Document tab strip and recency behavior |
| Document workspace | Retained PDF rendering, multi-page scrolling, zoom controls and keyboard shortcuts, Markdown/parsed-document indexing state, right rail collapse/resize |
| Extraction Schemas | Generation instructions, generation/stop/regenerate, field tree editing, types, allowed values, descriptions, add/remove/bulk remove, drag/reorder/nest, JSON view/edit, conversational edits with proposal review, schema naming, autosave/conflict/failure, revision history and historical preview |
| Extraction | Article strategy run, flush-before-run, pending/cancel/failure/success/rerun, persisted attempts, latest vs latest-reviewed inspection |
| Results and review | Review/JSON/Markdown/Schema views, nested-result navigation, approve/edit/reject decisions, evidence navigation, diagnostics, persistence and read-only historical inspection |
| Export | Single-result and Batch Extraction export to Excel and CSV, schema-led row choices, disabled/pending/error behavior, downloaded artifact checks |
| Batch work | History, prepare, source selection/filter/select-all/limit, existing schema editing, suggested common fields, retries/heterogeneous/conflict states, immutable run/replay/run-again behavior, progress/member statuses, member opening, export |
| Model configuration | Single-model and capability-route modes, all provider kinds, connection add/edit/remove, managed/external credentials, API-base validation, debounced probe lifecycle, model combobox, raw NuExtract eligibility, apply/reload/errors |
| Developer-only UI | Evidence diagnostics tab and LLM wire inspector when `VITE_SHOW_DEVELOPER_UI=true` |
| Cross-cutting | Accessibility, focus restoration, keyboard-only use, console errors, responsive breakpoints, base-path deployment, two-account isolation, reload durability |

### Explicit non-features / exclusions

These items must not be mistaken for missing browser coverage:

- The old Annotation tab and generic Source Document Chat tab are retired in the current UI. Schema-specific conversational editing remains in scope.
- Catalog Extraction Strategy is currently rejected/absent; the browser should expose Article only.
- Operator account creation is a CLI workflow, not a FREE Studio browser feature.
- Direct database invariants, package quarantine races, HTTP range semantics, credential redaction, and API method/body-limit behavior remain lower-level automated-test responsibilities. The browser run verifies their visible consequences only.

If product expectations still require the retired Annotation workflow described in `docs/user_stories.md`, record that as a product/spec discrepancy rather than silently marking the browser run failed.

## 3. Test architecture

### 3.1 Execution profiles

Run three profiles. A feature is not considered fully covered by a mocked browser-only result.

1. **Deterministic local profile**
   - Disposable PostgreSQL database named `free_test_browser_<run-id>`.
   - Isolated Studio config/data home so saved model configuration and canonical packages do not touch normal development state.
   - Real Studio server and real parsing boundary.
   - Deterministic local model/provider stub, or an already-provisioned deterministic model route, for fixed schema/extraction/chat responses and controllable failures.
   - Used for the complete functional matrix and repeatable screenshots.

2. **Live integration profile**
   - Real Parsing Service, canonical package storage, PostgreSQL, and one supported real model connection.
   - Used for at least one complete ingest → schema → extraction → review → export journey and one batch journey.
   - Non-deterministic model wording is not asserted; contract shape, evidence, durability, and visible state are asserted.

3. **Deployment-variation profile**
   - Production build served beneath a non-root `STUDIO_BASE_PATH`.
   - Default desktop viewport plus responsive widths.
   - Developer UI both disabled and enabled.
   - Used for asset paths, authentication redirects, route handling, dialogs, responsive rails, and inspector gating.

### 3.2 Browser operating protocol

For every scenario:

1. Start or reuse one Codex in-app-browser tab at the isolated Studio origin (normally `http://localhost:41739`).
2. Take a fresh DOM snapshot before locating controls. Prefer role, accessible name, label, placeholder, or test ID; do not depend on coordinates unless testing drag/resize/PDF canvas behavior.
3. After each interaction, collect the cheapest authoritative signal: URL, selected/checked state, visible status/alert, control enabled state, downloaded artifact, or a fresh DOM snapshot.
4. Capture a screenshot at the start of each major journey, at every unexpected state, and at the final durable state.
5. Read browser console errors after each major phase and before closing a defect.
6. For Source Document addition, start the browser file-chooser wait before clicking the upload control, verify whether the chooser supports multiple files, and pass absolute fixture paths.
7. Use browser back, forward, and reload APIs rather than re-entering URLs when the behavior under test is history or persistence.
8. Apply explicit viewport overrides only for responsive cases and reset the viewport after the case.
9. Keep a tab as a handoff only when the run spans multiple Codex turns; otherwise let the temporary test tab close.

### 3.3 Destructive and credential boundaries

- Use dedicated test accounts and disposable Project Contexts only.
- Before Codex types any test password or credential into the browser, obtain action-time approval for that specific local destination and test value.
- The final submission of a password change must be performed by the human tester; Codex can prepare the form and verify the result afterward.
- Project Context and Source Document deletion must be grouped at the cleanup stage and receive action-time approval immediately before confirmation.
- Never test against a remote database or a local database not explicitly designated for the browser run.

## 4. Environment and fixtures

### 4.1 Preflight

- Run `pnpm install` from the repository root.
- Run the normal unit/integration baseline: `pnpm test`.
- Run frontend checks: `pnpm --filter studio lint` and `pnpm --filter studio build`.
- Run the existing browser baseline: `pnpm --filter studio test:e2e`.
- Start FREE with the isolated database, config/data home, parsing service URL, origin, and base path.
- Confirm `/api/healthz` is healthy before opening the browser.
- Create test Researcher Accounts through the operator CLI, not through the browser.
- Confirm the test origin is exactly the origin configured by `STUDIO_ORIGIN`.

Record command output, commit SHA, branch, browser session name, Studio/Parsing Service versions, database name, model connection, model ID, viewport, and developer-UI setting in the run report.

### 4.2 Researcher Accounts

| Account | State | Purpose |
| --- | --- | --- |
| A | Active, permanent password | Main functional run |
| B | Active, `mustChangePassword=true` | Mandatory password replacement |
| C | Active, permanent password | Cross-account isolation |
| D | Disabled | Generic login rejection |

### 4.3 Project Contexts

| Fixture | Contents | Purpose |
| --- | --- | --- |
| Empty Project | No Source Documents or schemas | Empty states and first-use controls |
| Article Project | 3–5 varied Source Documents | Complete single-document and batch journeys |
| Large Library | At least 51 lightweight Source Documents | Filter/sort and 50-member batch limit |
| Failure Project | Disposable documents and schemas | Ingestion/model/persistence failure and deletion cases |
| Foreign Project | Owned by Account C | Account isolation and not-found presentation |

### 4.4 Source Document corpus

Use absolute paths from `examples/` for real ingestion, plus generated boundary fixtures when needed.

- Native-text, multi-page PDF.
- Scanned/image-heavy PDF.
- Complex-layout or table-heavy PDF.
- PDF with repeated records suitable for array export.
- Two PDFs with deliberately different domains for heterogeneous common-field suggestion.
- Duplicate-content PDFs with different names.
- Same-name PDFs with different content.
- Zero-byte `.pdf`.
- Non-PDF renamed to `.pdf`.
- Non-PDF with a non-PDF extension.
- Filename at the accepted boundary and over the 180-character server limit.
- PDF at the accepted size boundary and over the 50 MiB limit, generated sparsely if supported.
- Malformed/corrupt PDF.

### 4.5 Deterministic model fixtures

The deterministic provider must be able to return:

- A valid initial Extraction Schema with nested objects, arrays, scalar types, descriptions, and allowed values.
- A conversational schema edit that adds, renames, changes, and removes fields.
- A no-op proposal.
- A refused edit and a failed edit.
- A valid grounded Extraction Result with text and table Evidence anchors.
- An Extraction Result with missing fields and repeated records.
- An unreviewable result with no grounded Evidence.
- Failed and cancelled attempts.
- Per-source Batch Schema Suggestion success, one-source failure, heterogeneous result, merge success, and draft conflict.
- Slow responses so stop/cancel/supersede behavior is observable.

## 5. Entry criteria and evidence standard

### Entry criteria

- Baseline checks pass or every baseline failure is linked to a known issue.
- Test database and filesystem roots are isolated and recorded.
- Account A can authenticate.
- Parsing Service and deterministic provider are reachable.
- No browser console error exists on the clean login page.

### Evidence required for every test case

- Test ID and profile.
- Preconditions and fixture IDs/names.
- Exact browser actions.
- Expected and actual visible result.
- Final URL where routing matters.
- Screenshot for the final state or any failure.
- Console-error excerpt when present.
- Pass, fail, blocked, or not-applicable status.
- Defect link and reproduction notes for failures.

## 6. Detailed browser suites

### A. Authentication and session lifecycle

- **AUTH-01 — Initial resolution:** Open `/login`; verify “Opening FREE Studio” and “Resolving session…” can appear while session discovery is pending and Project Context UI is not rendered early.
- **AUTH-02 — Anonymous login:** Verify title, deployment guidance, labeled email/password fields, required validation, password masking, autocomplete attributes, and initial focus on email.
- **AUTH-03 — Invalid credentials:** Submit unknown account, wrong password, and disabled Account D; all must show the same “Email or password is incorrect.” message without account disclosure.
- **AUTH-04 — Throttled login:** Trigger or inject HTTP 429; verify “Too many login attempts. Try again later.” and re-enabled form after the response.
- **AUTH-05 — Login unavailable:** Stop the auth dependency or inject a server failure; verify the generic retryable unavailable message.
- **AUTH-06 — Safe deep-link return:** Enter through a valid local document and Project Context deep link, authenticate, and verify return to that route. Try an external, protocol-relative, malformed, and wrong-base return target; verify FREE chooses a safe local path.
- **AUTH-07 — Base-path login:** Repeat login with a non-root Studio base path; verify assets, API calls, redirects, and return route remain under that prefix.
- **AUTH-08 — Mandatory password replacement:** Sign in as Account B, verify the signed-in identity and new/confirm fields, password policy description, logout control, and that the project module remains unloaded.
- **AUTH-09 — Password boundaries:** Exercise empty, below-policy, exact lower boundary, over 128 Unicode scalars, and canonically equivalent Unicode values. Record the current discrepancy if the UI copy says 6 characters while the client enforces 15.
- **AUTH-10 — Password mismatch:** Verify mismatched confirmation is rejected without a request and preserves the entered values.
- **AUTH-11 — Password replacement handoff:** Human tester submits the final valid change; verify the temporary session is revoked, the login page returns with “Password changed,” the old password fails, and the new password succeeds.
- **AUTH-12 — Password-change failure:** Exercise expired temporary session, wrong temporary authority, validation failure, and service failure; verify the correct inline message and recovery path.
- **AUTH-13 — Logout success:** From a deep route, sign out and verify login notice, protected UI removal, and failed reuse of the prior browser session.
- **AUTH-14 — Logout failure/401:** Verify 401 is treated as logged out; non-401 shows “Could not sign out” and leaves retry available.
- **AUTH-15 — Session expiry in flight:** Invalidate Account A’s session while a protected page is open, then trigger a same-origin API call; verify a single transition to login with the expiry notice and no protected content leakage.
- **AUTH-16 — Session/workspace retries:** Inject session resolution and lazy project-module load failures separately; verify their distinct screens and that “Try again” retries the correct operation.
- **AUTH-17 — History protection:** After logout, use browser back/forward and direct protected URLs; verify protected content is not restored from history.

### B. Shell, rail, and global layout

- **SHELL-01 — Empty shell:** With no open Project Context, verify “No project open / Choose one from the rail,” session controls, document title, and no stale tabs.
- **SHELL-02 — Rail collapse/expand:** Toggle the Project Context rail and verify labels, preserved project markers, content width, and restored state during the current session.
- **SHELL-03 — Rail resize:** Drag the separator through minimum, middle, and maximum widths. Repeat with ArrowLeft/ArrowRight and verify `aria-valuenow` changes in 10-pixel steps and bounds are enforced.
- **SHELL-04 — Responsive rail:** At widths just above and below 860 px, verify the expanded rail auto-collapses, the workspace remains usable, and returning above the breakpoint respects the prior explicit open state.
- **SHELL-05 — Right rail:** Collapse, expand, drag-resize, and keyboard-resize the Evidence/Schema/Results rail; verify tabs remain mounted and unsent drafts survive tab switches.
- **SHELL-06 — Provider dialog:** Open from the rail gear, close with its control, Escape, and backdrop; verify focus remains sensible and no route changes.
- **SHELL-07 — Loading overlays:** Switch quickly between Source Documents; verify the old document is visibly dimmed and unusable while “Opening Source Document…” is present.
- **SHELL-08 — Browser title:** Verify “FREE Studio” without a Source Document and “FREE Studio — <document name>” when a document is open.

### C. Project Context lifecycle

- **PROJ-01 — List ordering:** Verify Project Contexts appear newest first and survive a reload with the same order.
- **PROJ-02 — Empty list:** Verify “No Project Contexts yet.” and a working create control.
- **PROJ-03 — Create validation:** Open “New Project,” verify modal focus containment, blank/whitespace/maximum/over-limit names, and disabled/enabled Create state.
- **PROJ-04 — Create cancel/focus:** Cancel with button and Escape; verify no write and focus returns to the create trigger.
- **PROJ-05 — Create success:** Create a named Project Context, verify one list insertion, acknowledged trimmed name, focus moves deliberately, and the durable record survives reload.
- **PROJ-06 — Create failure/retry:** Inject persistence failure, verify the modal stays open with the typed name and alert, then restore storage and retry successfully.
- **PROJ-07 — Rail disclosure:** Click the project name/chevron; verify it only expands or collapses Source Documents and never navigates.
- **PROJ-08 — Rail project menu:** Use “Actions for <project> → Open project”; verify navigation to `/projects/:id`, automatic expansion, and no duplicate history entry when already open.
- **PROJ-09 — Page rename:** Enter rename mode; verify save, Enter, Escape/cancel, invalid name, failure retry, preserved focus, rail/page synchronization, and persistence after reload.
- **PROJ-10 — Delete dialog cancel:** Open delete, verify destructive explanation, cancel by button and Escape, and focus return to the delete trigger.
- **PROJ-11 — Permanent delete:** With action-time approval, delete a disposable Project Context containing documents/schemas/extractions; verify navigation to `/projects`, rail removal, open-tab cleanup, and a not-found result for the old deep link.
- **PROJ-12 — List and branch recovery:** Stop/restart persistence for the global list and one expanded branch; verify bounded messages and working Retry controls.

### D. Project resource routing

- **ROUTE-01 — Canonical project URLs:** Verify Sources at `/projects/:id`, Schemas at `/projects/:id/schemas`, Extractions at `/projects/:id/extractions`, and a Batch Extraction at `/projects/:id/extractions/:batchId`.
- **ROUTE-02 — Alias:** Open `/projects/:id/documents`; verify it resolves to the Sources resource without corrupting history.
- **ROUTE-03 — Tab deep links:** Reload each resource URL and verify the correct selected tab and panel without a flash of unrelated content.
- **ROUTE-04 — Malformed identities:** Test malformed project, document, batch, and `extractionId` UUIDs; verify the invalid-reference UI and no resource request for malformed IDs.
- **ROUTE-05 — Missing Project Context:** Open a valid but missing Project Context ID; verify the bounded not-found copy and retained rail recents.
- **ROUTE-06 — Wrong containment:** Route a Source Document ID beneath another Project Context; verify “not in this Project Context” and no foreign content.
- **ROUTE-07 — Missing snapshot:** Route a contained Source Document with no durable representation; verify the non-retryable reopen explanation.
- **ROUTE-08 — Artifact unavailable:** Make the retained artifact unavailable; verify retryable open failure, restore it, and verify the same route opens on retry.
- **ROUTE-09 — Persistence unavailable:** Interrupt persistence during reopen, verify bounded error and retry, then recover without navigating away.
- **ROUTE-10 — Browser history:** Traverse Project Contexts, resource tabs, documents, and a Batch Extraction; verify back/forward restores exact routes and selected content.
- **ROUTE-11 — Superseded opening:** Start a slow reopen, navigate to another document, and complete the first request late; verify only the winning route paints.

### E. Source Document ingestion and library management

- **SRC-01 — Add from rail:** Expand a Project Context and use “Add Source Documents to <project>”; verify the multiple-file chooser, PDF filter, sequential queue, and eventual rail entries.
- **SRC-02 — Add from dropzone:** Click the dropzone and choose multiple PDFs; verify each queued card appears immediately and is replaced by one persisted Source Document only after acknowledgement.
- **SRC-03 — Drag/drop:** Drag valid PDFs over/leave/drop the target; verify drag styling, no accidental navigation, and the same queue semantics as the chooser.
- **SRC-04 — Navigate during queue:** Begin a multi-PDF queue, navigate to another Project Context/document, and return; verify queued and in-flight additions continue because the provider owns the queue.
- **SRC-05 — Sequential order:** Use a deliberately slow first PDF and fast second PDF; verify requests remain sequential and UI progress/status remains associated with the correct item.
- **SRC-06 — Duplicate content/replay:** Add identical bytes again with same and different names; verify idempotent server behavior produces no duplicate or incorrect document and leaves one coherent card.
- **SRC-07 — Invalid inputs:** Try zero-byte, corrupt, wrong type, wrong extension, overlong filename, and over-50-MiB fixtures. Verify sanitized, item-scoped errors and no durable Source Document.
- **SRC-08 — Parsing unavailable/timeout/failure:** Stop the Parsing Service, simulate a failed task, and simulate timeout; verify failed queued cards, no durable artifact, and enabled Retry.
- **SRC-09 — Retry ingestion:** Restore the service and click the item-specific Retry; verify one successful document replaces the failed card.
- **SRC-10 — Project deleted during queue:** Start a slow queue, then delete its disposable Project Context with approval; verify local queue ownership is removed and late completion cannot repopulate the deleted project.
- **SRC-11 — Library filtering:** Filter by full name, partial mixed-case name, whitespace, and no-match query; verify visible rows and “No sources match …”.
- **SRC-12 — Sorting:** Verify Newest, Oldest, and Name order with known timestamps/names; filtering and sorting must compose.
- **SRC-13 — Open:** Open from project page and rail; verify route, one open tab, PDF title, and active row.
- **SRC-14 — Download:** Trigger download, wait for the browser download event, and verify filename, non-empty PDF bytes, and `%PDF` signature without changing route.
- **SRC-15 — Download failure:** Make the retained PDF unavailable and verify a bounded inline error without a corrupt download.
- **SRC-16 — Delete cancel:** Open a Source Document delete dialog from project page and the rail context menu; cancel and verify focus/menu cleanup.
- **SRC-17 — Permanent delete:** With approval, delete a disposable Source Document; verify page/rail removal, open-tab behavior, preserved sibling documents, and not-found old deep link.
- **SRC-18 — Menu behavior:** Verify only one `•••` menu stays open, outside click closes it, right-click rail context menu closes on Escape/outside click, and menu actions remain keyboard reachable.

### F. Source Document tabs and PDF workspace

- **DOC-01 — Tab creation/deduplication:** Open several Source Documents in one Project Context, reopen one, and verify no duplicate tab.
- **DOC-02 — Activation/history:** Activate tabs with click, Enter, and Space; verify route, selected tab, breadcrumb, and browser history.
- **DOC-03 — Close active:** Close the active tab; verify the most-recently-active remaining tab becomes active.
- **DOC-04 — Close inactive:** Close an inactive tab; verify current route/content does not change.
- **DOC-05 — Close last:** Close the final tab; verify navigation to the Project Context Sources page.
- **DOC-06 — Per-project isolation:** Open tabs in two Project Contexts; verify only the routed project’s tabs appear and each project’s in-session tab state is preserved.
- **DOC-07 — Durable reopen:** Reload a document route; verify PDF, Markdown, parsed document, schema, latest attempt, and latest reviewed attempt come from one pinned durable representation.
- **DOC-08 — PDF render:** Verify page count, first and last physical page, readable native text where available, table-heavy layout, scrolling, and absence of blank/canvas-error pages.
- **DOC-09 — Zoom:** Test zoom out, zoom in, reset to 100%, Ctrl+-/Ctrl++, and min/max disabled boundaries. Verify displayed percent and preserved viewport usability.
- **DOC-10 — Indexing:** Verify “Indexing document…” during parsed-document load, normal readiness, and bounded indexing error without breaking PDF reading.
- **DOC-11 — Right-rail responsiveness:** Below 860 px, verify the right rail occupies the intended available width and remains dismissible without covering all recovery controls.
- **DOC-12 — Clipboard ownership:** Copy/paste within generation instructions and schema edit fields after reopening a Source Document; verify the PDF viewer does not steal clipboard behavior.

### G. Extraction Schema generation and editing

- **SCH-01 — Initial empty state:** Verify Schema tab guidance and that Run extraction is disabled before an extractable Current Schema Revision exists.
- **SCH-02 — Generation instructions:** Add instructions by button and Enter, add multiple items, remove each, preserve order, reject blank input, and verify count/drawer behavior.
- **SCH-03 — Generate:** Generate an initial schema, verify “Producing schema…”, slow-operation copy, Stop control, durable Extraction Schema identity/name, field count badge, and editable tree.
- **SCH-04 — Stop generation:** Stop a slow generation and verify the previous draft/view remains intact; if a cancelled initialization acknowledges late, verify durable identity remains coherent.
- **SCH-05 — Generation failure:** Return invalid/refused/provider-failed output; verify bounded error and preservation of the previous schema.
- **SCH-06 — Regenerate/reset:** Regenerate an existing schema and verify revision-chain continuity. Clear/delete the schema only after pending edits flush; if flush fails, verify the draft is not discarded.
- **SCH-07 — Rename schema:** Save, cancel, invalid/duplicate/boundary names, persistence failure, and reload durability from both document workspace and Project Context Schemas list.
- **SCH-08 — Add field:** Add a field, verify unique default naming and automatic edit mode, save with Enter/button, and cancel with Escape.
- **SCH-09 — Field types:** Exercise every exposed scalar type, object, array-of-scalar, and array-of-object. Verify child handling and JSON/schema projections.
- **SCH-10 — Allowed values:** Add/remove allowed values, reject the invalid one-value state, and preserve free-text behavior when none remain.
- **SCH-11 — Names and duplicates:** Verify trimming/normalization, blank fallback, duplicate sibling rejection, same name in different parents where allowed, and inline error focus.
- **SCH-12 — Descriptions:** Add/edit/remove field and record descriptions; blur/commit and reload to verify durability.
- **SCH-13 — Expand/select/bulk remove:** Expand/collapse nested groups, select parent/children, bulk remove, and verify selection clears cleanly.
- **SCH-14 — Drag/reorder/nest:** Reorder siblings, move a scalar into an object/array-object group, move out again, auto-scroll while dragging, reject moves into own descendants, and verify order after reload.
- **SCH-15 — Fields/JSON views:** Switch views without losing pending edits. Edit valid JSON and verify tree update; submit malformed/invalid/duplicate JSON and verify non-destructive errors.
- **SCH-16 — Autosave:** Make one edit and verify debounced save state → acknowledgement → new extractable revision. Make rapid edits and verify coalescing without lost changes.
- **SCH-17 — Save error/retry:** Interrupt persistence during autosave; verify visible error, preserved draft, disabled run, and successful retry after recovery.
- **SCH-18 — Revision conflict:** Edit the same schema in two browser tabs; save a stale draft and verify winning revision reload/conflict handling without silent overwrite.
- **SCH-19 — Revision history:** Open newest-first history, verify revision numbers/summaries, preview a Historical Schema Revision read-only, and create a new Current Schema Revision from history without rewriting history.
- **SCH-20 — History failure:** Fail list/get/create-from-history separately; verify bounded alert, retry, and intact current draft.

### H. Conversational schema editing and proposal review

- **CHAT-01 — Greeting/draft:** Verify schema-chat greeting, input draft retention across Schema/Results tab switches, Enter send, and blank suppression.
- **CHAT-02 — Request flush:** Send with pending local edits and verify the draft saves before the model request. If no durable schema exists, verify the save-first explanation.
- **CHAT-03 — Pending/cancel:** During a slow request, verify pending UI and cancel; verify “Cancelled” and that the current schema is unchanged.
- **CHAT-04 — Error/refusal/no-op:** Exercise transport error, refused, failed, and zero-change responses; verify message copy, draft restoration where appropriate, and no phantom proposal.
- **CHAT-05 — Concurrent local edit:** Change the schema while a request is running; verify the late proposal is rejected with “Schema changed … send again.”
- **CHAT-06 — Proposal rendering:** Verify additions, removals, renames/type/description changes, conflicts, unresolved dependencies, and issue badges are represented.
- **CHAT-07 — Per-change acceptance:** Toggle individual proposed changes, including dependent changes; verify preview recalculates and invalid combinations cannot apply.
- **CHAT-08 — Apply/discard:** Apply accepted valid changes and verify one coherent durable revision. Discard/cancel proposal and verify original schema remains.
- **CHAT-09 — Apply failure:** Interrupt save while applying; verify proposal/draft remain recoverable and no partial durable revision is presented as saved.

### I. Single-document Extraction lifecycle

- **EXT-01 — Run gating:** Verify Run extraction disabled while indexing, schema absent, schema save conflicted/failed, or save-for-run is active; tooltip explains the relevant gate.
- **EXT-02 — Flush before run:** Edit the schema and immediately run; verify extraction pins the acknowledged newest Schema Revision, not the stale one.
- **EXT-03 — Successful Article run:** Run against the complete Source Document; verify busy state, “Cancel extraction,” completion toast, Results tab activation, Article strategy, and one persisted terminal attempt.
- **EXT-04 — Duplicate click protection:** Double-click Run and verify a single extraction opens/runs.
- **EXT-05 — Cancellation:** Cancel a slow run; verify cancelled terminal state, no saved result, bounded toast, and rerun availability.
- **EXT-06 — Failed run:** Exercise provider refusal, invalid output, grounding failure, and transport failure; verify Results failure copy, technical details, preserved schema, and retry/rerun.
- **EXT-07 — Rerun:** Run again after success; verify a new immutable attempt, “Re-run complete” copy, and no mutation of the prior reviewed attempt.
- **EXT-08 — Reload during/after run:** Reload during an active durable operation and after completion; verify durable state resumes/reopens without duplicate execution.
- **EXT-09 — Latest vs reviewed:** After reviewing attempt 1, create attempt 2; verify the snapshot selector offers “Latest attempt” and “Latest reviewed,” and historical inspection is read-only.

### J. Results, evidence, review decisions, and diagnostics

- **RES-01 — Summary:** Verify status, strategy, field, missing, grounded, and array-item counts against the deterministic result.
- **RES-02 — View switcher:** Exercise Review, JSON, Markdown, and Schema views; verify exact pinned content and no edit controls in read-only historical inspection.
- **RES-03 — Nested navigation:** Open nested objects/arrays, use in-panel back/forward, clear/reset path, and verify breadcrumb/result path remains coherent.
- **RES-04 — Evidence links:** Use “View Evidence for <field>”; verify PDF scrolls to the correct physical page and overlay/anchor corresponding to that result path.
- **RES-05 — Text/table Evidence:** Verify both text anchors and table-cell anchors, including rotated/page-space geometry and multiple occurrences across pages.
- **RES-06 — Unavailable Evidence:** Verify missing parsed content, unplaced content, and placement diagnostics present bounded information and do not block result review.
- **RES-07 — Approve:** Approve a scalar and nested value; verify Review Decision UI, reviewed count, and persisted state after reload.
- **RES-08 — Edit:** Edit a value, save/cancel, validate type-sensitive input, verify displayed value and durable Review Decision.
- **RES-09 — Reject:** Reject and, where supported, reverse/change a decision; verify result presentation and durable audit state.
- **RES-10 — Submit/review persistence:** Complete all available Review Decisions, reload, and verify reviewed state, timestamps/status, and link to exact Evidence.
- **RES-11 — Unreviewable result:** Verify clear “no reviewable result” presentation when no grounded Evidence exists and no impossible review controls appear.
- **RES-12 — Diagnostics:** Expand Run details, extraction diagnostics, grounding batches, token counts, durations, finish reasons, calls, result paths, and failure codes.
- **RES-13 — Historical pins:** Select a prior reviewed attempt via `extractionId` deep link; verify source and schema pins, read-only decisions, and correct export schema.

### K. Single-result export

- **EXP-01 — Availability:** Verify Export is disabled without a result or without a schema and explains the relevant reason.
- **EXP-02 — Options dialog:** Open/close by button, Escape, blur/outside focus, and verify “Rows represent” options derive from repeated schema nodes.
- **EXP-03 — Repeated-field handling:** Exercise Preserve and the other exposed repeated-field policy for nested arrays; verify control description and downloaded shape.
- **EXP-04 — Excel:** Start the download, verify one `.xlsx`, expected sanitized name, worksheets/columns led by the pinned schema, row count, values, and reviewed edits.
- **EXP-05 — CSV:** Verify one `.csv`, UTF-8 encoding, header order, quoting/newlines, row count, and repeated-field representation.
- **EXP-06 — Pending/double click:** While export is pending, verify “Exporting…”, disabled duplicate submission, and exactly one download.
- **EXP-07 — Export failure:** Inject export failure; verify inline alert and successful retry without losing selected options.

### L. Batch Schema Suggestion

- **BSS-01 — Entry:** Open Extractions → New Batch Extraction; verify all Source Documents initially selected and existing Extraction Schemas plus “Suggest fields from selected sources.”
- **BSS-02 — Source selection:** Filter, select/deselect individual documents, select all/none, and verify selection count and schema-suggestion state reset when selection changes.
- **BSS-03 — 50-member limit:** Select 50 and 51 Source Documents; verify exactly 50 is allowed and over-limit messaging/button gating is correct.
- **BSS-04 — Suggest common fields:** Request with a valid selection; verify creating/suggesting busy states and per-source progress until merge.
- **BSS-05 — Partial source failure:** Fail one source; verify document-specific sanitized message, durable failed state, and retry path.
- **BSS-06 — Retry:** Retry the same suggestion after restoring the model; verify successful sources are handled coherently and one updated suggestion is adopted.
- **BSS-07 — Heterogeneous:** Use unrelated documents; verify the “No reliable common field set” message and ability to change selection or choose an existing schema.
- **BSS-08 — Ready proposal:** Verify common-field coverage, record description, field names/types/descriptions, and editable SchemaPanel draft.
- **BSS-09 — Draft autosave/reload:** Edit proposal, wait for debounce, navigate away/reload, and verify the saved draft version is restored.
- **BSS-10 — Draft conflict:** Edit the same suggestion in two tabs; verify conflict copy and “Reload saved draft,” with no silent overwrite.
- **BSS-11 — Run from suggestion:** Flush a valid draft and run; verify a durable Extraction Schema revision and Batch Extraction are confirmed atomically, then navigate to the batch.
- **BSS-12 — Run gating:** Blank record description, blank/duplicate field names, save error, conflict, zero selection, and over-limit selection must all prevent run.

### M. Batch Extraction lifecycle

- **BAT-01 — Empty history:** Verify “No Batch Extractions yet.” and New Batch Extraction.
- **BAT-02 — Existing schema selection:** Choose an Extraction Schema revision, edit its current schema if exposed, select documents, and open a Batch Extraction only after flush.
- **BAT-03 — Reuse/replay:** Submit an identical selection/schema/strategy twice without force; verify the existing batch is reopened with the replay notice rather than duplicated.
- **BAT-04 — Immutable Run again:** From members, choose Run again; verify a new Batch Extraction ID with the same pinned member set and schema revision.
- **BAT-05 — Durable members:** Verify every selected member is present up front, even before execution, and progress total never depends on browser state.
- **BAT-06 — Progress/reload:** Observe Queued → Running → terminal progress, reload mid-run, and verify server-owned counts/status resume correctly.
- **BAT-07 — Member states:** Verify queued, running, no result, failed, cancelled, no reviewable result, needs review, and reviewed labels/messages.
- **BAT-08 — Open member:** Open a member with an Extraction, verify the document deep link includes its `extractionId`, correct pinned result opens, and browser back returns to the batch.
- **BAT-09 — Disabled member:** Verify a member without an Extraction cannot navigate.
- **BAT-10 — History ordering/detail:** Verify newest-first batches, timestamp, schema/revision, member count, Article strategy, summarized status, and durable reload.
- **BAT-11 — Batch read failures:** Fail list, batch detail, pinned Schema Revision, and results reads separately; verify bounded alerts and the correct Retry control.
- **BAT-12 — Batch export availability:** Verify export disabled until at least one successful result exists, with the exact reason.
- **BAT-13 — Partial batch export:** Export a mixed batch with successful/failed/cancelled members; verify only represented results, coverage notice, source identity columns, stable schema columns, and no silent row loss.
- **BAT-14 — Batch Excel/CSV:** Exercise both formats and every schema-led option; verify names, row counts, values, source identity, and review edits.

### N. Model/provider configuration

- **MODEL-01 — Load:** Open the provider dialog; verify loading state, saved configuration, credential presence without secret disclosure, and no automatic probe merely from opening.
- **MODEL-02 — Load failure:** Corrupt or make saved configuration unreadable; verify stable backend error and close/reopen recovery.
- **MODEL-03 — Empty configuration:** Verify first-connection affordance and Apply gating.
- **MODEL-04 — Provider catalog:** Add each supported kind: Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and OpenAI-compatible. Verify transport/auth-specific fields and defaults.
- **MODEL-05 — Connection editing:** Edit name, provider, API base, and credentials; verify draft state without premature persistence.
- **MODEL-06 — API-base validation:** Test whitespace, control characters, backslashes, relative URL, non-HTTP(S), embedded credentials, query, fragment, valid path prefix, HTTP, and HTTPS.
- **MODEL-07 — Credential semantics:** For managed providers, test absent/new/replace/delete/preserve actions without reading the secret back. For external CLI providers, verify no credential field or stale credential action remains.
- **MODEL-08 — Probe lifecycle:** Verify 500 ms debounce, checking state, connected catalog, authentication failure, unreachable, not installed, invalid response, discovery failure, timeout, and manual Check/Retry.
- **MODEL-09 — Stale probe suppression:** Change provider/base/credential during a slow probe; verify late results cannot overwrite the newest draft. Remove the connection and verify pending/late probe UI is disposed.
- **MODEL-10 — Model combobox:** Open full catalog, keyboard ArrowUp/Down/Enter/Escape, type-to-filter, no matches, free-form exact ID, empty catalog, and disabled state before connection choice.
- **MODEL-11 — Single-model mode:** Choose one connection/model, Apply, close/reopen/reload, and verify both capability families use the saved target.
- **MODEL-12 — Capability Routes mode:** Configure different Extraction and Interaction routes/models, Apply, reload, and verify exact saved targets.
- **MODEL-13 — Raw NuExtract:** Verify the checkbox appears only for an eligible Extraction route/provider, never for Interaction, persists for eligible Ollama-like configuration, and is removed when the provider changes to an ineligible one.
- **MODEL-14 — Apply offline:** With a syntactically valid but unreachable connection, verify probe failure does not permanently gate Apply; saved offline/pending configuration reloads coherently.
- **MODEL-15 — Apply validation/failure:** Exercise missing names/routes/models, invalid base, save failure, and credential-store unavailable; verify bounded errors, preserved draft, and no secret in UI/console.
- **MODEL-16 — Remove referenced connection:** Remove a connection used by one/both routes; verify affected routes clear and Apply cannot save dangling references.
- **MODEL-17 — Close with draft:** Close by button/Escape/backdrop and reopen; document whether unsaved draft is intentionally discarded, and verify saved configuration remains unchanged.

### O. Developer-only surfaces

- **DEV-01 — Gating:** With developer UI off, verify Evidence tab, λ inspector launcher, and developer diagnostics are absent. With it on, verify they appear.
- **DEV-02 — Evidence tab:** Verify anchor count, physical-page grouping, text/table cards, reviewed occurrence count, diagnostics, unplaced content, no-anchor state, and click-to-PDF navigation.
- **DEV-03 — LLM inspector empty/live:** Open λ, verify empty guidance, live state, close control, and no content before a model call.
- **DEV-04 — Captured calls:** Trigger schema generation, conversational edit, extraction, and batch suggestion; verify newest-first entries and complete request/response panes.
- **DEV-05 — Redaction and failures:** Verify credentials never appear, failed/retried/streamed calls remain distinguishable, and provider errors are preserved safely.
- **DEV-06 — Copy/clear:** Copy request/response payload and verify clipboard text; clear the process-local history and verify empty state. Treat Clear as disposable diagnostic data cleanup.

### P. Accessibility and keyboard coverage

- **A11Y-01 — Landmarks/names:** Verify unique main/aside/nav/dialog/tablist/tabpanel landmarks and meaningful accessible names for all icon-only buttons.
- **A11Y-02 — Keyboard-only critical path:** Complete login, project creation, document open, schema instruction, extraction run, result review, and export without a pointer, except PDF-specific canvas interaction.
- **A11Y-03 — Focus visibility/order:** Tab through each major screen; verify visible focus, logical order, no focus traps outside modal dialogs, and no unreachable controls.
- **A11Y-04 — Dialog focus:** Verify initial focus, Tab containment, Escape/cancel, success focus destination, and failure preservation for create/delete/provider/export dialogs.
- **A11Y-05 — Tabs:** Verify role/tab semantics, selected state, associated tabpanels, Enter/Space activation, and hidden panels not exposed as active content.
- **A11Y-06 — Live regions:** Verify loading, ingestion queue, run status, retry alerts, and completion notices are in suitable `status`, `alert`, or `aria-live` regions without repeated spam.
- **A11Y-07 — Form errors:** Verify invalid controls expose `aria-invalid`/descriptions where implemented, error copy is associated, and focus remains on a repairable field.
- **A11Y-08 — Zoom and text scaling:** At browser zoom 200%, verify no critical clipping, horizontal loss, or inaccessible fixed controls.
- **A11Y-09 — Color-independent meaning:** Verify statuses and selected states have text/icons/structure in addition to color.
- **A11Y-10 — Reduced viewport:** At 1280×800, 1024×768, 859×800, and 390×844, verify login, project page, document workspace, provider dialog, result review, and export remain operable.

### Q. Security, isolation, and privacy through the browser

- **SEC-01 — Account isolation:** Authenticate as Account C and try Account A Project Context/document/schema/extraction/batch deep links; verify indistinguishable not-found behavior and no names/content.
- **SEC-02 — Session switch:** Log out Account A, log in Account C in the same browser, and verify rail, tabs, recent routes, downloaded names, and provider-visible project data do not bleed across accounts.
- **SEC-03 — Same-origin enforcement:** Attempt a protected write from an invalid origin through an isolated test page; verify rejection and unchanged FREE state. Keep this read/write check within disposable data.
- **SEC-04 — URL/data leakage:** Inspect URLs, visible errors, console, and downloaded filenames for credentials, raw provider errors, filesystem paths, package references, hashes, or foreign identifiers.
- **SEC-05 — HTML/script content:** Use document/project/schema names and extracted values containing markup-like text; verify rendering is inert and exports contain data rather than executable browser markup.
- **SEC-06 — Stale/tampered session:** Supply an expired/tampered test cookie through the isolated harness; verify cookie clearing, anonymous UI, and no protected flash.

### R. Durability, concurrency, and recovery composite journeys

- **DUR-01 — Full canonical journey:** Login → create Project Context → ingest real PDF → generate/edit schema → run Article extraction → review values/Evidence → export → reload → reopen exact reviewed attempt. Verify every durable identity remains coherent.
- **DUR-02 — Fresh-browser journey:** End the in-app session, open a fresh integrated-browser tab, authenticate, and verify Project Context, Source Document, schema order/history, reviewed attempt, and batch history from durable storage only.
- **DUR-03 — Two-tab schema race:** Concurrent edits produce one winning Current Schema Revision and an explicit conflict/reload for the loser.
- **DUR-04 — Two-tab batch draft race:** Concurrent Batch Schema Suggestion edits expose draft conflict and recover through saved-draft reload.
- **DUR-05 — Navigation race:** Slow document reopen and fast route switch never allow stale content to paint.
- **DUR-06 — Service restart:** Restart Studio and Parsing Service between ingestion and reopen; verify retained canonical artifacts remain readable and Parsing Service task cache is not required.
- **DUR-07 — Provider outage/recovery:** Fail schema/extraction work, restore the provider, and retry without corrupting the last durable schema/result.
- **DUR-08 — Database outage/recovery:** Interrupt a safe read and a disposable write separately; verify bounded errors, no partial-success UI, and correct Retry after restart.
- **DUR-09 — Base-path full smoke:** Repeat AUTH-06, PROJ-05, SRC-13, ROUTE-03, SCH-03, EXT-03, and EXP-04 beneath a non-root base path.

## 7. Recommended execution order

Run in dependency order so each phase produces fixtures for the next and destructive cleanup happens last.

1. Preflight automated baseline and isolated environment verification.
2. AUTH and SHELL.
3. PROJ and ROUTE using empty fixtures.
4. SRC ingestion and library management.
5. DOC workspace and tab behavior.
6. SCH and CHAT with deterministic provider.
7. EXT and RES.
8. EXP.
9. BSS and BAT.
10. MODEL in its isolated config home.
11. DEV with developer UI enabled.
12. A11Y viewport/keyboard pass.
13. SEC with Accounts A and C.
14. DUR composite and fresh-browser pass.
15. Live integration profile end-to-end journeys.
16. With action-time approval, destructive deletion scenarios and disposable-fixture cleanup.

For a release smoke gate, run this P0 subset first: AUTH-06, PROJ-05, SRC-02, SRC-13, DOC-07, SCH-03, SCH-16, EXT-03, RES-04, RES-10, EXP-04, BAT-02, BAT-06, MODEL-11, DUR-01.

## 8. Defect severity and stop rules

| Severity | Definition | Examples |
| --- | --- | --- |
| Blocker | Data loss, cross-account disclosure, unrecoverable corruption, or inability to authenticate/use the core journey | Foreign Source Document visible; reviewed result overwritten; canonical PDF lost |
| Critical | Core journey cannot complete or produces ungrounded/misattributed research state | Extraction pins wrong schema/source revision; Evidence opens wrong page; batch drops members |
| Major | Feature failure with a workaround, serious accessibility failure, or misleading durability state | Autosave says saved when it failed; export omits rows silently; keyboard cannot close a modal |
| Minor | Cosmetic/content defect that does not alter research state or task completion | Truncation, inconsistent copy, non-critical layout issue |

Stop the run immediately for any Blocker, any sign that the database/config root is not isolated, credentials in console/UI, or destructive targeting outside named disposable fixtures. Preserve the browser state and evidence before continuing diagnosis.

## 9. Exit criteria

The full run passes only when:

- Every in-scope test ID is Pass or has an approved, linked exception.
- All P0 cases pass in deterministic and live integration profiles.
- No Blocker/Critical defect remains open.
- No unexpected browser console error occurs on a passing path.
- All created durable state survives reload and a fresh browser session where specified.
- Account isolation cases reveal no foreign metadata or content.
- Excel and CSV artifacts are structurally verified, not merely downloaded.
- Keyboard-only critical path and all four viewport checks pass.
- The final report states which retired/unimplemented stories were excluded and why.

## 10. Run report template

```markdown
# FREE integrated-browser test report — <run-id>

- Commit/branch:
- Date/time/timezone:
- Studio origin/base path:
- Database/config/data roots:
- Parsing Service/model connection/model:
- Codex browser session:
- Profiles executed:
- Baseline commands and results:

## Summary

| Suite | Pass | Fail | Blocked | N/A |
| --- | ---: | ---: | ---: | ---: |

## Defects

| ID | Severity | Test | Summary | Evidence | Issue |
| --- | --- | --- | --- | --- | --- |

## Case results

### <TEST-ID> — <title>

- Profile/viewport/account:
- Fixtures:
- Actions:
- Expected:
- Actual:
- URL/final state:
- Console:
- Evidence:
- Result:

## Exclusions and product/spec discrepancies

- Retired Annotation tab / generic document Chat:
- Catalog strategy:
- Other:
```

## 11. Coverage-maintenance rule

Before each release run, regenerate the feature inventory from current Studio routes/components/state machines and compare it with this ledger. Add a test ID for every new browser-visible control, route, state-machine state/event, or durable workflow. Remove obsolete cases when features are removed; do not keep compatibility coverage for paths FREE no longer supports.
