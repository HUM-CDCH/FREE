<!-- markdownlint-disable MD013 -->

# Design: publish-parsed-document-v2

## Context

`parsed_document.v1` was deliberately designed around one canonical Markdown view, verified page spans, page-local OCR fallback, a canonical table collection, immutable generations, and task-local API projections. The active `harden-canonical-parsing-service` change corrects v1 fidelity and operational defects while explicitly deferring a schema change for multi-page table Evidence.

The v1 pipeline currently builds Markdown from DocTags before final table arbitration. `ParsedTable.markdown_view` is then rendered independently from the final table matrix. These views normally agree but have no construction-level guarantee. Docling inventory and Camelot candidates are reconciled conservatively, but the single `source_parser` field can label a table as Camelot-derived even when Camelot supplied only missing geometry and Docling still supplied every semantic value. Mismatched or unmatched table representations also have no public, stable disagreement model. `EvidenceIndex` is an untyped empty placeholder, semantic document structure is not a uniform public stream, and v1 table geometry assumes one `page_number`. The task/archive output is also tied to service-owned paths and retention rather than being a portable ingestion result.

FREE-technical supplies useful behavioral precedent without defining the new contract: DocTags tables remain inline when their placement is known, separately extracted tables are page-labelled appendices rather than assigned invented reading order, captions remain text, and raw parser data stays operational. It does not provide typed page-scoped logical tables, canonical Evidence Anchors, contract versioning, or a portable package.

This change is therefore a dependent follow-up, not another batch in the hardening change. Implementation is blocked until hardening task 2.5 captures a real Docling multi-page table fixture.

## Goals / Non-Goals

**Goals:**

- Publish a PDF-specific `parsed_document.v2` with verified physical-page identity.
- Make a typed semantic content stream the single authority for ordering and rendered text.
- Guarantee that canonical Markdown tables and typed canonical tables come from the same final table objects.
- Keep Docling as the semantic table authority, constrain Camelot to exact-match geometry enrichment or explicit no-inventory fallback, and make every disagreement visible.
- Attribute table content, structure, and geometry independently so parser participation is not mistaken for semantic ownership.
- Represent one logical table across pages without collapsing Evidence onto one page.
- Publish deterministic, generation-scoped logical Evidence Anchors for text blocks and table cells.
- Transfer the original Source Document and canonical result out of the retention-bound cache as a deterministic package.
- Replace v1 cleanly while FREE is pre-production.

**Non-goals:**

- Schema suggestion, model prompts, hierarchical record detection, or extraction orchestration.
- Model-generated evidence proposals, matching proposals, or rejecting ungrounded Extraction Results.
- Project Context, annotation, Extraction Schema, Extraction, or Review Decision persistence.
- Durable source/history ownership inside `parsing_service`.
- Non-PDF formats, canonical figure crops, image understanding, or raw diagnostic export.
- Choosing the exact multi-page table fragment field shape before the prerequisite fixture exists.

## Decisions

### 1. Keep v2 separate and fixture-gated

`publish-parsed-document-v2` depends on the parsing-fidelity work in `harden-canonical-parsing-service`. Its first task inspects the real multi-page Docling fixture and freezes page-fragment fields before model implementation starts. Behavioral invariants are specified now; payload fields that depend on producer reality are not guessed.

**Rejected:** implementing v2 inside the hardening batches. That contradicts the hardening proposal's merge strategy and non-goals.

### 2. Replace v1 without compatibility behavior

Both `/document` and `/parsed-document` return v2 after the change. Existing v1 cache entries miss because v2 changes the schema and preprocessing identity. There is no v1 projection, route split, query negotiation, or deprecation window. `/markdown` keeps its existing purpose but serves the v2-derived canonical artifact.

**Rationale:** FREE is not in production and Studio currently consumes `/markdown`, not the document JSON. Carrying two authority models would add risk without protecting a real client.

### 3. Use semantic content blocks as the canonical source stream

The v2 document contains one physically page-scoped ordered stream. An illustrative block union is:

```text
heading       text, level
paragraph     text
text          text                         # semantic kind unverified
list          ordered, items
code          text, language when observed
formula       text
caption       text
table         table_id
page_break    next_page
```

Every block has a deterministic `block_id`, `page_number`, parser provenance, and optional verified geometry. Text-rendering blocks receive exact canonical Markdown spans after rendering. Blocks describe parser-observed document structure only; they never describe domain records, entities, or schema fields.

