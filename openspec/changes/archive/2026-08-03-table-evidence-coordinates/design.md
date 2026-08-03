## Context

`EvidenceHighlightLayer` (`prototypes/studio/src/EvidenceHighlightLayer.tsx`) locates every extracted value in the rendered PDF by full-document text search (`findValueRects` → `rectsForQuery`/`searchValueAnchoredBySnippet`), optionally narrowed by the model-provided `snippet`. For table data this is unreliable: the model's `snippet` instruction only requires "a short verbatim excerpt that contains the value" — it is not required to include row/column context — so when the same value repeats across a table's rows or columns, the search can highlight the wrong cell.

The parsing service already computes exact per-cell geometry for tables (`ParsedTable.cells[].bbox`, `TableCell.role` ∈ {header, column_header, row_header, row_header_hint, data}, via Docling + Camelot in `prototypes/parsing_service/app/parsing/table_extraction.py`), served at `GET /tasks/{task_id}/document`. Studio never calls this endpoint today — it only fetches `/tasks/{task_id}/markdown` — so this geometry is computed and discarded on every run.

This change threads that geometry into Studio and uses it to resolve table-sourced highlights precisely, while leaving every other highlight's behavior untouched.

## Goals / Non-Goals

**Goals:**
- Resolve table-cell evidence to its exact bounding box when possible, instead of guessing via text search.
- Disambiguate duplicate-valued table cells using two independent, additive signals: model-reported row/column header hints, and reading-order position within a `records` array — in that priority order.
- Zero behavior change for any value that doesn't resolve to a table cell (all prose/non-table highlighting is untouched).
- Zero prompt/schema change for documents that have no tables.

**Non-Goals:**
- Rearchitecting extraction into per-paragraph/per-section calls (the earlier "catalog mode" discussion) — out of scope for this change.
- Disambiguating across multiple tables that share identical header text on the same page — deferred (see Open Questions).
- Changing `generate_schema.ts`/schema suggestion to be table-aware — this change only touches the extraction (`/api/extract`) path.

## Decisions

**1. Table geometry lives as App-level state, sibling to `docIndex`, not inside `ExtractionState`.**
`ExtractionState` is scoped to one `requestExtraction` call's lifecycle (`idle`/`running`/`ready`/`error`); table geometry is static per-document data available as soon as parsing completes, independent of whether/when extraction runs. Folding it into `ExtractionState` would force `tables` to be `null`/`undefined` during `idle`/`running`/`error` even though it's already known. Instead, `DocIndex`'s `ready` variant grows a `tables: ParsedTable[]` field, matching how `markdown` already lives there.

