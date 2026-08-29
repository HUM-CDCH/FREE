<!-- markdownlint-disable MD013 -->

# ParsedDocument v2 uses one canonical semantic content stream

> **Accepted.** `ParsedDocument` in `app.models.parsed_document_v2` is the sole
> public typed interface for canonical PDF ingestion.

The typed, page-scoped semantic content stream is authoritative for ordered
content, physical pages, table placement, canonical Markdown, and text
Evidence. The renderer emits reserved page markers and records half-open
UTF-8 byte spans into the exact Markdown bytes.

The public document contains sanitized parser provenance and typed diagnostics.
Cache paths, raw parser artifacts, parser input/output refs, and internal
digests stay in the generation manifest. Route JSON and packaged JSON use the
same portable shape.

Every published Evidence occurrence carries finite, ordered, page-bounded
geometry in displayed top-left physical-page space. Canonical v2 publication
fails when safe geometry is unavailable. Rotation metadata does not invalidate
already normalized displayed-page geometry; consumers repeat the bounds check
before rendering it.

Docling supplies semantic table values and structure. Camelot can only add
exact-match monotonic geometry and never creates a canonical table alone.
PaddleOCR is the page-level fallback for unresolved text; non-PDF and URL
sources are outside this contract.
