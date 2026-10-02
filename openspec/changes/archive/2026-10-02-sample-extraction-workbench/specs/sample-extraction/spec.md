## ADDED Requirements

### Requirement: A single Extraction may be admitted with a page scope

Studio SHALL admit a single Extraction with an optional page scope: a sorted,
duplicate-free list of physical, one-based PDF page numbers within the Source
Document's page count, at most 30 pages. An Extraction admitted with a scope is a
Sample Extraction. An Extraction without a scope SHALL behave exactly as before.
Batch Extraction SHALL refuse a scope.

#### Scenario: Sample around the viewed page

- **WHEN** the researcher views page 13 and runs a sample on pages 12–14
- **THEN** one Extraction is admitted with scope `[12, 13, 14]` on the Current
  Schema Revision and the saved Extraction Method

#### Scenario: Invalid scope is refused before anything is enqueued

- **WHEN** a scope names page 0, a page beyond the page count, a repeated page
  or more than 30 pages
- **THEN** admission is refused with a researcher-facing reason and no workflow
  is enqueued

#### Scenario: Batch with a scope

- **WHEN** a Batch Extraction request carries a page scope
- **THEN** it is refused

### Requirement: Scope is admission identity, not Extraction Method

The page scope SHALL be stored on the Extraction at admission, SHALL be part of
replay equality, and SHALL NOT be part of the Extraction Method, the saved-method
check or method attribution.

#### Scenario: Retry with a different scope

- **WHEN** an Extraction ID already admitted with pages 12–14 is requested again
  with pages 12–15
- **THEN** the request is a conflict and nothing is re-run

#### Scenario: Scope does not trip the saved-method check

- **WHEN** a sample is requested with the method its start view showed
- **THEN** admission does not report `method_changed` because of the scope

### Requirement: The Parsing Service extracts only the scoped pages

The `extract` request SHALL accept `options.pages`. With it, Article and generic
Catalog SHALL read only passages on those pages. Recipe Catalog SHALL segment the
whole document as for a full run and extract only the entries with a span on
those pages, under their segmentation block identities, with headings and
glossary in force as in the full run. Document-level fields SHALL read only the
scoped pages. The artifact SHALL echo `pages`, and coverage and `complete` SHALL
be computed over the scope.

#### Scenario: Recipe catalogue sample keeps whole-document segmentation

- **WHEN** a recipe Catalog sample on pages 12–14 runs on a document whose
  segmentation is already published
- **THEN** the published whole-document segmentation is reused unchanged
- **AND** the artifact's `record_blocks` name only entries with a span on pages
  12–14

#### Scenario: Article sample

- **WHEN** an Article sample runs on pages 12–14
- **THEN** its inventory and values cite only passages on pages 12–14

### Requirement: Unscoped requests keep their fingerprints

An `extract` request without `pages` SHALL produce the same options record and
fingerprint as before this change. A scoped request SHALL include its page list
in its fingerprint.

#### Scenario: Existing golden artifacts

- **WHEN** the recorded golden and replay fixtures run without `pages`
- **THEN** their fingerprints are unchanged

### Requirement: Samples stay out of whole-document views

A Sample Extraction SHALL NOT be a document's latest attempt or latest reviewed
result, and SHALL NOT count in project summaries or activity. Studio SHALL list a
document's Sample Extractions for its current Source Representation separately,
each labelled with its pages and Schema Revision. A sample's completeness SHALL
be shown as completeness for its pages.

#### Scenario: Reopening after a sample

- **WHEN** a document has a reviewed full Extraction and a newer reviewed sample
- **THEN** reopening it shows the full Extraction as latest attempt and latest
  reviewed
- **AND** the sample appears only in the sample history
