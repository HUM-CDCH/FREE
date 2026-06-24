## 1. Trim the data layer

- [x] 1.1 Reduce `extraction.ts` to the extraction-state types and parsed result only: delete the unit/group model (`ResultUnit`, `LeafUnit`, `ArrayUnit`, `EntityGroup`, `ExtractionRun`, `SubRow`, statuses), `buildRun`, `templateSignatures`, `preserveLeaf`/`preserveArray`, `unitState`, `visibleUnits`, `pendingUnits`, `ghostPaths`, `reviewProgress`, all `decide*`/`acceptPending*`/`bulkAccept*`, and every export helper (`buildExportData`, `buildExportCsv`, `exportCounts`, `setNested`, `ExportScope`).
- [x] 1.2 Reduce `useExtraction.ts` to: `runExtraction`, state (`idle`/`running`/`ready`/`error`), the parsed `result`, the streamed `raw` text, `canRun`, and `hasResults`. Remove `stepIdx`/`arrayOpen`/`editingId`/`draft`/`exportOpen` state and all stepper, decision, and export functions. Reduce `canRun` to "schema ready and not currently running".

## 2. Rewrite the Results viewer

- [x] 2.1 Rewrite `ResultsTab.tsx` as a read-only viewer: on `ready`, render the result via `JSON.stringify(result, null, 2)` in a scrollable `<pre>`, reusing the styling from the old `ExportModal` preview. No accept/edit/reject/bulk controls. (specs: Read-only pretty-printed JSON result)
- [x] 2.2 Add the empty state shown when no extraction has run, directing the user to run extraction. (specs: Empty state before any extraction)
- [x] 2.3 Show the live streamed `raw` text while `running`, replaced by the pretty-printed result on `ready`. (specs: Live output while running)
- [x] 2.4 Show the error message with a retry/re-run control on `error`. (specs: Error state with retry)
- [x] 2.5 Keep the Run / re-run action; a re-run replaces the displayed result with no carried-over per-field or staleness state. (specs: Re-run replaces the displayed result)

## 3. Remove export

- [x] 3.1 Delete `ExportModal.tsx`.
- [x] 3.2 Remove the `ExportModal` import and its mount from `App.tsx`, plus any `openExport`/`exportOpen` wiring. Confirm no export/download/format/scope control remains in the Results tab. (specs: No export affordance)

## 4. Simplify dependent UI

- [x] 4.1 Simplify the Results badge in `RightRail.tsx` from pending-count / ✓-done logic to a plain has-results indicator (or none).
- [x] 4.2 Update `App.tsx` button/status logic that derived from `needsRerun` / `allReviewed` so it relies only on the reduced controller surface.

## 5. Verify

- [x] 5.1 Type-check / build passes with no dangling imports or unused exports from the trimmed `extraction.ts`.
- [x] 5.2 Manually confirm each state renders correctly: empty, running (live raw), ready (pretty JSON), error (message + retry), and re-run replacing the result — with no review or export controls present.
