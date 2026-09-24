# Table-cell Evidence: implementation and validation

2026-09-23. Native implementation validated; scanned-table evaluation awaits an available local Surya server. No deployment performed.

## Implementation

Canonical result v5 retains native Docling cells: row/column identity, spans, role, raw parent-text offsets and optional measured physical-page boxes. Parent text, ordering and segment identities remain intact. Readers still verify original v4 bytes and hashes.

Studio publishes page-local logical tables, measured cell anchors and the existing parent anchor. Missing geometry is diagnostic and remains coarse. Empty cells remain in canonical data but cannot ground populated values.

Generic grounding counts cells individually without double-counting their parent and includes headers, row context and sibling fields for ambiguous values. Recipe Catalog promotes accepted spans only when wholly contained in one measured cell without alternatives. Both relay formats validate cells against the pinned Source Representation.

Reprocess reads the owned retained PDF and shares upload parsing, polling, translation and packaging. Publication appends a revision after retention. Expected-head checks and revision uniqueness arbitrate races; request keys plus fingerprints provide publication replay. The existing ingestion queue carries requests and retries. Source menus offer page/spread selection. Default reopening selects the current source; historical Extractions, Reviews and Annotations retain their original pins. Extraction remains a separate researcher action.

Apply `packages/db/migrations/app/20260923T1946_source_reprocessing` before updated Studio code. It adds two nullable columns and one document/request-key unique constraint.

## Real native document

Input: `examples/Beretning_Ellekilde_8_13.pdf`, SHA-256 `fbd6884163b68656687d4c6ab7395be6ea306a5faf7b94253f18eb50c60b9679`.

Cached Docling models, offline mode, six pages. The complete v5 result passed `load_result(require_complete=True)` and Studio's `verifiedPage` / `parsedDocumentFromKeiExp` boundaries.

| Measurement | Result |
| --- | --- |
| Tables | 14 |
| Canonical cells | 261 |
| Measured cell anchors | 249 |
| Screenshot table, page 3 segment 3 | 9 rows × 3 columns |
| Screenshot measured cells | 23; four empty cells lack geometry |
| `24-8` | `a_p3_s3_r1_c0`, physical page 3 |
| Repeated `Overarmsknogle` | Separate `r1_c1` and `r7_c1` anchors and boxes |

The `24-8` box is `(80.54, 230.26, 98.98, 238.51)` in top-left PDF points. The measured table fixture is `prototypes/studio/test/fixtures/kei-exp/ellekilde-table-v5.json`. Full temporary artifacts are under `/tmp/free-table-evaluation`.

## Verification

Commands are relative to their package.

- Parsing Service: `.venv/bin/python -m pytest -q tests/test_table_cells.py tests/test_native.py tests/test_result.py tests/test_extract_stages.py tests/test_extract_evidence.py tests/test_extract_grounded.py -m 'not live_model and not postgres and not slow'`: **110 passed**, four skipped, four deselected. Live native conversion was run separately.
- Studio: `./node_modules/.bin/tsc -b --pretty false`: passed.
- Studio: `./node_modules/.bin/vitest run api/_kei_exp.test.ts api/source_documents.test.ts src/sourceIngestionMachine.test.ts src/ProjectNavigation.test.tsx api/document_reopen.test.ts server/researcher-project-ownership.test.ts`: **121 passed**.
- Extraction: `node --import tsx src/module.test.ts`: **26 passed**, including both cell wire formats and absent-cell rejection.
- DB: `node --import tsx src/project-store.test.ts`: **34 passed**.
- Disposable PostgreSQL 17, `free_test_table_cells`: all ten migrations applied. `src/source-reprocessing.postgres.check.ts` passed concurrent same-key replay, competing-key conflict, preserved revisions and failed retention.
- Extraction PostgreSQL suite: **26 passed**, including current-source reopening, historical extraction/review retention and annotation pinning.
- Browser: `npm_config_manage_package_manager_versions=false ./node_modules/.bin/playwright test e2e/project-navigation.spec.ts -g 'reprocesses a retained PDF' --workers=1`: **passed**. Covers layout selection, parser failure and retry with the same key. Its disposable stack was torn down.
- `git diff --check`: passed. Bloat audit: passed. Shared parsing path; no production model, feature flag or parallel parser added. V4 reading and coarse geometry are necessary contracts. New catch blocks clean up and rethrow, translate API failures or resolve verified uniqueness races.

A broad Python invocation stalled and was stopped; only focused-suite results are claimed. Browser bootstrap initially timed out while installing locked dependencies; installation was completed and the subsequent browser test passed. The host pnpm version-switching failure was bypassed with local executables or `npm_config_manage_package_manager_versions=false`.

## Scanned-table evaluation

`prototypes/parsing_service/evaluate_table_cells.py` uses an existing loopback Surya server. At most three native-reference table crops, screenshot table first; simple and full modes; six requests total, no retries, 60-second deadlines and 3072 output tokens per request. Records latency, token counts, grid sizes and raw outputs. Rasterized native tables are a reference experiment, not an independent scanned-document benchmark.

From the Parsing Service directory:

```sh
.venv/bin/python evaluate_table_cells.py /tmp/free-table-evaluation/result \
  --url http://127.0.0.1:8000/v1 --output /tmp/surya-table-evaluation
```

No local Surya/vLLM listener was available. The script's help/import path was checked; no accuracy or latency claim is made. Installed Surya simple mode supplies geometry without text/spans; full mode supplies HTML without boxes. Output alignment, merged/borderless cases and independent scanned samples need evaluation before scanned cells can be enabled.

## Limits

Existing PDFs need Reprocess followed by a new Extraction. Old reviewed results retain their original evidence. Reprocessing shares the existing request/in-memory queue lifecycle; durable recovery after browser/server restart is outside this change. No cross-page table merging. Live extraction-model selection quality and fresh production images were not validated.

## Review corrections — 2026-09-24

The Opus 5.5 review identified cross-revision inspection, table-of-contents classification and grounding request growth. Historical reviewed Extractions now open through the existing pinned `extractionId` route when their source revision differs, including when the current revision has no Extraction. They cannot be selected against the current revision's Evidence Anchors. Structured table data now determines Studio's table classification, including Docling `DOCUMENT_INDEX` items.

Claude Code `claude-fable-5-1` at max effort advised on grounding growth. Generic prompt version 7 shares row/header context and sibling fields, offers each claim only matching cells plus all coarse passages, and splits claim batches using the existing `record_chars` limit. The cap counts system text, user text and the reply schema. No competing evidence is truncated: a single claim whose complete request cannot fit remains ungrounded with `grounding_exceeds_budget`. This can leave ambiguous claims ungrounded on large documents; the character cap is not a verified model-token budget. The recipe Catalog path is unchanged.

Correction checks: Studio TypeScript passed; changed Python runtime files passed syntax parsing; `git diff --check` and the bloat audit passed. Existing assertions were updated for the new prompt shape. No tests or live model runs were added or run for these corrections; the earlier verification counts above describe the implementation before this review follow-up. Browser revision-switching and grounding quality under the new batching remain unvalidated.
