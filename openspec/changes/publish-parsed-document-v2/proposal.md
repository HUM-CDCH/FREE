<!-- markdownlint-disable MD013 -->

# Proposal: publish-parsed-document-v2

## Why

`parsed_document.v1` safely publishes canonical Markdown, page spans, and page-local tables, but its text, table, and Evidence representations are parallel views that can drift and it cannot represent one logical table with page-scoped Evidence across physical pages. After `harden-canonical-parsing-service` proves the real Docling multi-page table payload, FREE needs a versioned PDF-ingestion contract whose content, tables, Markdown, and Evidence Anchors derive from one canonical source representation and can leave the retention-bound parsing cache as a portable package.

## What Changes

- **BREAKING** Replace `parsed_document.v1` with `parsed_document.v2` on both document routes; no legacy projection, compatibility shim, or version negotiation is introduced because FREE is not yet in production.
- Require verified physical-page mapping for every successful v2 PDF ingestion.
- Introduce a typed, ordered, schema-agnostic content stream containing parser-observed headings, paragraphs, generic text, lists, code, formulas, captions, table references, and page boundaries.
- Make the content stream authoritative for canonical Markdown, page spans, table placement, and a typed `EvidenceIndex`.
- Establish one semantic table authority: Docling supplies canonical table content, structure, roles, and proven spans; Camelot may only enrich missing geometry for an exact semantic match or act as an explicitly attributed fallback when no Docling inventory exists.
- Render canonical Markdown tables from the final canonical `ParsedTable` objects so Markdown and typed cells cannot disagree; do not publish an independently authoritative Camelot table appendix.
- Record content, structure, and geometry parser attribution separately instead of overloading one `source_parser`, and publish stable diagnostics when DocTags placement, Docling inventory, or Camelot candidates disagree.
- Represent a table continuing across physical pages as one logical table with page-scoped Evidence, as decided by ADR 0004; freeze the exact fragment fields only after the real Docling fixture from the hardening change is inspected.
- Publish block and table-cell Evidence Anchors scoped to the source hash and preprocessing generation; logical anchors remain valid when visual geometry is unavailable.
- Emit explicit physical-page markers in canonical Markdown and retain exact character spans against the emitted bytes.
- Keep valid tables with unverifiable reading-order placement in page-local `unplaced_content` rather than inventing an inline position.
- Produce a deterministic canonical ZIP containing the original Source Document, `parsed_document.v2`, canonical Markdown, and a digest manifest with package-relative references.
- Exclude raw Docling, DocTags, inspection, and other parser diagnostics from the portable package; they remain retention-bound internal artifacts.

## Capabilities

### New Capabilities

- `parsed-document-v2`: the versioned PDF-ingestion contract for canonical content blocks, synchronized Markdown and tables, physical-page identity, and typed Evidence Anchors.
- `canonical-ingestion-package`: the deterministic portable package that transfers the original Source Document and canonical ingestion result out of the parsing cache.

### Modified Capabilities

None. This change depends on the still-active `harden-canonical-parsing-service` change and introduces its own v2 capabilities rather than widening that change's v1 hardening scope.

## Impact

- `prototypes/parsing_service/app/models/parsed_document.py` and the parsing normalization/orchestration pipeline.
- DocTags conversion, OCR page fallback, canonical table arbitration, Markdown rendering, manifests, cache identity, and generation publication.
- `GET /tasks/{id}/document`, its `/parsed-document` alias, `GET /tasks/{id}/markdown`, and `GET /tasks/{id}/download`.
- Backend schema, DocTags table-slot conversion, Docling/Camelot reconciliation, parser attribution, table-disagreement diagnostics, Evidence, archive, cache, golden, and real-Docling tests.
- `docs/parsing-service.md`, `docs/parsing-quality.md`, ADR 0004, and a new v2 authority-model ADR.

## Dependencies

- `harden-canonical-parsing-service` task 2.5 MUST produce or check in a small real Docling fixture demonstrating one logical table with Evidence on multiple physical pages.
- Its parsing-fidelity and deterministic-text requirements MUST land before v2 implementation begins.
- The exact v2 multi-page table fragment fields remain blocked until that fixture is inspected.

## Non-goals

- Model calls, prompt construction, schema suggestion, hierarchical record detection, or Extraction Result policy.
- Persisting Project Contexts, annotations, extraction schemas, extractions, or review decisions.
- Turning `parsing_service` into a durable Source Document repository; it remains a processor and rebuildable cache.
- Supporting non-PDF Source Documents in v2.
- Canonical figure/image blocks or visual interpretation; captions remain textual blocks and the original Source Document remains in the package.
- Exporting raw parser diagnostics in the canonical package.
