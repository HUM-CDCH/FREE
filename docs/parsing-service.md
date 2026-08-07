# Canonical source document parsing

The parsing service turns an uploaded PDF Source Document into one strict
`parsed_document.v2` document and canonical Markdown. Model extraction,
schema handling, and hierarchical record detection happen later.

## Pipeline

1. `POST /tasks` accepts one uploaded PDF and validates its bytes.
2. Source bytes are stored content-addressably and physical pages are
   inspected for geometry and text quality.
3. Docling produces the primary semantic stream and page-scoped DocTags.
4. PaddleOCR supplies generic text only for unresolved physical pages.
5. Docling table inventory supplies canonical values, roles, and structure.
   Camelot can add missing geometry only after an exact semantic match; a
   Camelot-only candidate is excluded from canonical tables.
6. Typed placement, reviewed continuation, Markdown rendering, Evidence, and
   contract validation run before generation publication.
7. The worker atomically publishes an immutable generation and an internal
   generation manifest.

## Public contract

`app.models.parsed_document.ParsedDocument` is the sole public type. It contains
PDF upload metadata, preprocessing identity, complete physical pages, typed
semantic blocks, logical tables, sanitized parser provenance, diagnostics, and
an Evidence index.

`MarkdownByteSpan` uses half-open UTF-8 byte offsets into the exact emitted
Markdown bytes. Text anchors reference those spans. Each canonical table cell
owns exactly one table-cell anchor with every producer occurrence; page spans do
not duplicate anchor IDs.

The public document and package JSON are identical portable data. Cache paths,
raw parser artifacts, parser input/output refs, and internal digests are kept
only in the generation manifest. The deterministic package contains four
entries: `manifest.json`, `source.pdf`, `parsed_document.json`, and
`artifacts/document.llm.md`.

## Routes

- `POST /tasks`
- `GET /tasks/{task_id}`
- `GET /tasks/{task_id}/document`
- `GET /tasks/{task_id}/markdown`
- `GET /tasks/{task_id}/download`

The `/parsed-document` alias and URL-source branch are not part of the service.

## Operational boundaries

The service remains a processor and time-based cache. It uses upload/page/render
limits, UUID task paths, atomic writes, immutable generations, task locks, and
delivery leases. It does not persist Projects, extraction schemas, or model
provider configuration.

Run focused/backend checks from `prototypes/parsing_service` with the selected
OCR profile and `uv run --no-sync`.
