# evidence-anchor-index Specification

## Purpose
TBD - created by archiving change evidence-highlight-matching-fixes. Update Purpose after archive.
## Requirements
### Requirement: Docling's per-block location tokens are preserved through Markdown conversion, not discarded

The parsing service's DocTags-to-Markdown conversion SHALL preserve each rendered block's `<loc_...>` location tokens (already computed by Docling and normalized to a 0–500 scale relative to page dimensions) by resolving them into anchor records, rather than discarding them via unconditional deletion. This resolution SHALL apply only at the whole-document conversion entry point; location tokens inside table-cell content SHALL continue to be discarded exactly as before, since table cells already have their own dedicated bounding-box pipeline.

#### Scenario: A rendered block's location tokens become an anchor

- **WHEN** the DocTags input contains a block (e.g. a paragraph or heading) preceded by four `<loc_...>` tokens
- **THEN** the converter produces an anchor record for that block's rendered text in the output Markdown, with the block's bounding box resolved from those tokens
- **AND** the literal `<loc_...>` tokens do not appear in the rendered Markdown output

#### Scenario: Table-cell location tokens are unaffected

- **WHEN** the DocTags input contains an OTSL table whose cells carry their own `<loc_...>` tokens
- **THEN** those tokens are discarded during table rendering exactly as before this change
- **AND** no anchor record is produced for table-cell content through this mechanism

#### Scenario: Existing conversion behavior is unchanged when no location tokens are present

- **WHEN** the DocTags input contains no `<loc_...>` tokens at all
- **THEN** the converter's Markdown output is byte-for-byte identical to its output before this change

### Requirement: Each anchor records an absolute Markdown character range, page, and PDF-point bounding box

Each anchor record SHALL carry the character offset range (`markdown_start`, `markdown_end`) it occupies in the final canonical Markdown string, the 1-based page number it falls on, and its bounding box converted from Docling's normalized 0–500 location tokens into absolute PDF-point coordinates using that page's known width and height.

#### Scenario: Bounding box is converted to PDF points, not left normalized

- **WHEN** a block's location tokens are `<loc_100><loc_50><loc_400><loc_450>` on a page with known width/height in points
- **THEN** the anchor's bounding box is expressed in PDF points (each normalized value divided by 500 and multiplied by the page's width or height as appropriate), not left as raw 0–500 integers

#### Scenario: Anchor's markdown range reflects the final composed document, not an intermediate rendering pass

- **WHEN** a block is rendered partway through the conversion pipeline (before later passes such as page composition run)
- **THEN** its anchor's recorded `markdown_start`/`markdown_end` reflect that block's position in the final, fully-composed Markdown string returned to callers, not its position in any intermediate representation

### Requirement: Anchors are exposed via the existing evidence index, not a new endpoint

Resolved anchor records SHALL populate `ParsedDocument.evidence_index.anchors`, an existing field that has always been empty pending this capability, so they are already reachable through the existing `/tasks/{id}/document` (or `/tasks/{id}/parsed-document`) response with no new API surface.

#### Scenario: Anchors are present in the canonical document response

- **WHEN** a document is parsed after this capability ships
- **THEN** `evidence_index.anchors` in that document's canonical response is populated with one entry per resolved anchor, in document order

#### Scenario: Documents parsed before this capability ships remain valid

- **WHEN** a previously-parsed task's stored canonical document has no anchors (parsed before this change)
- **THEN** `evidence_index.anchors` is an empty list, exactly as it always was, and consumers already tolerant of an empty list continue to work unchanged

