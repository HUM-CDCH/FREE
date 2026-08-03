<!-- markdownlint-disable MD013 -->

# parsed-document-v2 Specification

## ADDED Requirements

### Requirement: Version 2 replaces the version 1 document contract

Completed PDF ingestion SHALL eventually publish `parsed_document.v2` from both document routes without a version 1 projection, compatibility shim, or per-request negotiation. Version 1 cache and completed-task migration behavior SHALL remain an explicit implementation gate until separately resolved.

#### Scenario: Completed v2 task document is requested

- **WHEN** a client requests either document route for a completed v2 task after route migration
- **THEN** both routes return the same `parsed_document.v2` contract

### Requirement: Successful v2 ingestion has verified physical-page identity

Every canonical block, fragment, occurrence, page span, and Evidence Anchor SHALL use a verified 1-based physical page. Version 2 SHALL reuse the existing displayed-page geometry fields `width_pt`, `height_pt`, and `rotation`. Optional `BoundingBox` values SHALL use `x0`, `y0`, `x1`, and `y1` in PDF points with a top-left origin in displayed page space. Ingestion SHALL fail with a stable error when physical-page mapping cannot be proven.

#### Scenario: Geometry is available

- **WHEN** a fragment or cell occurrence has verified geometry
- **THEN** its box references the occurrence's physical page
- **AND** the box is valid under that page's geometry metadata

#### Scenario: Page mapping cannot be proven

- **WHEN** usable document-level text exists but physical pages cannot be verified
- **THEN** v2 ingestion fails with a stable error
- **AND** does not invent page identity

### Requirement: Canonical content is a typed semantic stream

Version 2 SHALL publish physically ordered parser-observed heading, paragraph, generic text, list, code, formula, caption, table-reference, and page-boundary blocks. Every block SHALL have a deterministic generation-scoped ID, verified page, parser provenance, and an exact canonical span when it renders source text. Geometry SHALL be optional and absent when unverified.

#### Scenario: OCR semantics are not proven

- **WHEN** page-local OCR supplies ordered text without reliable semantic kind
- **THEN** v2 emits a generic text block
- **AND** does not infer a more specific kind

### Requirement: Derived views share one canonical source

Canonical Markdown, page spans, table placement, logical tables, and Evidence Anchors SHALL derive from the final content stream, logical cells, fragments, and mappings. Publication SHALL fail closed when any reference, mapping, span, or regenerated table rendering disagrees.

#### Scenario: Derived view is inconsistent

- **WHEN** a reference does not resolve or a rendered table differs from its canonical cells and fragment mapping
- **THEN** the generation is not committed

### Requirement: Table semantics have one authority and parser roles remain explicit

Docling SHALL define content, structure, roles, and proven spans within each observed fragment when available. FREE's deterministic canonicalizer SHALL own continuation and logical coordinate mapping. Camelot SHALL NOT replace Docling semantics and MAY add only missing verified geometry after an exact fragment-semantic match, or provide an attributed fallback when no Docling inventory exists. Content, structure, and geometry attribution SHALL remain distinct.

#### Scenario: Camelot adds missing geometry

- **WHEN** a Camelot candidate exactly matches a Docling fragment's normalized matrix and structure
- **AND** its geometry is safely compatible
- **THEN** only missing geometry is added
- **AND** Docling remains content and structure authority

#### Scenario: Parser semantics disagree

- **WHEN** a candidate differs from Docling content, roles, or proven spans
- **THEN** it is not merged or substituted
- **AND** a stable typed disagreement diagnostic is published

### Requirement: DocTags placement uses page-local unique matching

A DocTags table slot SHALL link to a page-local inventory fragment only through producer identity or a unique normalized content-and-structure match on that page. A non-unique or mismatched slot SHALL NOT assert inline placement. Its affected canonical fragment SHALL remain in that page's `unplaced_content`, and a stable typed placement diagnostic SHALL be published.

