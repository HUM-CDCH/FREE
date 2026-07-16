# Parsing Service

FastAPI prototype for secure PDF source ingestion and canonical document
parsing.

## Installation

Install the normal CPU OCR fallback for local development:

```bash
uv sync --extra ocr-cpu
```

CUDA hosts can instead use `uv sync --extra ocr-gpu`. The extras conflict by
design; select exactly one. Runtime commands use `uv run --no-sync`, so they do
not silently replace the selected profile. From the workspace root,
`pnpm install:cpu` and `pnpm install:gpu` select the same profiles explicitly.
Without either extra, Docling still runs and a task that needs PaddleOCR reports
the stable `ocr_fallback_unavailable` diagnostic.

## Canonical ingestion pipeline

Production ingestion uses one canonical source-document pipeline:

1. Accept one uploaded PDF Source Document.
2. Validate PDF content, byte limits, and task UUIDs.
3. Persist the source by content hash as `data/sources/{sha256}.pdf`; the
   task-local `source.pdf` is hard-linked to that immutable blob when supported.
4. Inspect the PDF with PyMuPDF for page count, geometry, native text quality,
   and diagnostics only.
5. Run Docling once per source hash, then export DocTags separately for every
   inspected physical page so blank pages cannot shift provenance.
6. Persist raw Docling JSON when available, the exact physical-page DocTags
   stream consumed by the simplifier, aggregate DocTags as a diagnostic, and LLM
   Markdown with verified page spans. Older exporters degrade to a
   document-level view rather than inventing page offsets.
7. Build artifacts in a pending directory, publish an immutable generation under
   `data/documents/{sha256}/generations/`, then atomically replace the canonical
   `parsed_document.json` commit record. Task-local JSON remains for route
   compatibility.

Docling DocTags is the default canonical LLM text path. PaddleOCR is reserved
for internal page-level fallback when Docling-derived text is unavailable or
clearly low quality; it is not exposed as a user-selectable primary parser.
Fallback DPI, resolved device, parser versions, model choice, and a deliberate
converter-policy revision participate in cache identity. Cache hits authenticate
the source digest, document identity, artifact paths, and output digest before
reuse. `compare.py` is benchmark-only, defaults to CPU, requires `--source`, and
is not used by the production worker.

## Layout

```text
main.py                 entry-point shim (`fastapi dev main.py` / `uvicorn main:app`)
compare.py              benchmark-only parser comparison CLI
app/
  main.py               FastAPI app factory
  api/                  HTTP routes (tasks, documents, artifacts, system)
  models/               Pydantic contracts and parser provenance
  ingestion/            upload handling and PDF validation
  storage/              hashing, safe paths, blobs, atomic writes, manifests
  parsing/              Docling runner, simplifier, orchestrator, adapters
  workers/              background ingestion worker, GPU detection
```

## Canonical `ParsedDocument` (`parsed_document.v1`)

`app/models/parsed_document.py` defines the versioned contract served by
`GET /tasks/{task_id}/document`:

- `document` — source hash, provenance, page count, encryption, input profile;
- `preprocessing` — deterministic `preprocess_id`, profile, status, warnings;
- `artifacts` — source PDF, parsed JSON, raw Docling JSON, raw DocTags, and
  `.llm.md` references;
- `parser_runs` — provenance for `pymupdf_inspect`, `docling_doctags`, and
  internal `paddleocr_fallback` when used;
- `arbitration` — Docling primary, OCR page fallback, PyMuPDF diagnostic;
- `text_views.llm_markdown` — canonical downstream LLM Markdown;
- `text_views.doc_tags_simplified` — FREE-compatible simplified DocTags;
- `text_views.page_marked_text` and `pages[].char_span` — page markers and
  offsets when page breaks are available;
- `tables` — retained for schema compatibility; table-cell provenance is a
  follow-up.

## Non-goals for this milestone

- No LLM extraction.
- No FREE hierarchical boundary detection or per-record extraction.
- No AI SDK integration.
- No user-selectable competing primary parser pipelines.

## Ingestion guarantees

`POST /tasks` accepts one uploaded PDF Source Document. The service keeps these
protections:

- an exact 50 MiB streaming upload limit;
- `%PDF-` magic validation and MIME hints;
- sanitized display filenames only;
- content-addressed source storage;
- UUID-only task paths;
- page/render preflight limits before full text extraction and bounded parser
  admission;
- locked source leases and per-source, canonical, task, and archive quotas;
- immutable canonical generations, atomic commit records, and retention cleanup;
- startup reconciliation for tasks interrupted by a service restart.

For deployment on an untrusted network, enforce the request-body limit at the
ASGI proxy/server boundary as well: application upload validation runs after the
multipart parser has accepted the request stream.

Current task endpoints:

- `GET /tasks/{task_id}`
- `GET /tasks/{task_id}/document`
- `GET /tasks/{task_id}/parsed-document` (compatibility alias)
- `GET /tasks/{task_id}/markdown` (canonical LLM Markdown)
- `GET /tasks/{task_id}/download` (task document and canonical artifacts)

Run backend tests from this directory with:

```bash
uv run --no-sync python -m unittest discover -s tests

# The exporter contract smoke is always included. Full conversion is optional
# because it may download model assets.
RUN_DOCLING_INTEGRATION=1 uv run --no-sync python -m unittest tests.test_docling_integration
```
