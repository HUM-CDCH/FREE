# Plan: Make Docling DocTags the Canonical Ingestion Text Path

## Context

The parsing service currently handles secure PDF upload/URL ingestion, task-local `source.pdf` storage, content-addressed source copies, parser execution through the benchmark-oriented `compare.py`, canonical `ParsedDocument` construction, and simple parser arbitration.

This change is limited to deterministic source-document ingestion/parsing/canonicalization. It should not add LLM extraction, FREE hierarchical extraction, retries, schema handling, or AI SDK integration.

Findings from the current service:

- `TextViews.doc_tags_simplified` already exists in `app/models/parsed_document.py`, but no production code populates it.
- `TextViews.llm_markdown` does not exist yet; add it as the canonical downstream LLM text view.
- `compare.py` currently emits competing lanes (`docling_pdf`, `docling_images`, `paddleocr`) and production `parse_worker.py` shells out to it. This conflicts with the target single production pipeline.
- `app/api/routes_tasks.py` exposes `pipeline` as a user-selectable form field; `app/api/routes_documents.py` exposes pipeline-specific Markdown via `?pipeline=`. These should be removed or deprecated so callers receive the canonical document view only.
- `app/parsing/normalize.py` can already build page-marked text and char spans, but direct Docling PDF output falls back to a single `[DOCUMENT]` block. The DocTags simplifier needs to preserve page-break-derived offsets when DocTags contain `<page_break>` markers.
- Existing upload/URL security is isolated in `app/ingestion/*` and should stay unchanged.
- FREE's implementation is available at `../FREE-technical/core/doctags_simplify.py`. It handles section headers, text blocks, page breaks, page footers, OTSL tables, and merging OTSL tables split across page breaks; adapt this locally rather than inventing a new extraction flow.

## Approach

Implement one production ingestion pipeline:

1. Persist the source PDF by content hash using the existing storage path.
2. Inspect the PDF with PyMuPDF for page count, geometry, native text quality, and diagnostics only.
3. Run Docling once per source PDF through a production parser runner, not `compare.py`.
4. Persist raw Docling artifacts:
   - raw/native Docling JSON when the installed Docling version exposes it;
   - raw DocTags when `export_to_doctags()` is available;
   - parser diagnostics/warnings when either export is unavailable or partial.
5. Convert raw DocTags to canonical LLM Markdown with a local `app/parsing/doctags_to_markdown.py` adapted from FREE-technical's `core/doctags_simplify.py`.
6. Populate `ParsedDocument` from that DocTags path:
   - `artifacts.raw_docling_ref` / debug artifact refs for native Docling JSON;
   - `artifacts.raw_doctags_ref` for raw DocTags;
   - `text_views.llm_markdown` as the primary downstream text;
   - `text_views.doc_tags_simplified` as the FREE-compatible simplified `.llm.md` content;
   - `text_views.page_marked_text` and page `char_span` offsets when DocTags page breaks can be mapped.
7. Keep parser selection minimal:
   - Docling DocTags is primary.
   - PyMuPDF is diagnostic/inspection only.
   - PaddleOCR is internal page-level fallback only for pages where Docling content is empty or clearly low quality; it is not user-selectable and not a competing primary pipeline.

`compare.py` should become a benchmark/comparison CLI only. The production worker should call the new ingestion runner directly and write one canonical `ParsedDocument` per source hash, with task metadata pointing to the canonical parsed-document artifact.

## Files to modify

- `prototypes/parsing_service/app/parsing/doctags_to_markdown.py` (new)
  - Adapt FREE-technical's `core/doctags_simplify.py` locally.
  - Preserve the existing behavior for section headers, text blocks, page breaks (`---`), optional page footers, captions, OTSL tables, and OTSL table fragments split across page breaks.
  - Add a small helper that can return page-break-derived spans/offsets for normalized LLM Markdown when possible.

