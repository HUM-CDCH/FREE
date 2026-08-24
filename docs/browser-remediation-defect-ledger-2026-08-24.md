# FREE browser remediation defect ledger — 2026-08-24

This is the live implementation ledger for
`browser-remediation-action-plan-2026-08-24.md`. A row is closed only when the
implementation and focused regression evidence both exist. Full Phase 7
evidence and release disposition belong in the updated run report.

| Defect | Root cause | Changed files | Regression evidence | Status |
| --- | --- | --- | --- | --- |
| DEF-PREFLIGHT-001 | The development-asset list gained `/shared/authSession.contract.ts`; the test still asserted the old aggregate count instead of the exact handled paths. | `server/app.test.ts` | `vitest run server/app.test.ts vite.config.test.ts`; full `pnpm test` | Closed — `bf8e583` |
| DEF-PREFLIGHT-002 | Browser specs mocked only `/api/auth/session`; the protected lazy `ProjectNavigation.tsx` request therefore had no real server session and was redirected. | `e2e/auth.ts`, `e2e/authenticated-workspace.spec.ts`, `playwright.config.ts`, `server/playwright-auth.ts`, `vite.config.ts` | Authenticated empty-shell smoke; full Playwright: 31 passed, 2 database-profile skips after Phase 1 | Closed — `bf8e583` |
| DEF-AUTH-001 | Client-side mismatch had no field target, focus repair, or ARIA association. | `src/auth/AuthForms.tsx`, `src/auth/AuthApplication.test.tsx` | Mismatch retains both values, focuses/associates confirmation, and leaves request count unchanged | Closed — `f49d1af` |
| DEF-DIALOG-001 | Dialogs used separate native/custom dismissal paths and relied on browser restoration after React unmounted the opener relationship. | `src/ui/ModalDialog.tsx`, create/delete/provider/export consumers and browser specs | Shared modal unit test; project/create/source/provider/export Playwright focus and Escape matrix | Closed — `f49d1af` |
| DEF-PROJ-001 | Current rename is a native form whose Enter and Save paths share the same acknowledged submit; browser regression evidence was missing from the original failed bootstrap run. | Existing `ProjectContextPage.tsx`; strengthened Phase 1 browser matrix | `moves focus deliberately after successful create and rename writes` persists Enter; Escape test remains non-writing | Closed — verified at `f49d1af` |
| DEF-MODEL-001 | Combobox Escape closed its list but bubbled to a dialog-level window listener; active-option semantics were incomplete. | `src/providerConfig/ModelCombobox.tsx`, shared provider dialog, unit/E2E specs | First Escape closes list/preserves draft; second dismisses dialog/restores opener; Arrow/Enter/free-form unit coverage | Closed — `f49d1af` |
| DEF-SRC-001 | Ingestion-key uniqueness made retries idempotent but allowed the same bytes under a different key/name to create another durable document. | Source Document contract migration; `project-store.ts`; DB/API/UI regression specs | Real PostgreSQL concurrent different-key ingestion yields one document/representation; repeated API requests return one identity; cross-project same bytes and same-name/different-content remain distinct as required; full Studio and Playwright suites pass | Closed — `65162a3` |
| DEF-SRC-002 | The API sanitized and silently truncated the UTF-16 filename instead of rejecting the pre-sanitization Unicode-scalar overflow; the client had no item validation state. | `shared/sourceDocumentFilename.ts`; ingestion API/machine/provider/page and specs | API and browser accept 180 astral Unicode scalars and reject 181 before parser/package/store work; rejected card is item-scoped and non-retryable | Closed — `65162a3` |
| DEF-SEC-001 | Parser task failures, package-cleanup logging, credentialless provider probes, and model errors serialized raw upstream paths, hashes, messages, or bodies. | `_http.ts`, `_model.ts`, `_provider.ts`, `modelConfig.contract.ts`, `source_documents.ts` and regression specs | Stable parser operation copy; forbidden-token scan covers `docling-parse`, PDFium, local path, task endpoint, and 64-character hash; provider/model responses no longer expose `upstream`; full Studio and Playwright suites pass | Closed — `65162a3` |
| DEF-SCH-001 | Add Field inserted and committed `nyt_felt` before the inline editor opened, so Escape/Cancel only closed the editor after a durable mutation. | `SchemaPanel.tsx`, component/workspace regression specs | New nodes remain component-local until Save/Enter; Escape and Cancel produce no edit/POST, while Save/Enter each produce one coherent edit; existing-field Escape remains non-writing | Closed — `969b309` |
| DEF-SCH-002 | History selection called create-from-history directly, coupling a read with two flushes and a new revision. | `currentSchemaRevision.ts`, `SchemaPanel.tsx`, controller/component/workspace/database-browser specs | Selection performs one GET and no edit/flush/POST, renders a read-only pinned preview, and only the separately labelled create action appends; create failure retains the preview and intact current draft | Closed — `969b309` |
| DEF-SCH-003 | Regeneration replaced the editor draft before persistence acknowledged it, and the render-state priority hid an existing schema behind generating/failed panels. | `currentSchemaRevision.ts`, `schemaSaveCoordinator.ts`, `SchemaPanel.tsx`, controller/component specs | Pending, stopped, failed, and late-response cases keep the acknowledged draft and extractable revision mounted; the candidate appears only after save acknowledgement; full Studio build and tests pass | Closed — `969b309` |
| DEF-CHAT-001 | The request fence compared only the `schemaNodes` array reference, so record-description or revision-only changes could admit a stale proposal or stale Apply. | `currentSchemaRevision.ts`, `SchemaPanel.tsx`, `useSchemaProposalReview.ts`, component specs | Whole-draft version plus pinned Schema Revision identity are checked after request flush, before proposal rendering, and before Apply; description-only races are rejected on both paths | Closed — `969b309` |
| DEF-A11Y-002 | The pending chat control exposed only a square glyph and cancellation recognized only abort objects inheriting from `Error`. | `SchemaPanel.tsx`, component spec | Focusable native button has accessible name/title `Stop schema edit request`; activation aborts structurally identified `AbortError` values, reports `Cancelled.`, and restores the enabled input | Closed — `969b309` |
| DEF-RES-001 | Review persistence was keyed only by Evidence anchor and the browser exposed no value actions; the latest result also projected through the mutable current schema. | Review contract/schema migration and Extraction module; `useExtraction.ts`, `reviewDecisions.ts`, `ResultValue.tsx`, `ResultsTab.tsx`, `App.tsx`; focused and real-browser specs | Exact path-keyed approve/edit/reject decisions validate against the pinned scalar type, persist atomically with timestamps, support shared anchors and replay/conflict, project edits/rejections into display/export, reload read-only, and expose the exact pinned Schema Revision. Focused Studio: 55 passed; PostgreSQL Extraction: 15 passed; live browser captured one XLSX on double-click plus CSV and structurally verified filenames, UTF-8, quoting/newlines, schema order, repeated fields, row count, and reviewed edits. | Closed — `f63ccef`, `c51e0d4` |
| DEF-RES-002 | Review availability was derived from the attempt flag rather than actual grounded value coverage, so a zero-Evidence success offered misleading review copy. | `useExtraction.ts`, `ResultsTab.tsx`, controller/component/live-browser specs | Zero-grounded extraction renders `No reviewable result`, keeps Raw JSON and diagnostics accessible, exposes no Save Review or per-value controls, and is covered in the disposable-database browser lifecycle. | Closed — `c51e0d4` |
| DEF-BAT-001 | The fixed researcher-session control could cover the Batch Builder's bottom action at reduced height/zoom. | `ProjectContextPage.tsx`; deterministic Playwright Batch Builder viewport/keyboard cases | The project scroll region now has a session-safe bottom inset. Real Chromium proves Run is enabled, within the viewport, and non-overlapping at 1280×720, 1280×800, 1024×768, 859×800, 390×844, and CSS 200% zoom; pointer coverage remains in the canonical batch/export case and Enter/Space each issue one semantic POST. | Closed — `6c3c34b` |
| DEF-BAT-002 | Optimistically recording a replay always prepended it, contradicting durable newest-first ordering; replay also returned to history instead of opening the existing batch. | `BatchExtractionsPanel.tsx`; component replay-order case; PostgreSQL batch replay contracts | Replayed batches are identity-replaced and sorted by immutable `createdAt`/ID, routed open directly with an explicit notice, and never force or duplicate. Component tests preserve an older replay's order; PostgreSQL concurrent handoff/replay tests preserve one durable identity. | Closed — `6c3c34b` |
| DEF-BSS-001 | Suggestion failures exposed only failed rows and their stored message, with no coherent all-source progress; retry preservation lacked end-to-end evidence. | `BatchExtractionsPanel.tsx`, `_project_operations.ts`, project-store retry; component/worker/PostgreSQL tests | Every selected source now shows its name and queued/running/complete/failed terminal state, aggregate progress derives only from `suggestion.sources[]`, and failures render a code-derived category without the stored provider message. Retry updates the same durable suggestion, preserves completed source definition/timestamps, resets only failed sources, and the worker skips completed checkpoints. | Closed — `6c3c34b` |
| DEF-BSS-002 | Run gating duplicated a partial draft check and could accept an uncommitted invalid field editor, pending/failed save, or a draft that bypassed client validation. | shared batch limit and executable-draft parser; XState machine; `SchemaPanel.tsx`; suggestion-to-batch transaction; UI/contract/machine/PostgreSQL/two-tab Playwright tests | One UI `canRun` combines the shared 1–50 selection boundary, valid suggestion definition, XState `snapshot.can(run.requested)` (clean acknowledged draft only), no local editor/proposal work, no opening run, and no confirmation. Run is no longer accepted from dirty/saving/save-failed/conflict states. The atomic database handoff revalidates the same draft and member limit before creating schema/batch rows. Tests cover 50/51, blank/duplicate drafts, pending local edits, save failure, and two-tab conflict/reload. | Closed — `6c3c34b` |