Lists, code, formulas, and captions follow the hardened DocTags rendering policy. OCR fallback emits `text` unless semantic kind is proven. Figure captions remain caption blocks; no figure block or crop is added in this change.

### 4. Preserve page-local unplaced content explicitly

Ordered blocks contain only verified reading order. A fallback-only table whose page is known but whose position is not is retained in `ParsedDocument.tables` and referenced by that page's `unplaced_content`. Canonical Markdown renders unplaced tables in an explicitly labelled page-local appendix, never as if they occurred after a particular paragraph.

This mirrors FREE-technical's distinction between inline DocTags tables and separately appended page-labelled tables while making uncertainty machine-readable.

### 5. Render Markdown and table views from one canonical table authority

DocTags conversion produces semantic blocks and table slots rather than permanently rendering an independent table body. Table canonicalization completes before rendering. Each verified table slot then references its final logical `ParsedTable`; its readable Markdown is rendered from the final matrix. Fallback-only tables use the unplaced appendix.

Docling inventory is authoritative for table content, structure, roles, and parser-proven spans. A Camelot candidate may enrich a Docling table only when its normalized matrix and structural signature match exactly, its table and existing-cell geometry overlap safely, and it monotonically adds verified geometry. Enrichment fills only missing boxes and never replaces Docling values, roles, spans, or existing boxes. When no Docling inventory exists, a validated Camelot table may become an explicitly attributed fallback; an unmatched Camelot candidate cannot silently supplement a non-empty Docling inventory.

Table attribution is role-specific rather than collapsed into one `source_parser`: the contract distinguishes at least semantic content source, structure source, and geometry source. A geometry-only Camelot contribution therefore does not claim ownership of Docling semantics. Exact field names are frozen with the v2 models, but this distinction is an invariant.

A DocTags table slot is linked inline only when producer identity or normalized content/structure proves the match to the final canonical table. A mismatch never causes silent substitution: the final table is retained as page-local unplaced content, the ambiguous inline placement is not asserted, and a stable diagnostic records the disagreement. Camelot semantic mismatch is likewise rejected and retained only in internal diagnostics. These rules turn disagreement into explicit uncertainty rather than competing canonical tables.

Canonical Markdown, `ParsedTable.markdown_view`, typed cells, and table-cell anchors therefore share one source. Publication checks reconstruct the Markdown table from typed cells and reject disagreement. The table collection remains typed even though the same canonical values have a readable rendering; ingestion does not publish a second independently authoritative Camelot appendix.

### 6. Use explicit physical-page markers

Each page begins with a reserved marker such as:

```text
<!-- FREE:PAGE 3 -->
```

The exact reserved syntax is frozen with fixtures and escaped/rejected if source content could collide. Page markers are renderer metadata, not source text, and are excluded from Evidence spans. `---` remains available as ordinary source Markdown and no longer carries page identity.

Verified physical-page mapping is mandatory for v2. The v1 document-level fallback for old exporters becomes a stable v2 ingestion failure because it cannot support annotation-ready blocks or anchors.

### 7. Publish a typed block-and-cell EvidenceIndex

The current untyped placeholder is replaced by a discriminated anchor union. An illustrative text anchor contains:

```text
anchor_id, preprocess_id, block_id, page_number,
char_span, bbox?
```

An illustrative table-cell anchor contains:

```text
anchor_id, preprocess_id, table_id, row, col,
rowspan, colspan, page-scoped location(s), bbox?
```

One text anchor is produced per anchorable text block and one cell anchor per canonical logical cell. Anchors reference canonical block/cell content instead of duplicating document text inside the index. Exact subspans can later be resolved inside a text block without sentence segmentation becoming part of ingestion. Merged-cell anchoring follows the final table schema selected from the fixture.

Logical identity is sufficient: verified geometry enriches an anchor but is not required. Anchor IDs are deterministic only within `content_sha256 + preprocess_id`; changed parsing policy establishes a new namespace.

### 8. Model multi-page tables as one logical object

ADR 0004 remains authoritative: page continuation does not create unrelated table identities. The v2 table must separate logical grid identity from page-scoped Evidence/geometry. The real fixture decides whether producer Evidence maps naturally to table fragments, per-cell locations, or both. The selected shape must retain partial verified geometry without assigning missing fragments to the first page.

This is the sole open schema question. No implementation beyond fixture inspection and contract finalization starts while it remains unresolved.

### 9. Keep parsing_service a processor and cache