- `prototypes/parsing_service/app/parsing/runner.py` or `app/parsing/docling_runner.py` (new)
  - Production runner that runs Docling once per PDF.
  - Writes stable artifacts under a canonical source-hash directory, e.g. `data/documents/{content_sha256}/artifacts/` or a task-local mirror that points to the source hash.
  - Emits typed results/diagnostics consumed by the orchestrator instead of scraping `compare.py` folders.
  - Invokes PaddleOCR only for page-level fallback when Docling output is empty/low quality.

- `prototypes/parsing_service/app/models/parsed_document.py`
  - Add `TextViews.llm_markdown`.
  - Add artifact refs for raw Docling JSON and raw DocTags, or add a typed `raw_parser_refs` map if that is cleaner than expanding `ArtifactManifest` field-by-field.
  - Extend `CharSpan` or add a page-offset model so page spans can point into `llm_markdown` / `doc_tags_simplified` when available.

- `prototypes/parsing_service/app/parsing/orchestrator.py`
  - Stop discovering competing parser outputs from `compare.py` directories for production.
  - Build `ParserRun` records for `pymupdf_inspect`, primary `docling_doctags`, and any internal OCR fallback pages.
  - Populate `TextViews.llm_markdown`, `TextViews.doc_tags_simplified`, page markers, page offsets, parser diagnostics, and warnings.
  - Keep arbitration simple: Docling primary, OCR page fallback, PyMuPDF diagnostic.

- `prototypes/parsing_service/app/workers/parse_worker.py`
  - Replace the `compare.py` subprocess with the production runner/orchestrator.
  - Rename or alias `run_extraction_task` to reflect parsing/ingestion, e.g. `run_ingestion_task`, while preserving route compatibility during the refactor.
  - Store/reuse the canonical parsed document by `content_sha256` so each source hash has one canonical `ParsedDocument` output.

- `prototypes/parsing_service/app/models/parser.py`
  - Remove public competing pipeline semantics from production paths.
  - Keep parser names as internal provenance constants if useful (`docling_doctags`, `pymupdf_inspect`, `paddleocr_fallback`).

- `prototypes/parsing_service/app/api/routes_tasks.py`
  - Remove the user-selectable `pipeline` form field from production task creation, or accept it only as deprecated/ignored input with a warning if backward compatibility is required.
  - Keep `dpi`/`device` only insofar as they control internal fallback rendering/OCR; they must not select a primary parser.

- `prototypes/parsing_service/app/api/routes_documents.py`
  - Remove/deprecate `GET /tasks/{task_id}/markdown?pipeline=...` competing views.
  - Return canonical `text_views.llm_markdown` or `page_marked_text` from `/markdown`.

- `prototypes/parsing_service/compare.py`
  - Refactor so it is no longer used by the production worker.
  - Leave it as a benchmark/manual comparison tool if still useful, preferably calling shared adapters without defining production artifact layout.

- `prototypes/parsing_service/static/index.html`
  - Remove the pipeline selector and comparison-centric UI language.
  - Show canonical ingestion status and parser diagnostics instead.

- `prototypes/parsing_service/README.md` and `app/main.py`
  - Rename descriptions from “comparing pipelines” to “canonical Docling DocTags ingestion”.
  - Document non-goals: no extraction, no hierarchy, no AI SDK.

- Tests under `prototypes/parsing_service/tests/`
  - Update service tests that currently assume pipeline selection.
  - Add dedicated tests for DocTags simplification and canonical parsed-document population.

## Reuse

- Secure ingestion and source validation:
  - `app/ingestion/upload.py`
  - `app/ingestion/url_fetch.py`
  - `app/ingestion/validation.py`
- Existing content-addressed source storage:
  - `app/storage/blobs.py`
  - `app/storage/hashing.py`
  - `app/storage/paths.py`
  - `app/storage/manifests.py`