**2. `parseDocumentToMarkdown` must stop discarding `taskId`.**
Today it resolves the parsing-service `taskId` internally, polls to completion, fetches markdown, and returns only the markdown string — the `taskId` needed for a second fetch (`/document`) is thrown away. Its return type changes to `Promise<{ taskId: string; markdown: string }>`. It has exactly one call site (`App.tsx`'s indexing effect), updated in the same change. The `VITE_DEV_TASK_ID` dev-only path already has its task id inline and gets the same second fetch added at that call site.

**3. The tables fetch is best-effort, not a hard dependency.**
`fetchParsedTables(taskId, signal)` (new, in `api.ts`) is wrapped in a `catch` that resolves to `[]`. A slow or failing `/document` call must never block markdown-based extraction or schema flows that work today — worst case, table-cell matching silently finds zero candidates and every highlight falls back to the pre-existing text search.

**4. Only a boolean (`hasTables`) crosses to the backend prompt — not the table content.**
The model already sees table content through the markdown text it's given; the backend only needs to know *whether* to ask for `row_header`/`column_header` at all. Sending the full `ParsedTable[]` to `/api/extract` would be redundant payload for no benefit. `requestExtraction` gains one new trailing parameter, `hasTables: boolean`, derived from `documentTables.length > 0` in `App.tsx`. The full table geometry goes only to `EvidenceHighlightLayer` (client-side matching), never to the backend.

**5. Evidence leaf shape change is gated and additive.**
`_evidence_template.ts`'s `wrapSchema` takes a new `hasTables` flag; when true, each leaf becomes `{ value, snippet: 'string', page: 'number', row_header: 'string', column_header: 'string' }` instead of the current 3-key shape. Because `_model_output.ts`'s `objectSchemaFromTemplate` derives its strict Zod validator directly from this same template object, the model is required to emit the two new keys whenever `hasTables` is true — so the accompanying prompt instruction explicitly says to always include them, using empty/null when a value isn't table-sourced (mirroring the existing, already-lenient tone of `EVIDENCE_FIELD_INSTRUCTION`). `splitNode`'s evidence-extraction, which today only forwards `{ snippet, page, value }` and silently drops anything else, is extended to always attempt reading `row_header`/`column_header` off the node (defaulting to `null` when absent) — independent of `hasTables`, so it's backward-compatible with model responses that predate this change.

**6. Matching order: exact text match → header-hint disambiguation → reading-order positional fallback by occurrence index → no match (safe default).**
A dedicated pure function/module (`tableCellMatch.ts`, no pdf.js dependency) implements this, called unconditionally for every highlight before the existing PDF text search runs (per explicit user direction: try it for everything, accept the small chance of an incidental text collision with a non-table field, since the drawn box is still correct in that rare case). Tiers:
   - **Exact match**: collect all `TableCell`s (case-/whitespace-normalized) whose text equals the highlight's value. Zero candidates → no match, fall through immediately. One candidate → done.
   - **Header-hint filter**: when the evidence carries non-empty `rowHeader`/`columnHeader`, narrow candidates to those whose row's row-header cell (`role` ∈ {row_header, row_header_hint}) and/or column's header cell (`role` ∈ {header, column_header}) matches the corresponding hint. If this narrows to exactly one, done.
   - **Reading-order positional fallback**: sort the still-ambiguous candidates by (page number, bbox y0, bbox x0) and pick the candidate at this highlight's *occurrence index* — **not** its raw index within a `records` array. `EvidenceHighlightLayer` precomputes occurrence indices once per render via `computeOccurrenceIndices(highlights)`: each highlight is ranked by its 0-based position among *other* highlights sharing the same field key, normalized value, and hint page, counted in document order.
   - Anything else → no match; `EvidenceHighlightLayer` falls back to today's `findValueRects` unchanged.

   This ordering was chosen after ruling out relying on the model's free-text `snippet` for disambiguation — the extraction prompt never asks the model to include row/column context in `snippet`, so it can be as short as the value itself and carries no reliable structural signal. Header hints and reading order are both *structural* signals that don't depend on the model choosing to be verbose.

   **Correction from `records[i]`-index to occurrence-index (found during real E2E verification):** the original plan indexed candidates by the highlight's raw position in a `records` array. Verified against a live extraction over the bundled Ellekilde report, this is wrong whenever `records` is flattened across multiple unrelated tables (one array spanning every grave's finds): most records don't share the ambiguous value at all, so the raw array index overcounts against the small set of actually-tied candidates. Concretely, records at array indices 1 and 2 (`"8-3"` and `"8-4"`) shared `beskrivelse: "Dele af lårben"`, but the correct table cells were the 1st and 2nd occurrences of that value — not indices 1 and 2 into the 2-candidate list. The fix ranks by occurrence among ties instead. Grouping additionally by hint page (not globally) matters too: candidates get narrowed to a single page by `hintPage` before indexing, so a second duplicate pair on a later page needs its own count restarting at 0, not a continuation of the first page's count. Also worth noting: the backend's row-classifier (`table_extraction.py`) tags short alphanumeric identifier cells (like `"8-3"`) as `role: "data"`, not `row_header`, whenever they look number-ish — so the header-hint tier legitimately can't resolve these cases even when the model reports a correct `row_header`, which is exactly why the occurrence-index fallback needs to be correct on its own.