#### Scenario: Slot match is ambiguous

- **WHEN** more than one page-local inventory fragment can match a DocTags slot
- **THEN** no candidate is inserted at that slot
- **AND** affected fragments remain page-local unplaced content

#### Scenario: Unplaced fragment is rendered

- **WHEN** a page contains one or more `UnplacedTableReference` values
- **THEN** canonical Markdown renders their fragments in deterministic reference order under an explicitly labelled appendix at the end of that physical page
- **AND** each rendering derives from the same logical cells and fragment mapping used by inline tables
- **AND** no position among the page's ordered blocks is implied

### Requirement: Canonical Markdown uses one reserved page marker

Canonical Markdown SHALL begin every physical page with exactly `<!-- FREE:PAGE n -->`, where `n` is its 1-based physical page number. The marker SHALL be renderer metadata outside source Evidence spans. `---` SHALL have no page semantics.

#### Scenario: Source collides with reserved marker syntax

- **WHEN** source text contains a line matching the reserved page-marker grammar
- **THEN** ingestion fails with stable `reserved_page_marker_collision`
- **AND** does not escape, rewrite, or silently alter source text

### Requirement: Logical tables contain ordered page-local fragments

Every producer-observed table SHALL first have a deterministic generation-scoped page-local `fragment_id`. `ParsedTable` SHALL contain `table_id`, logical-root `cells`, and a non-empty `fragments` array whose array order is the canonical physical order. Each `TableFragment` SHALL contain `fragment_id`, `page_number`, optional `slot_id`, optional `bbox`, and fragment-local root `cells`. Every placed `TableReferenceBlock` SHALL contain `block_id`, `page_number`, `table_id`, and `fragment_id`; every `UnplacedTableReference` SHALL contain `table_id` and `fragment_id`.

#### Scenario: One logical table has two fragments

- **WHEN** deterministic continuation admits page-local fragments on pages 2 and 3
- **THEN** v2 publishes one logical table with two ordered fragment identities
- **AND** each page's table-reference block identifies its corresponding fragment

### Requirement: Continuation detection is conservative and deterministic

FREE SHALL join two fragments only when they are on consecutive pages; their DocTags slots are adjacent after ignoring verified page furniture; every slot has one unique page-local inventory match; normalized columns and structure are compatible; caption and header state are compatible; no narrative content interrupts the boundary; and predecessor and successor matching is unique in both directions. No LLM SHALL infer continuation or break ties.

#### Scenario: All continuation conditions hold

- **WHEN** a body-only or uniquely compatible repeated-header fragment follows its unique compatible predecessor on the next page with only page furniture between their adjacent slots
- **THEN** both fragments belong to one logical table

#### Scenario: Narrative interrupts the boundary

- **WHEN** narrative content occurs between candidate slots
- **THEN** the fragments remain separate page-local logical tables

#### Scenario: Fragments are definitely incompatible

- **WHEN** a required compatibility condition deterministically fails
- **THEN** the fragments remain separate page-local logical tables
- **AND** no continuation-ambiguity diagnostic is required

#### Scenario: Continuation is ambiguous

- **WHEN** multiple predecessors, successors, or repeated-header mappings remain plausible
- **THEN** the fragments remain separate page-local logical tables
- **AND** v2 publishes stable `table_continuation_ambiguous` with the involved fragment IDs

### Requirement: Repeated headers preserve physical observations without logical duplication

A producer-observed continuation header SHALL map uniquely to existing logical header cells and add ordered page-scoped physical occurrences. It SHALL NOT add logical rows. If mapping is not unique and structurally compatible, continuation SHALL be rejected as ambiguous. A renderer-generated repeated header SHALL create no source occurrence, geometry, span, or Evidence location.

#### Scenario: Producer repeats a compatible header

- **WHEN** a continuation fragment contains a header uniquely matching the logical header
- **THEN** its cells map to existing logical header root coordinates
- **AND** only physical occurrences are added

