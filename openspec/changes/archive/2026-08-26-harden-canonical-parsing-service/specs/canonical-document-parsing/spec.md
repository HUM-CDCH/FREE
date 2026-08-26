<!-- markdownlint-disable MD013 -->

# canonical-document-parsing Delta Specification

## ADDED Requirements

### Requirement: Canonical geometry uses ordered displayed-page coordinates

Every published table and cell bounding box SHALL use finite ordered PDF-point coordinates in displayed top-left page space. Docling native geometry SHALL be normalized into an ordered origin-labelled inventory representation before conversion. Unverifiable geometry SHALL be absent rather than inverted or guessed.

#### Scenario: Docling emits a BOTTOMLEFT box

- **WHEN** Docling provides `l/t/r/b` with `t > b` under BOTTOMLEFT origin
- **THEN** the inventory stores ordered vertical bounds and retains the origin
- **AND** conversion produces ordered top-left displayed-page coordinates

#### Scenario: Geometry cannot be transformed safely

- **WHEN** page height, origin, rotation transform, or Evidence page identity is unavailable
- **THEN** the canonical box is null and stable warnings are emitted where required

### Requirement: Cross-page OTSL table continuations ignore page furniture

The DocTags converter SHALL merge a body-only OTSL fragment with the preceding logical table when the fragments are separated only by a physical page boundary, wrappers, locations, page headers, or page footers. Page furniture SHALL NOT otherwise be globally reclassified as table content.

#### Scenario: Page header occurs between table fragments

- **WHEN** a header-bearing OTSL table is followed across a physical page break by a body-only fragment
- **AND** a `<page_header>` occurs between them
- **THEN** the converter emits one Markdown table
- **AND** the continuation's first data row is not rendered as a new header

#### Scenario: Narrative content occurs between fragments

- **WHEN** non-furniture source content occurs between OTSL blocks
- **THEN** the converter does not merge the blocks

### Requirement: Empty table detection is a successful outcome

A table adapter that executes successfully and finds no tables SHALL report a successful empty result rather than a parser failure.

#### Scenario: Camelot returns no candidates

- **WHEN** Camelot completes normally with an empty candidate list
- **THEN** table extraction reports success with zero found and kept tables
- **AND** the Source Document is not marked `completed_with_warnings` solely for containing no tables

### Requirement: Source cell text is not confused with missing-value sentinels

Literal string content from Docling SHALL be preserved, including the string `NaN`. Missing-value cleanup SHALL be adapter-specific and SHALL blank only values proven to be non-string missing sentinels.

#### Scenario: Docling cell contains literal NaN

- **WHEN** a Docling table cell contains the text `NaN`
- **THEN** the canonical cell and Markdown view retain `NaN`

#### Scenario: Camelot cell contains a numeric missing sentinel

- **WHEN** a Camelot dataframe cell is a non-string NaN/missing sentinel
- **THEN** the canonical cell text is empty and standards-compliant JSON is emitted

### Requirement: Canonical Markdown preserves supported block semantics

The DocTags converter SHALL render unordered and ordered lists with Markdown markers, code with an adaptive fence, and block formulas with separate-line `$$` delimiters. It SHALL preserve source text inside these wrappers and SHALL keep exact page spans aligned to the final rendered Markdown.

#### Scenario: Minified list items are adjacent

- **WHEN** minified DocTags contain adjacent list items without source whitespace
- **THEN** canonical Markdown emits distinct marked list lines and does not concatenate item text

#### Scenario: Code contains a Markdown fence

- **WHEN** source code contains a run of backticks
- **THEN** the converter selects a longer enclosing fence so source code remains unchanged

#### Scenario: Formula block is emitted

- **WHEN** DocTags contain a formula block
- **THEN** canonical Markdown places its content between separate-line `$$` delimiters

#### Scenario: Rendering changes canonical offsets

- **WHEN** list, code, or formula rendering changes page text length
- **THEN** page `CharSpan` values slice the exact final `text_views.llm_markdown`
- **AND** the converter-policy revision changes cache identity

### Requirement: Version 1 fails safe for multi-page table Evidence

Until a later contract version can represent page-scoped multi-page table Evidence, `parsed_document.v1` SHALL detect table provenance across multiple physical pages, retain logical text and structure, suppress misleading single-page geometry, and emit a stable warning.

#### Scenario: One Docling table references multiple physical pages

- **WHEN** a Docling table contains Evidence from more than one physical page
- **THEN** version 1 retains its text, cells, roles, and proven spans
- **AND** does not attribute all geometry to the first page
- **AND** emits a stable multi-page-Evidence warning

### Requirement: Canonical text artifact bytes are deterministic

Canonical text artifacts SHALL be encoded as UTF-8 with LF line endings independently of host newline defaults.

#### Scenario: Identical canonical text is written on different platforms

- **WHEN** the same canonical string is written under different platform newline settings
- **THEN** artifact bytes and SHA-256 digests are identical
- **AND** in-memory `/markdown` text and page spans remain unchanged