- Existing canonical document types as the base contract:
  - `app/models/parsed_document.py`
  - `ParserRun`, `TextViews`, `ArtifactManifest`, `ParsedPage`, `CharSpan`
- Existing PyMuPDF inspection adapter:
  - `app/parsing/adapters/pymupdf_inspect.py`
- Existing page marker/span machinery:
  - `app/parsing/normalize.py::normalize_markdown_to_pages`
  - `app/parsing/normalize.py::build_page_marked_text`
- FREE-technical simplifier logic:
  - `../FREE-technical/core/doctags_simplify.py`
  - Adapt only the deterministic DocTags-to-Markdown conversion, not extraction prompts or hierarchy code.

## Steps

- [x] Add local `app/parsing/doctags_to_markdown.py` adapted from FREE-technical, with tests for the required tag/table cases.
- [x] Extend `ParsedDocument` schema with `text_views.llm_markdown`, raw Docling/DocTags artifact refs, and page offsets into LLM/DocTags views.
- [x] Create a production Docling runner that converts each PDF once, exports raw Docling JSON if available, exports raw DocTags if available, runs the simplifier, and records diagnostics/warnings.
- [x] Add a source-hash-level parsed-document storage path/cache and have task metadata point to that canonical output.
- [x] Refactor `parse_worker.py` to call the production runner/orchestrator directly instead of spawning `compare.py`.
- [x] Refactor `orchestrator.py` to build the canonical `ParsedDocument` from runner outputs: Docling primary, OCR page fallback only, PyMuPDF diagnostic only.
- [x] Remove user-selectable primary parser pipelines from task creation, document Markdown routes, API schema/OpenAPI expectations, and the static UI.
- [x] Keep PaddleOCR fallback internal and page-level; render only pages that need fallback when feasible.
- [x] Keep existing upload/URL validation, task ID validation, byte limits, source hash storage, and SSRF protections unchanged.
- [x] Refactor `compare.py` into a benchmark-only CLI not used by production.
- [x] Update README and app metadata to describe the single canonical ingestion pipeline and explicit non-goals.
- [x] Update tests that currently assert pipeline selection, pipeline-specific Markdown, or `compare.py` production behavior.

## Verification

- Run backend unit tests from `prototypes/parsing_service`:

  ```bash
  uv run python -m unittest discover -s tests
  ```

- Add DocTags simplifier unit tests for:
  - section headers;
  - text blocks;
  - page breaks;
  - page footers, with dropped-footers default and optional kept-footers behavior;
  - OTSL tables;
  - OTSL tables split across page breaks where only footers/page breaks appear between chunks.

- Add canonical ingestion tests that assert:
  - `TextViews.llm_markdown` and `TextViews.doc_tags_simplified` are populated from raw DocTags.
  - Raw Docling and raw DocTags artifact refs are present when exports succeed.
  - Parser runs show `docling_doctags` as primary provenance, `pymupdf_inspect` as diagnostic, and OCR only when fallback fixtures require it.
  - Page markers/page offsets are populated when simplified DocTags include page breaks.
  - Task creation no longer exposes user-selectable primary parser pipelines.
  - `/tasks/{task_id}/markdown` returns the canonical LLM Markdown view, not a pipeline-specific comparison artifact.
  - Existing upload/URL security tests still pass unchanged.

- Manual smoke check after implementation:
  - Upload a small digital PDF through `POST /tasks` with no parser-pipeline choice.
  - Confirm the source PDF is stored under `data/sources/{sha256}.pdf` and the canonical parsed document is stored/reused by source hash.
  - Confirm artifacts include raw Docling JSON when available, raw DocTags, and simplified `.llm.md`.
  - Fetch `GET /tasks/{task_id}/document` and confirm `text_views.llm_markdown`, `text_views.doc_tags_simplified`, page offsets, diagnostics, and warnings are present.
  - Confirm no LLM calls, AI SDK code paths, or FREE hierarchical extraction modules are introduced.
