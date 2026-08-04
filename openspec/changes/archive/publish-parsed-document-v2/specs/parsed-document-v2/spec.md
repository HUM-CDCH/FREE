<!-- markdownlint-disable MD013 -->

# parsed-document-v2 Specification

## ADDED Requirements

### Requirement: Version 2 replaces the version 1 document contract

Completed PDF ingestion SHALL publish `parsed_document.v2` from both document routes. The service SHALL NOT publish a version 1 projection, compatibility shim, or per-request version negotiation. Version 1 cache entries SHALL be cache misses under the v2 preprocessing identity.

#### Scenario: Completed task document is requested

- **WHEN** a client requests either `GET /tasks/{id}/document` or `GET /tasks/{id}/parsed-document` for a completed v2 task
- **THEN** both routes return the same `parsed_document.v2` contract

#### Scenario: Only a version 1 cache entry exists

- **WHEN** a Source Document has a valid `parsed_document.v1` cache entry but no valid v2 generation
- **THEN** the service rebuilds v2 from the content-addressed source rather than projecting or serving v1

### Requirement: Successful v2 ingestion has verified physical-page identity

Every canonical content block, page span, and Evidence Anchor in a successful v2 PDF ingestion SHALL be assigned to its verified physical page. The service SHALL fail v2 ingestion with a stable capability or parsing error when physical-page mapping cannot be proven.

#### Scenario: Physical-page export is complete

- **WHEN** Docling or page-local OCR supplies canonical content for every inspected physical page
- **THEN** v2 publishes page-scoped blocks and spans for exactly those pages

#### Scenario: Exporter cannot prove page mapping

- **WHEN** usable document-level text exists but its physical pages cannot be verified
- **THEN** v2 ingestion fails with a stable error
- **AND** does not publish document-level blocks with invented page identity

### Requirement: Canonical content is a typed semantic stream

Version 2 SHALL publish an ordered stream of parser-observed content blocks. Supported block meaning SHALL include heading, paragraph, generic text, list, code, formula, caption, table reference, and physical page boundary. Each block SHALL have a deterministic generation-scoped ID, physical page, parser provenance, and a character span when it renders text into canonical Markdown. Geometry SHALL be optional and SHALL be absent when unverified.

#### Scenario: Docling reports semantic structure

- **WHEN** Docling identifies a heading, paragraph, list, code block, formula, caption, or table in source order
- **THEN** v2 emits the corresponding typed block without re-inferring extraction-domain concepts

#### Scenario: OCR supplies text without reliable semantics

- **WHEN** page-local OCR supplies ordered text but cannot prove whether it is a heading, paragraph, caption, or list
- **THEN** v2 emits a generic text block
- **AND** does not infer a more specific semantic kind

#### Scenario: Source contains a captioned non-text figure

- **WHEN** ingestion observes textual caption content for a figure
- **THEN** v2 retains the caption as a caption block
- **AND** does not create a canonical figure interpretation or crop artifact

### Requirement: Derived views share one canonical source

Canonical Markdown, page character spans, table placement, and Evidence Anchors SHALL be derived from the final canonical content stream and final canonical tables. Publication SHALL fail closed if these views are internally inconsistent.

#### Scenario: Canonical table receives geometry enrichment

- **WHEN** an exact semantic match safely adds missing table or cell geometry
- **THEN** the table's Markdown rendering remains derived from the Docling-authoritative `ParsedTable`
- **AND** the canonical Markdown table and typed cells contain the same values, roles, and spans
- **AND** no semantic value, role, span, or existing geometry is replaced by the enrichment

#### Scenario: Derived span does not slice emitted Markdown

- **WHEN** any page, block, or text-anchor character span does not slice the exact canonical Markdown bytes it claims
- **THEN** the generation is not committed

### Requirement: Table semantics have one authority and parser roles remain explicit

Docling inventory SHALL define canonical table content, structure, roles, and proven spans when it is available. Camelot SHALL NOT replace those semantics. Camelot MAY fill missing geometry only for an exact normalized matrix and structure match with safely overlapping geometry, or MAY provide an explicitly attributed fallback table when no Docling inventory exists. The contract SHALL distinguish semantic content source, structure source, and geometry source rather than representing all parser participation as one undifferentiated source.

#### Scenario: Camelot adds missing geometry to a Docling table

- **WHEN** Camelot reports the same normalized matrix and structural signature as a Docling inventory table
- **AND** its table and existing-cell boxes safely overlap the Docling geometry
- **AND** it supplies strictly more verified cell geometry
- **THEN** only missing geometry is copied into the canonical table
- **AND** content and structure remain attributed to Docling
- **AND** geometry records the Camelot contribution

#### Scenario: Camelot content or structure differs

- **WHEN** a Camelot candidate differs from the Docling matrix, roles, or proven spans
- **THEN** it is not merged into or substituted for the canonical Docling table
- **AND** a stable disagreement diagnostic is emitted
- **AND** the conflicting candidate remains an internal diagnostic artifact rather than a second canonical table

#### Scenario: Docling inventory is unavailable

- **WHEN** no valid Docling inventory table exists
- **AND** a Camelot fallback passes canonical table admission rules
- **THEN** the fallback may be published with content, structure, and geometry attribution that explicitly identifies Camelot

