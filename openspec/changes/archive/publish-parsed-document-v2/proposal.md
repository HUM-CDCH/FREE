<!-- markdownlint-disable MD013 -->

# Proposal: publish-parsed-document-v2

## Why

`parsed_document.v1` publishes canonical Markdown, page spans, and page-local tables, but its parallel text, table, and Evidence views can drift. Real Docling inspection also corrected an earlier design premise: continued tables arrive as page-local table items, not one multi-page `TableItem`. FREE needs a frozen v2 contract that can conservatively group those observations into one logical table while retaining page-scoped physical Evidence.

## What Changes

- **BREAKING** Replace `parsed_document.v1` with `parsed_document.v2` on both document routes after the later production phase; no compatibility projection or negotiation is planned before production.
- Publish a typed, ordered, physical-page-scoped content stream as the authority for Markdown, page spans, placement, tables, and typed Evidence Anchors.
- Treat Docling table items as page-local fragments. Group them only through deterministic continuation detection; no LLM infers table continuation.
- Require consecutive pages, adjacent DocTags slots across page furniture, unique page-local slot/inventory matches, compatible columns/structure, compatible caption/header state, and no narrative interruption for a continuation.
- Preserve ambiguous candidates as separate page-local tables, place slot-ambiguous tables in page-local `unplaced_content`, and publish stable typed diagnostics.
- Freeze block anchors, logical tables, ordered fragment identities, fragment-cell-to-logical-cell mappings, page-scoped optional geometry, table-reference blocks, and cell anchors.
- Map observed repeated headers to existing logical header cells as additional physical locations; renderer-generated repeated headers have no source location.
- Give each merged logical cell one root coordinate and anchor; covered coordinates have no independent anchor.
- Render unplaced table fragments from the same canonical tables in an explicitly labelled appendix at the end of their physical page, without inventing reading order.
- Keep Docling authoritative for observed fragment semantics. Camelot may only enrich verified missing geometry or provide an attributed fallback when Docling inventory is absent.
- Freeze `<!-- FREE:PAGE n -->` as the canonical 1-based page marker. A source collision fails with a stable error; source text is never silently escaped or altered.
- Treat model-returned pages and snippets as proposed Evidence. Deterministic parser facts remain authoritative for canonical block, fragment, and cell anchors.

## Capabilities

### New Capabilities

- `parsed-document-v2`: canonical semantic blocks, logical tables over page-local fragments, physical-page identity, and typed Evidence Anchors.

### Modified Capabilities

None. This correction freezes design and tests only; it does not implement v2 production behavior, routes, packages, or Studio orchestration.

## Impact

This design gate updates the v2 OpenSpec artifacts, ADR 0004, a focused DocTags regression, and Ollama probe evidence. Later implementation may affect parsing models, normalization, rendering, routes, and Studio, but none of those production surfaces change here.

## Dependencies and deferred implementation gates

The parsing-fidelity work in `harden-canonical-parsing-service` remains prerequisite. Its tasks 2.5 and 2.6 were closed because real Docling disproved their assumed producer-level multi-page table object; that impossible fixture is no longer a dependency.

These later-phase issues remain explicit implementation gates and are not resolved by this correction:

- whether public character spans count Unicode characters or UTF-8 bytes;
- the package quota conflict, in a separate future package change;
- deterministic package metadata details, in that separate change;
- completed task-local v1 migration behavior.

## Non-goals

- Any v2 production models, parsing behavior, routes, packages, or Studio orchestration.
- LLM-based continuation inference or model authority over canonical anchors.
- Schema suggestion, hierarchical record detection, or Extraction Result policy.
- Persisting Project Contexts, annotations, extraction schemas, extractions, or review decisions.
- Supporting non-PDF sources or canonical figure/image interpretation.
