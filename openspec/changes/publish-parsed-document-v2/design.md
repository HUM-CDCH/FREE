<!-- markdownlint-disable MD013 -->

# Design: publish-parsed-document-v2

## Contract boundary

`app.models.parsed_document.ParsedDocument` resolves to the v2 model and is
the only document type crossing the HTTP or package boundary. The model is
strict: removed spellings (`page`, `blocks`, `canonical_col`, `char_span`),
nested cell Evidence, URL-source fields, and unknown top-level fields are
rejected. Existing task/cache records are unsupported; startup reconciliation
accepts only the current upload-task shape and never migrates it.

The public model contains document identity, PDF upload source metadata,
preprocessing identity, page mapping, semantic content blocks, physical pages,
logical tables, sanitized parser provenance, and typed diagnostics. Cache paths,
raw artifacts, parser input/output refs, and storage digests belong only to the
internal generation manifest.

## Parsing seam

`build_canonical_generation(request) -> BuiltGeneration` is the single parsing
interface. It returns the portable document, canonical UTF-8 Markdown bytes,
and an internal manifest. The orchestrator sequences source inspection,
Docling execution, page-level PaddleOCR fallback, semantic block conversion,
table placement, Markdown/Evidence publication, and contract validation; each
typed responsibility lives behind its focused module.

Docling is authoritative for semantic table values, roles, structure, and
proven spans. Camelot is restricted to exact normalized-content/structure
matches that monotonically add missing geometry. If no Docling inventory
exists, Camelot candidates are diagnostics only and are excluded from the
canonical table collection.

## Markdown and Evidence

The renderer emits a reserved physical-page marker for every page and records
half-open byte spans from the exact UTF-8 output buffer. `RenderedMarkdown.slice`
decodes a span from those bytes, so offsets cannot silently become Python
character indices.

Text blocks receive one anchor with their page and byte span. Every canonical
table cell receives one anchor containing derived logical row/column identity
and an ordered collection of producer occurrences containing stable occurrence
ID, physical page, producer ref, page-local row/column offsets, spans, and
optional geometry. Text anchors own one occurrence ID. Cells contain no nested
Evidence; page spans contain no anchor-ID lists.

Continuation is a typed evaluator over reviewed producer facts. It requires
page-local Docling records, matching OTSL matrices, a header-bearing first
fragment, a body-only next fragment, and a page-break-only interstitial.
Narrative, caption, new-header, malformed, adjacency-only, and textual-
similarity-only cases remain separate. No capture-digest allowlist is used.

## Publication and storage

The worker authenticates source bytes, validates cache reuse using the internal
generation manifest, publishes an immutable generation atomically, and writes
the canonical JSON plus Markdown. Public route serialization and package
serialization use the same portable model dump. The deterministic four-entry
ZIP contains `manifest.json`, `source.pdf`, `parsed_document.json`, and
`artifacts/document.llm.md`; raw parser output and task metadata never enter it.

## Studio

Studio decodes exactly the v2 Zod shape. Evidence navigation groups text and
table-cell anchors by physical page, displays top-level diagnostics separately,
and uses producer observations for table-page navigation. Extraction-result
Evidence remains a separate concern.
