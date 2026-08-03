## Context

Catalog extraction already splits canonical Markdown by record headings and
runs section calls concurrently. It records source Markdown/page bounds on
Evidence leaves, while parsed tables and anchors arrive separately from the
cached parsing-service document. The highlighter can therefore scope prose,
but lacks an explicit reusable identity connecting a result segment to its
geometry.

## Goals / Non-Goals

**Goals:**

- Give every valid Evidence source scope a deterministic segment identity.
- Build table and anchor ownership once per extraction, before parallel
  highlight resolution.
- Restrict each highlight group to geometry indexed under its own ID.
- Preserve cached parsing-service artifacts and deterministic paint order.

**Non-Goals:**

- Modifying Docling/OCR parsing, cache keys, or parsing-service APIs.
- Asking the model to create IDs, table IDs, or reliable page numbers.
- Guessing table ownership when canonical placement is ambiguous.

## Decisions

### Studio API owns segment identity

`runSectionedExtraction` assigns Catalog IDs as `catalog:<section-index>` from
the original section input order, before asynchronous calls finish. Article
extraction assigns `article:0`. `segment_id` is attached beside Markdown/page
bounds by the existing Evidence scope helper, never exposed in result JSON.

This preserves identity after parallel completion and after empty records are
filtered, because the ID describes the source input rather than the merged
result-array position.

### Build a one-time frontend geometry index

After result/Evidence and parsed-document extras are available, collect unique
source scopes and construct:

```text
segment_id -> { anchors, tables }
```

Anchors are assigned by their canonical Markdown ranges. Tables are considered
only when their `markdown_view` has one canonical occurrence within one source
scope. A table matching zero or multiple scopes is omitted from all entries.
The index is recreated only when document Markdown, parsed geometry, or source
scopes change.

### Parallel resolution consumes immutable local geometry

Highlights group by `segment_id`. Each group resolves with bounded concurrency
using only its indexed anchors/tables. Results are collected by original result
traversal order before canvas drawing, so completion order cannot alter paint
layering, focus, or opacity.

## Risks / Trade-offs

- [Repeated identical table Markdown] -> Leave the table unassigned rather
  than create a cross-record highlight.
- [Legacy Evidence lacks `segment_id`] -> Treat it as unverifiable and omit
  its highlight; current extraction responses always receive the field.
- [A section is filtered after extraction] -> Keep its source ID stable; do
  not derive identity from merged record index.

## Migration Plan

1. Extend source-scope metadata and API tests with `segment_id`.
2. Add a pure geometry-index helper and frontend tests.
3. Switch the highlighter from per-group ownership derivation to index lookup.
4. Run automated tests/build and visually verify same-page records.

Rollback reverts Studio-only code; no parsed document needs regeneration.