## Phase 6 coverage closure

Commit `f241ea6` closes the original run's remaining partial/unexecuted Browser
coverage with deterministic controls instead of human-only submissions:

- authentication outage, password boundary/replacement, logout retry, unsafe
  return targets, tampered sessions, and non-root return routing;
- project/source/database recovery, exact PDF download-byte inspection, deferred
  navigation races, batch list/detail/result/pin retry paths, and fresh-context
  durability;
- inert markup-like values, public/console/inspector/filename redaction, isolated
  invalid-origin writes, and production gating of the developer inspector;
- keyboard-only composite flows, exact focus restoration, 200% zoom, and
  1280×800, 1024×768, 859×800, and 390×844 viewport checks; and
- root/non-root canonical lifecycles, developer inspector ordering/Copy/Clear,
  plus a real Ollama P0 profile for catalogue discovery, schema generation, and
  extraction.

Focused evidence before Phase 7: Studio Vitest with the named disposable
database (82 files, 797 passed, 5 skipped), export package (33 passed), recovery
and accessibility Playwright (27 passed), developer-UI Playwright (1 passed),
non-root canonical Playwright (1 passed with structural XLSX/CSV inspection),
and live `qwen3.8:latest` (3 passed; extended capture cases intentionally
skipped without the optional authorized capture).

## Phase 7 release gate

Verified implementation/evidence tip `d8d6436` passes every mandated command,
the root and non-root canonical database profiles, schema-order restore,
developer-UI isolation, account/session isolation, and the bounded live Ollama
P0 profile. The audited final report classifies all 210 plan IDs and records a
**PASS** release disposition at
`artifacts/browser-test-20260824-0138/report.md`.