Task directories, sources, and canonical generations retain the hardening change's expiry, quota, lock, and pruning behavior. v2 does not add Project Context ownership or permanent generation pins. Durable ownership is transferred through a self-contained package.

Anchor identity includes `preprocess_id`, and the package contains the corresponding full v2 contract. External persistence can therefore retain the exact generation it references without relying on parsing-service cache lifetime.

### 10. Export a deterministic canonical ZIP

The default package has a fixed layout, finalized during task 5 but equivalent to:

```text
manifest.json
source.pdf
parsed_document.json
artifacts/document.llm.md
```

`parsed_document.json` embeds canonical pages, blocks, tables, and EvidenceIndex. Its artifact references use package-relative logical paths; route responses use the same logical references rather than absolute/service-owned paths.

`manifest.json` records package version, `parsed_document.v2`, source hash, `preprocess_id`, and path/media-type/size/SHA-256 for every other entry. ZIP entry ordering, DOS-epoch timestamp, Unix mode, UTF-8 naming, and canonical LF text bytes are fixed. Entries use `ZIP_STORED` so compressor/library variation cannot change package bytes. Assembly rejects path aliases, traversal, duplicate normalized names, undeclared entries, and digest mismatch.

The original source is included because Evidence must remain reviewable after cache expiry. Raw Docling JSON, raw DocTags, inspection output, task metadata, and parser debug artifacts are never exported. They remain internal cache diagnostics and may expire.

### 11. Commit only internally consistent generations

The pending-generation workflow validates:

- every block/page/table/anchor reference;
- complete physical-page coverage;
- exact block and page Markdown spans;
- table Markdown regenerated from final typed cells;
- no ordered reference to unplaced content;
- unique generation-scoped IDs;
- canonical text artifact digest and LF bytes;
- package-relative artifact references.

Any mismatch removes the pending generation and fails closed. Internal storage integrity records from the hardening change remain separate from the public v2 and package manifests.

## Risks / Trade-offs

- **[Producer fixture contradicts the assumed logical model]** → Keep table-fragment fields blocked and amend the v2 spec/design before implementation.
- **[Semantic block extraction varies across Docling versions]** → Scope IDs to `preprocess_id`, retain generic `text`, and test raw-to-block fixtures under the converter-policy revision.
- **[A canonical block stream increases schema size]** → Expose semantic rather than visual/token-level blocks; keep parser diagnostics internal.
- **[Synchronized table rendering requires reliable table slots]** → Use page/order/provenance plus exact normalized matrix/structure matching, retain unmatched tables as explicitly unplaced, and reject ambiguous inline placement.
- **[Docling, DocTags, and Camelot disagree]** → Preserve Docling semantic tables, reject semantic replacement, separate parser attribution by role, emit stable diagnostics, and retain conflicting candidates only as internal debug artifacts.
- **[Docling inventory is incomplete]** → Do not let broad Camelot discovery silently create a second authority; use fixture-backed fallback admission and report unmatched candidates for later policy refinement.
- **[Mandatory page mapping reduces compatibility with old exporters]** → Fail with a stable capability code and document the minimum supported exporter rather than publishing annotation-incomplete v2.
- **[Including the source makes packages large]** → Retain explicit archive limits and streamed response locking; avoid base64 JSON envelopes and raw diagnostics.
- **[Deterministic ZIP behavior differs by platform/library]** → Fix every ZIP metadata field and add byte-for-byte cross-run tests.
- **[No v1 shim makes rollback incompatible]** → Roll back code and invalidate/rebuild v2 tasks rather than serving mixed contracts; acceptable before production.

## Migration Plan

1. Land the prerequisite hardening parsing-fidelity work and real multi-page table fixture.
2. Inspect the fixture, freeze exact v2 table fragment/cell Evidence fields, and revalidate this change before implementation.
3. Introduce v2 models and canonical block normalization behind tests without changing public routes.
4. Derive synchronized Markdown, tables, pages, and EvidenceIndex from the block stream; bump schema and converter-policy cache identity.
5. Implement and validate the deterministic canonical package.
6. Switch both document routes and the archive route atomically to v2; retain `/markdown` with v2 bytes.
7. Treat v1 cache entries as misses and rebuild from content-addressed sources.
8. Run focused fixtures, full backend tests, golden E2E, real Docling integration, package determinism tests, and diagnostics.

## Open Questions

- **Blocked on prerequisite fixture:** Does real Docling multi-page table Evidence require table-level page fragments, per-cell location lists, or both? The answer must preserve one logical table, page-scoped Evidence, partial geometry, and logical cell spans.