### Requirement: DocTags placement and canonical tables cannot disagree silently

A DocTags table slot SHALL reference a canonical table inline only when producer identity or normalized content and structure prove the match. A slot mismatch SHALL NOT cause an unrelated table to be substituted at that reading-order position. The canonical table SHALL remain available as page-local unplaced content, and the service SHALL emit a stable placement-disagreement diagnostic.

#### Scenario: DocTags slot matches the canonical table

- **WHEN** a DocTags table slot and final canonical table have proven identity or matching normalized content and structure
- **THEN** the ordered table-reference block links to that canonical table
- **AND** its Markdown is rendered from the canonical table object

#### Scenario: DocTags slot is ambiguous or mismatched

- **WHEN** a table slot cannot be matched uniquely to a final canonical table
- **THEN** no canonical table is inserted at the ambiguous inline position
- **AND** the affected canonical table is retained under page-local `unplaced_content`
- **AND** a stable disagreement diagnostic is published

### Requirement: Canonical Markdown marks physical pages explicitly

Canonical Markdown SHALL begin each physical page with a reserved marker carrying its 1-based page number. The marker syntax SHALL be unambiguous with source Markdown and SHALL remain outside source-text Evidence spans.

#### Scenario: Multi-page Markdown is rendered

- **WHEN** a three-page Source Document is rendered to canonical Markdown
- **THEN** the output contains one reserved marker for pages 1, 2, and 3 in physical order
- **AND** no ordinary source horizontal rule is interpreted as a page boundary

### Requirement: Table placement never invents reading order

A table with verified document-stream placement SHALL appear as an ordered table-reference block. A valid canonical table whose page is known but whose relative reading-order position is not verified SHALL remain in the table collection and SHALL be referenced from page-local `unplaced_content` with a stable diagnostic.

#### Scenario: Docling table has verified stream placement

- **WHEN** a canonical table is matched to its Docling table position
- **THEN** its table-reference block occupies that verified position in the content stream

#### Scenario: Fallback-only table has no safe placement

- **WHEN** a valid fallback table has a verified physical page but no verified position among page text blocks
- **THEN** v2 lists its reference under that page's `unplaced_content`
- **AND** does not append it to ordered content as if the position were known

### Requirement: One logical table may carry page-scoped Evidence

A table continuing across physical pages SHALL have one stable logical table identity. Its canonical Evidence SHALL preserve the physical page of every represented fragment or cell location, and version 2 SHALL NOT collapse all geometry or Evidence onto the first page. The exact fragment field shape SHALL be frozen only after the prerequisite real Docling fixture is inspected.

#### Scenario: One table continues onto another physical page

- **WHEN** the proven Docling payload identifies one logical table with Evidence on pages 2 and 3
- **THEN** v2 publishes one logical table identity
- **AND** its page-scoped Evidence distinguishes content on pages 2 and 3

#### Scenario: Multi-page geometry is incomplete

- **WHEN** a table's logical cells are known but geometry is verified for only some physical-page fragments
- **THEN** verified page-scoped geometry is retained
- **AND** missing geometry remains absent rather than being copied from another page

### Requirement: EvidenceIndex contains logical block and cell anchors

Version 2 SHALL publish a typed `EvidenceIndex` containing one anchor for every anchorable textual content block and one anchor for every canonical table cell. A text anchor SHALL identify its block, physical page, and exact canonical character span; its source text SHALL be recovered from the referenced canonical content rather than duplicated in the index. A table-cell anchor SHALL identify its logical table, row, column, physical-page Evidence, and proven span; its text SHALL come from the referenced canonical cell. Bounding boxes SHALL be optional enrichments rather than a validity requirement.

#### Scenario: Text block is indexed

- **WHEN** a paragraph or generic text block is rendered into canonical Markdown
- **THEN** its anchor identifies the exact page and character range that reproduces its source text

#### Scenario: Table cell lacks displayed geometry

- **WHEN** a canonical table cell has verified logical identity and page Evidence but no safe displayed-page box
- **THEN** its cell anchor remains valid without a bounding box

### Requirement: Evidence Anchor identity is preprocessing-generation scoped

Evidence Anchor IDs SHALL be deterministic within the combination of source content hash and preprocessing identity. Every anchor reference SHALL carry or resolve through the v2 `preprocess_id`. The service SHALL NOT promise stable anchor IDs across changed parser policy or OCR output.

#### Scenario: Duplicate tasks reuse one generation

- **WHEN** two tasks use identical source bytes and preprocessing identity
- **THEN** they expose identical block, table, and Evidence Anchor IDs

#### Scenario: Converter policy changes

- **WHEN** the same source bytes are rebuilt under a changed converter-policy revision
- **THEN** the new v2 generation has a distinct preprocessing identity
- **AND** its anchor namespace is not treated as interchangeable with the prior generation

### Requirement: Version 2 is PDF-specific

This contract SHALL accept only PDF Source Documents and SHALL retain physical-page semantics as a mandatory invariant. Support for non-paginated or other source formats SHALL require a later profile or contract decision.

#### Scenario: Non-PDF source is submitted

- **WHEN** a client submits a non-PDF Source Document to the v2 ingestion endpoint
- **THEN** ingestion rejects it using the existing client-safe source-type error