**7. Coordinate conversion: PDF points (top-left origin) → viewport CSS pixels, no y-flip.**
`BoundingBox` is documented as "PDF points, top-left origin (y grows downward), in the displayed (post-rotation) page space matching `ParsedPage.width_pt/height_pt`" — already in the same top-left, post-rotation display space that pdf.js's `getViewport` renders into. This differs from `EvidenceHighlightLayer`'s existing rect math for raw pdf.js text items, which flips `ty` (bottom-origin, per the PDF spec's native text-transform convention) via `viewportHeight - (ty + height) * scale`. For a cell bbox, the conversion is a straight scale: `cssX = x0 * viewportScale; cssY = y0 * viewportScale`, reusing the same `viewportScale` already computed in `getPageTextData` (factored into a small standalone `getPageViewportScale(pdfViewer, pageNumber)` helper so a table-cell match doesn't need to fetch page text content it won't use).

**8. Keep the matcher pure and dependency-free for testability.**
No PDFViewer/pdf.js mocking convention exists anywhere in this codebase today (confirmed: `EvidenceHighlightLayer.test.ts` only tests `evidenceHighlights.ts`'s `buildHighlights`, not the layer itself). Rather than inventing that mocking infrastructure for this change, `tableCellMatch.ts` takes plain data (tables, value, hints, page, record index) and returns a plain result — fully unit-testable without pdf.js. The thin glue that calls it inside `EvidenceHighlightLayer.tsx`'s render effect stays deliberately small and is verified manually (dev server, real PDF with a table) rather than through new PDFViewer mocks.

## Risks / Trade-offs

- **[Risk]** Model omits `row_header`/`column_header` keys entirely (rather than `null`) → `_model_output.ts`'s strict Zod validator fails for that leaf's object level → `parseExtractionResult` falls back to raw passthrough, losing the typed evidence split for that call. **Mitigation**: prompt instruction explicitly says to always include both keys; this failure mode already exists today for any other validation mismatch and degrades to "extraction still returns something," not a hard error.
- **[Risk]** `TableCell.role` classification (row/column header detection in `table_extraction.py`) is heuristic and can be sparse or wrong for irregular tables (multi-row headers, merged cells). **Mitigation**: header-hint filtering is only the second of three tiers — positional fallback and the pre-existing text search both still apply, so the worst case is "no better than today," never worse.
- **[Risk]** Reading-order positional fallback assumes one table row per record and stable, order-preserving extraction — it can misassign when that assumption breaks. **Mitigation**: this is the lowest-priority, explicitly-accepted fallback tier; a wrong positional pick still lands on a cell containing the correct text, so it's no worse than the current ambiguity.
- **[Risk]** PDF-points-to-pixels conversion assumption (no y-flip, straight scale) is based on the `BoundingBox` docstring and hasn't been empirically verified against a real rotated-page PDF. **Mitigation**: verify manually against a rotated-page fixture during implementation; guard the coordinate path to fall back to text search if a converted rect falls outside plausible page bounds.
- **[Risk]** Second network round trip (`/tasks/{id}/document`) added to document indexing. **Mitigation**: best-effort with `catch → []`; never blocks the existing markdown-based flow.
- **[Risk]** `frontend-api-client`'s existing "signatures never change" guarantee is narrowed by this change. **Mitigation**: single call site for each changed function, updated atomically; captured explicitly as a MODIFIED requirement rather than silently violated.

## Migration Plan

No persistence layer or external consumers exist for these internal TS functions (per `CLAUDE.md`, FREE has no persistence layer yet), so there is no data migration. Implementation order (matches `tasks.md`): backend evidence-template/prompt change → frontend fetch/threading → pure matcher module + tests → wire matcher into `EvidenceHighlightLayer` → run existing test suites → manual end-to-end check with a table-bearing source document, comparing highlight placement on a duplicate-valued table cell before and after. Rollback is a plain revert; nothing is versioned or staged externally.

## Open Questions

- Should schema *suggestion* (`generate_schema.ts`) also become table-aware (e.g. marking which suggested fields look table-derived), or is gating only the extraction call sufficient? Deferred — no current evidence it's needed.
- Two distinct tables on the same page sharing identical column headers (e.g. both have a "Count" column) aren't disambiguated by column header alone. Current mitigation is scoping candidates by `hintPage` first; revisit if this proves insufficient once used against real documents.
