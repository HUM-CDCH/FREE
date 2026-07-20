# ParsedDocument v2 uses one canonical semantic content stream

FREE will make a typed, PDF-page-scoped semantic content stream the authority
for `parsed_document.v2`, deriving canonical Markdown, page spans, table
placement, and Evidence Anchors from that stream and the final canonical table
objects rather than maintaining independently authoritative views. This is a
breaking pre-production replacement for v1 with no compatibility shim: it adds
complexity to ingestion, but prevents Markdown/table drift, keeps uncertain
semantics and reading order explicit, and gives annotations and later grounded
extraction stable logical locations without moving schema or model behavior
into `parsing_service`. Exact multi-page table fragment fields remain gated on
the real Docling fixture required by ADR 0004.
