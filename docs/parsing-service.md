# Canonical source document parsing

The parsing service turns a PDF source document into one versioned, canonical
`ParsedDocument`. It is the deterministic ingestion boundary for FREE: model
extraction, schema handling, and hierarchical record detection happen later and
are not part of this service.

Operational setup and endpoint examples live in
[`prototypes/parsing_service/README.md`](../prototypes/parsing_service/README.md).
Table and OCR correctness rules are documented in
[`parsing-quality.md`](./parsing-quality.md).

## Pipeline

Production uses one pipeline rather than a researcher-selectable set of
competing parsers:

1. `POST /tasks` accepts one uploaded PDF Source Document.
2. Ingestion validates the document, byte limits, and task identifier.
3. The source is stored by SHA-256 at `data/sources/{sha256}.pdf`. A task-local
   `source.pdf` refers to the same immutable content when hard links are
   supported.
4. PyMuPDF inspects page count, displayed geometry, rotation, native-text
   quality, and diagnostics. It is an inspection adapter, not a competing text
   parser.
5. Docling converts the source once per cache identity. The runner exports raw
   Docling JSON when supported and exports DocTags per physical page so blank
   pages cannot shift page provenance.
6. The local DocTags simplifier creates the canonical LLM Markdown. It preserves
   section headers, text, page boundaries, captions, and OTSL tables, including
   tables split by page boundaries.
7. Pages with unavailable or clearly low-quality Docling text may use internal
   PaddleOCR fallback. OCR replaces only those pages; it never becomes a
   caller-selected primary pipeline.
8. Docling's table inventory provides table recall and structure. Constrained
   Camelot stream extraction may enrich suitable inventory entries; Docling
   remains the completeness fallback.
9. Artifacts are assembled in a pending directory, published as an immutable
   generation under `data/documents/{sha256}/generations/`, and committed by an
   atomic canonical `parsed_document.json` record.

`compare.py` is a manual benchmark tool only. The production worker invokes the
runner and orchestrator directly.

## Canonical contract

`app/models/parsed_document.py` defines `parsed_document.v1`. Its main sections
are:

- `document`: content hash, source metadata, page count, encryption state, and
  input profile;
- `preprocessing`: deterministic preprocessing identity, status, and warnings;
- `artifacts`: references to the source, canonical JSON, raw Docling JSON, raw
  DocTags, and canonical `.llm.md`;
- `parser_runs`: timing, status, diagnostics, and versions for each parser that
  participated;
- `arbitration`: the selected text parser and any page-level OCR or table parser
  decisions;
- `text_views.llm_markdown`: the downstream canonical text;
- `text_views.doc_tags_simplified`: the FREE-compatible simplified DocTags view;
- `text_views.page_marked_text` and `pages[].char_span`: physical-page markers
  and offsets when page mapping is verified;
- `tables`: structured cells, roles, proven spans, parser provenance, and safe
  displayed-page geometry.

The public document and Markdown routes always return canonical views. Parser
names remain internal provenance; they are not API choices.

## Cache and artifact identity

A source hash identifies immutable input bytes, but conversion policy also
participates in cache identity. The identity includes fallback DPI, resolved
execution device, parser/model versions, and the converter-policy revision.
Before reuse, the service validates the source digest, document identity,
artifact paths, and output digest.

Canonical artifacts are source-scoped and reusable across tasks. Task-local
metadata points to the committed canonical generation and remains available for
route compatibility. Writes are atomic, paths are constrained to service-owned
roots, and interrupted tasks are reconciled at startup.

## Parser roles

- **PyMuPDF — inspection:** reports physical pages, displayed geometry,
  rotation, text quality, and diagnostics.
- **Docling DocTags — primary text:** produces raw artifacts and canonical LLM
  Markdown with physical-page provenance.
- **PaddleOCR — page fallback:** supplies text and evidence blocks only for
  selected low-quality or empty pages.
- **Docling tables — table inventory:** defines table recall, structure, roles,
  spans, and fallback content.
- **Camelot stream — table enrichment:** runs in bounded table areas when it can
  safely improve an inventoried table.

Every emitted result records its actual parser provenance. Arbitration may vary
by page without presenting multiple competing documents to callers.

## Security and operational boundaries

The ingestion boundary retains:

- upload, page, and rendering limits;
- PDF magic and content validation;
- sanitized display names without exposing storage paths;
- UUID-only task paths;
- a one-hour grace before unreferenced source cleanup, per-source canonical
  locking, immutable generations, atomic commits, and retention cleanup.

A deployment exposed to untrusted traffic must also enforce request-body limits
at the ASGI proxy or server boundary because multipart parsing precedes
application-level upload validation.

## Service boundaries

This parsing milestone intentionally does not include:

- LLM extraction;
- schema suggestion or extraction-schema handling;
- FREE hierarchical boundary detection or per-record extraction;
- AI SDK integration;
- researcher-selectable primary parser pipelines.

## Verification

From `prototypes/parsing_service`:

```bash
uv run --no-sync python -m unittest discover -s tests

# Optional because conversion may download model assets.
RUN_DOCLING_INTEGRATION=1 uv run --no-sync python -m unittest tests.test_docling_integration
```

The suite covers secure ingestion, canonical persistence and cache reuse,
DocTags simplification, OCR fallback, table semantics, endpoint behavior, and a
real HTTP lifecycle against the repository source document.
