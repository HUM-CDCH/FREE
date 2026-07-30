# Parsing quality policy

These policies govern the implemented `parsed_document.v2` publication.

## Canonical stream and spans

The typed page-scoped semantic stream is authoritative for canonical Markdown,
table placement, physical-page coverage, and Evidence. Every emitted span is a
half-open UTF-8 byte range into the exact Markdown bytes; character indices are
not part of the contract. Page markers are renderer metadata and stay outside
text Evidence spans.

## Tables

Docling inventory is authoritative for table content, roles, structure, and
proven spans. Camelot runs only in bounded areas and only when its normalized
content and structure exactly match a Docling table while monotonically adding
missing geometry. Camelot-only candidates are excluded from canonical output.
Missing geometry remains absent. Rotated pages suppress unsafe geometry rather
than publishing guessed coordinates.

Every canonical cell has one producer-backed table-cell anchor. The anchor
keeps physical page and page-local offsets distinct from derived logical row and
column identity. Page spans contain no repeated anchor-ID collection.

## Continuation

A cross-page logical table requires reviewed producer facts: matching OTSL
matrices, a header-bearing first fragment, a body-only next fragment, and only
page furniture/page breaks between them. Narrative, caption, new-header,
malformed, adjacency-only, textual-similarity-only, and ambiguous cases remain
separate. No capture-digest allowlist or generated identity can admit a merge.

## OCR

PaddleOCR fallback is page-local and emits generic text blocks unless semantic
structure is explicitly proven. Invalid boxes, confidence values, and line
arrays are rejected with typed diagnostics; non-finite values never reach JSON.

## Package and route invariants

Route and package JSON are the same portable v2 payload. The package contains
only the source PDF, canonical JSON, canonical Markdown, and digest manifest.
Raw parser output and cache paths remain internal.

## Verification

Focused tests cover UTF-8 spans, producer-backed Evidence, reviewed continuation
negatives, Camelot exclusion/enrichment, OCR validation, deterministic ZIP
bytes, route 404 behavior, and strict current-task reconciliation. Run the CPU
profile backend suite with `uv run --no-sync`.
