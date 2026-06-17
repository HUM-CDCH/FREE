## Context

The Results tab in `prototypes/mine/pdf-render` is currently a per-field review workstation: ~500 lines across `ResultsTab.tsx`, `extraction.ts`, `useExtraction.ts`, and `ExportModal.tsx` implement accept/edit/reject decisions, a pending-field stepper, schema-staleness tracking with decision-preservation across re-runs, and scoped JSON/CSV export.

For the current prototype the only goal is to *see what the model extracted* and iterate on extraction quality. The review apparatus is over-engineered for that. The proposal commits to replacing it with a read-only, pretty-printed JSON dump and deleting everything that existed only to support review and export.

This is a mechanical, deletion-heavy change confined to the frontend. No backend, API, or data-model changes. `requestExtraction` in `api.ts` is unchanged.

## Goals / Non-Goals

**Goals:**
- Results tab shows the latest extraction result as pretty-printed, read-only JSON.
- Delete all code that exists solely for review (decisions, stepper, staleness/ghosts) and export (modal, builders, scopes).
- Keep the existing run / running / error / re-run flow working.
- Net reduction in line count is the success signal — favor deletion over abstraction.

**Non-Goals:**
- No collapsible/syntax-highlighted JSON tree (explicitly chose the simplest viewer).
- No in-app value verification (accept/edit/reject) — removed, not relocated.
- No export of any kind (JSON or CSV download).
- No new dependency.

## Decisions

**1. Pretty dump over a tree viewer.** Render `JSON.stringify(result, null, 2)` inside a scrollable `<pre>`. This is the smallest possible viewer and adds zero dependencies. Alternative considered: a collapsible tree (hand-rolled or a lib) — rejected because it reintroduces the complexity we are removing.

**2. Reuse the existing `<pre>` styling.** `ExportModal.tsx:118` already renders exactly this preview (`scrollbar-subtle … font-mono … whitespace-pre`). The new viewer adopts that styling so the look is consistent and the modal can be deleted without losing its one useful element. Alternative: invent new styling — rejected, no reason to.

**3. Keep the streamed raw text for the running state.** `useExtraction` already accumulates `state.raw` from the extraction stream. While `status === 'running'`, the viewer shows that raw text live; on `ready` it shows the pretty-printed parsed result. This keeps in-flight feedback for free. Alternative: a plain spinner — rejected as a minor regression in feedback for no code savings.

**4. Collapse `extraction.ts` to the request/parse path.** Delete the entire unit/group type model (`ResultUnit`, `EntityGroup`, `ExtractionRun`, etc.), `buildRun`, `templateSignatures`, `preserve*`, `unitState`, `ghostPaths`, `reviewProgress`, all `decide*`/`acceptPending*`/`bulkAccept*`, and every export builder (`buildExportData`, `buildExportCsv`, `exportCounts`, `setNested`). What remains is whatever is needed to type the extraction state and hold the parsed result.

**5. Reduce `useExtraction` to run + state + result + raw.** Remove `stepIdx`, `arrayOpen`, `editingId`, `draft`, `exportOpen`, `pending`, `progress`, `ghosts`, `allReviewed`, `bulkCount`, and every decision/stepper/export function. Retain `runExtraction`, the `idle/running/ready/error` state, the parsed result, the raw stream, `canRun`, and `hasResults`.

**6. Simplify the dependent UI.** `RightRail.tsx` results badge drops the pending-count / ✓-done logic in favor of a simple has-results indicator (or none). `App.tsx` removes the `ExportModal` mount and any button state derived from `needsRerun` / `allReviewed`; `canRun` reduces to "schema ready and not currently running."

## Risks / Trade-offs

- **Loss of verification and export** → Accepted explicitly in the proposal. The JSON is on screen and can be copied; this is a prototype.
- **Result shape** → The existing `/extract` contract already guarantees an object: `decodeExtractDone` in `api.ts` throws on a non-object, and the backend's structured mode raises rather than returning a non-object. The viewer therefore renders an object via `JSON.stringify` and adds no special handling for other JSON value shapes. Supporting non-object results would require loosening that decoder and is explicitly out of scope (would contradict "no API/backend changes").
- **Streaming raw text is partial/invalid JSON mid-flight** → Intentional: during `running` we show the raw stream as plain text, not parsed. Parsing happens only at `ready`.
- **Over-deletion breaking an unnoticed import** → Low risk; a grep confirmed only `App.tsx`, `ResultsTab.tsx`, `useExtraction.ts`, and `ExportModal.tsx` import from `extraction.ts`, and no tests reference the deleted helpers. Type-check after the cut.

## Migration Plan

No runtime migration — this is a prototype UI change. Rollout is a straight code edit; rollback is reverting the commit. No persisted state or API contract depends on the removed code.

## Open Questions

None. Scope, viewer flavor, export removal, and raw-stream retention were all settled during exploration.
