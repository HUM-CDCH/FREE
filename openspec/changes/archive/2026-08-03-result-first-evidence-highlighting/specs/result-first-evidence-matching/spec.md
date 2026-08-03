## ADDED Requirements

### Requirement: Schema-directed primary match term
The system SHALL construct a highlight instruction for each non-empty primitive
result leaf with usable Evidence and `source_scope` from the
mirrored result, Evidence, and schema leaf. A non-empty string whose schema
leaf type is `verbatim-string` SHALL use its displayed result value as the
primary prose match term. All other primitive result types SHALL use the
Evidence `snippet` as the primary prose match term.

#### Scenario: Verbatim string matches its displayed result
- **WHEN** a `verbatim-string` result leaf contains a non-empty string and
  usable scoped Evidence
- **THEN** prose resolution first searches that result string inside the
  Evidence source scope
- **AND** it does not require the Evidence value to be a string

#### Scenario: Numeric result retains evidence highlighting
- **WHEN** a numeric, boolean, or other non-string primitive result leaf has
  usable scoped Evidence
- **THEN** the system constructs a `snippet-primary` highlight instruction
- **AND** the result remains eligible for table or prose highlighting

### Requirement: Scoped conditional snippet fallback for verbatim strings
The system SHALL attempt the Evidence snippet only within the same source scope
when a result-primary prose term has zero or more than one resolvable anchor
occurrence inside its source scope. It SHALL use a unique scoped snippet match
as the fallback location and SHALL omit the highlight when the fallback is also
inconclusive.

#### Scenario: Result wording is absent but evidence context is unique
- **WHEN** a verbatim-string result cannot be found in its source scope
- **AND** its Evidence snippet resolves uniquely inside that scope
- **THEN** the system highlights the snippet-derived anchor location

#### Scenario: Duplicate result has unique evidence context
- **WHEN** a verbatim-string result occurs multiple times in its source scope
- **AND** its Evidence snippet resolves uniquely in that scope
- **THEN** the system uses the snippet-derived location
- **AND** it does not select a result occurrence outside that context

#### Scenario: No scoped match is conclusive
- **WHEN** neither the result term nor the Evidence snippet identifies one
  unambiguous anchored location in the source scope
- **THEN** no highlight is drawn for that result leaf
- **AND** no document-wide or PDF text-layer search occurs

### Requirement: Table cells use result text with evidence disambiguators
For a result leaf with table geometry available, the system SHALL search table
cells using the displayed result value. It SHALL restrict candidates to the
Evidence source scope page range and use `row_header` and `column_header` as
disambiguators before applying scoped occurrence or record-table tie-breakers.

#### Scenario: Result value and headers identify one cell
- **WHEN** multiple in-scope table cells contain the displayed result value
- **AND** Evidence row and column headers identify one of those cells
- **THEN** the system highlights that cell

#### Scenario: Evidence page range excludes an identical cell
- **WHEN** an identical result value occurs in tables inside and outside the
  Evidence source scope page range
- **THEN** only in-scope cells are candidates
- **AND** an out-of-scope cell is never highlighted

### Requirement: Scoped table membership is deterministic and page-independent
For every Evidence leaf with `source_scope`, the system SHALL construct its
table candidate set before matching. A table SHALL belong to that set only when
parsing has attached a valid `canonical_markdown_start/end` range wholly within
the scope. The system SHALL exclude tables with ambiguous or missing source
placement and SHALL NOT use the model-provided Evidence `page` to select among
scoped table candidates.

#### Scenario: Two segments share one PDF page
- **WHEN** two source scopes occupy the same page and each has a uniquely
  placed table Markdown view
- **THEN** each result leaf considers only the table belonging to its own
  source scope
- **AND** the model-provided page cannot select the other segment's table

#### Scenario: Table lacks canonical source linkage
- **WHEN** parsing cannot link a table geometry record to one canonical range
- **THEN** the table is excluded from that scope's candidates
- **AND** the frontend does not re-search its `markdown_view`
