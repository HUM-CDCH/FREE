# Parsing Service

FastAPI service for PDF Source Document ingestion. It publishes one strict
`parsed_document.v2` document, canonical Markdown, and a portable package.

## Installation

Select one OCR profile, then preserve it with `uv run --no-sync`:

```bash
uv sync --extra ocr-cpu
# or: uv sync --extra ocr-gpu
```

Docling is the primary parser. PaddleOCR is a page-level fallback. PyMuPDF is
used for PDF inspection only. Camelot may enrich matching Docling geometry;
Camelot-only candidates are diagnostics and are never canonical tables.

The service installs `opencv-contrib-python` as its single `cv2` provider.
Docling/RapidOCR and Camelot declare the overlapping `opencv-python` and
`opencv-python-headless` distributions, so those transitive dependencies are
excluded in `pyproject.toml`; installing multiple OpenCV wheel variants into one
environment corrupts their shared `cv2` namespace. The excluded distributions'
published metadata cannot express that the contrib build provides the same API,
so `uv pip check` reports those names as missing; the installed-Docling contract
test is the runtime compatibility check.

## Canonical pipeline

1. Accept and validate one uploaded PDF.
2. Store source bytes by SHA-256 and inspect physical pages.
3. Run Docling and export page-scoped DocTags.
4. Use PaddleOCR only for unresolved pages.
5. Convert semantic blocks and producer-observed tables through the typed
   placement and continuation modules.
6. Render one canonical Markdown byte stream and build its Evidence index.
7. Validate the v2 contract, publish an immutable generation atomically, and
   write the internal generation manifest.

`build_canonical_generation` is the only parsing interface. Public JSON contains
sanitized parser provenance and typed diagnostics. Cache paths, raw artifacts,
parser input/output refs, and internal digests stay in the generation manifest.

## Public routes

- `POST /tasks`
- `GET /tasks/{task_id}`
- `GET /tasks/{task_id}/document`
- `GET /tasks/{task_id}/source` (the same `parsed_document.v2` payload)
- `GET /tasks/{task_id}/pdf` (the retained upload)
- `GET /tasks/{task_id}/markdown`
- `GET /tasks/{task_id}/download`

There is no URL ingestion and no `/parsed-document` alias.

## v2 contract highlights

- `app.models.parsed_document.ParsedDocument` is the sole public model.
- Source is upload-only PDF.
- `MarkdownByteSpan` is a half-open UTF-8 byte range into canonical Markdown.
- Every canonical table cell has one Evidence anchor owning all producer
  occurrences.
- Page spans contain page/range/producer identity only.
- Route JSON and packaged JSON are the same portable payload.
- Package entries are `manifest.json`, `source.pdf`, `parsed_document.json`,
  and `artifacts/document.llm.md`.

## Verification

```bash
uv run --no-sync --with pytest python -m pytest -q
uv run --no-sync lint-imports
```