#### Scenario: Renderer repeats a header

- **WHEN** the renderer adds a header to make a body-only fragment readable
- **THEN** no source location or anchor occurrence is created for that rendering

### Requirement: Fragment cells map to logical root cells

Every `FragmentCell` SHALL contain fragment-local `row` and `col`, target `logical_row` and `logical_col`, and optional `bbox`. Each target SHALL resolve one logical root cell containing `row`, `col`, `text`, optional `role`, `rowspan`, and `colspan`. Covered coordinates SHALL NOT have independent logical cells, fragment cells, locations, or anchors.

#### Scenario: Merged cell spans covered positions

- **WHEN** a root logical cell spans multiple grid positions
- **THEN** producer occurrences map to the root coordinate
- **AND** covered positions receive no independent cell anchor

### Requirement: Page-scoped geometry remains optional and local

Every fragment cell SHALL inherit its physical page from its containing fragment and MAY retain a `BoundingBox` valid on that page. Missing geometry SHALL remain absent and SHALL NOT be copied from another occurrence or page. A logical cell MAY therefore have multiple page-scoped fragment cells with partial geometry.

#### Scenario: Geometry exists for only one occurrence

- **WHEN** a repeated logical header cell is observed on two pages but only one occurrence has verified geometry
- **THEN** that box is retained on its own occurrence
- **AND** the other occurrence has no fabricated box

### Requirement: EvidenceIndex contains deterministic block and root-cell anchors

Version 2 SHALL publish one `BlockAnchor` per anchorable textual block and one `TableCellAnchor` per canonical logical root cell. `BlockAnchor` SHALL contain only `anchor_id` and `block_id`; `block_id` SHALL resolve exactly one anchorable block, whose `page_number` and exact canonical `char_span` supply the anchor's physical page and span without duplication. The span's offset units remain an implementation gate. `TableCellAnchor` SHALL contain `anchor_id`, `table_id`, logical `row` and `col`, and ordered `locations`. Each location SHALL contain only `fragment_id`, fragment-local `row`, and fragment-local `col`, and SHALL resolve exactly one `FragmentCell`; page and optional geometry SHALL resolve through that fragment cell rather than being duplicated in the anchor. Source text SHALL come from referenced canonical content. IDs SHALL be deterministic only within `content_sha256 + preprocess_id`.

#### Scenario: Text block is anchored

- **WHEN** an anchorable textual block is published
- **THEN** its `BlockAnchor.block_id` resolves that block's verified physical page and exact canonical character span

#### Scenario: Logical cell lacks geometry

- **WHEN** a logical root cell and its page occurrence are verified but no box is safe
- **THEN** its cell anchor remains valid without geometry

### Requirement: Canonical anchors remain parser facts

Model-returned pages, snippets, or block selections SHALL NOT create or alter canonical block, fragment, logical-cell, or anchor facts.

#### Scenario: Model proposes different Evidence

- **WHEN** a model proposal disagrees with deterministic parser facts
- **THEN** the canonical parser facts remain unchanged

### Requirement: Later implementation gates remain explicit

The character-offset versus UTF-8-byte-offset convention and completed task-local v1 migration SHALL be resolved before their dependent v2 production tasks. Package scope, quota, deterministic metadata, and archive behavior SHALL be specified only in a separate future OpenSpec change. This design correction SHALL NOT imply a choice for any of them.

#### Scenario: Production implementation reaches a deferred gate

- **WHEN** an implementation task depends on a deferred v2 or package decision
- **THEN** that task remains blocked until the decision is explicitly specified and tested

### Requirement: Version 2 is PDF-specific

This contract SHALL accept only PDF Source Documents and SHALL retain physical-page semantics as mandatory.

#### Scenario: Non-PDF source is submitted

- **WHEN** a client submits a non-PDF Source Document to v2 ingestion
- **THEN** ingestion rejects it with a client-safe source-type error
