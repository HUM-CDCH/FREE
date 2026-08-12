## ADDED Requirements

### Requirement: Documents are sectioned by recurring heading shape, not every heading

When a document's canonical Markdown contains level-1 headings, the system SHALL determine record-section boundaries by normalizing each heading (lowercase, digits stripped, punctuation stripped) and selecting only the shape that recurs at least twice, rather than treating every level-1 heading as a boundary. Headings that do not match the recurring shape SHALL remain part of whichever section they fall inside.

#### Scenario: Recurring "Grav N" headings become section boundaries

- **WHEN** a document's Markdown contains level-1 headings "Grav 8", "Grav 13", "Grav 24", "Grav 26", "Grav 28", "Grav 30", "Grav 31", interleaved with 4 other level-1 headings that do not share that shape
- **THEN** the system produces exactly 7 sections, one per "Grav N" heading, in document order
- **AND** the 4 non-matching headings and their text remain inside whichever "Grav N" section they physically fall within

#### Scenario: No recurring shape means no sectioning

- **WHEN** a document's level-1 headings are all structurally distinct (e.g. "Introduction", "Methods", "Results", each appearing once)
- **THEN** the system produces no sections
- **AND** extraction falls back to a single whole-document call

### Requirement: A schema is eligible for sectioning only when its sole extraction target is one repeated array

The system SHALL attempt document sectioning only when an extraction schema's only non-metadata top-level field is a singleton array-of-objects (the schema's repeated-record shape). A schema that mixes a top-level scalar field alongside the repeated array SHALL NOT be sectioned.

#### Scenario: Single repeated-array schema qualifies

- **WHEN** a schema's template is `{ "entries": [{ "name": "string" }] }`
- **THEN** the schema qualifies for sectioning

#### Scenario: Mixed scalar-and-array schema does not qualify

- **WHEN** a schema's template is `{ "site_name": "string", "entries": [{ "name": "string" }] }`
- **THEN** the schema does not qualify for sectioning
- **AND** extraction uses a single whole-document call so `site_name` is not silently left unextracted

### Requirement: Each section is extracted independently and concurrently

When a document is sectioned, the system SHALL run one extraction call per section against only that section's own text and the array's item template, with multiple sections' calls running concurrently up to a fixed concurrency limit, rather than one call per section run sequentially or one call covering the whole document.

#### Scenario: Multiple sections extract concurrently

- **WHEN** a document is split into 7 sections
- **THEN** the system issues one extraction call per section, with up to the configured concurrency limit in flight at once
- **AND** the final result preserves the sections' original document order regardless of which section's call completes first

### Requirement: Per-section page numbers are computed deterministically, not model-reported

The system SHALL compute each section's absolute starting page by counting page-break sentinels in the full document Markdown up to that section's offset, and SHALL add that offset to every page number in the section's extracted evidence, rather than trusting a page number the model reports for a section it only saw in isolation.

#### Scenario: A later section's evidence page is offset to the document's absolute page

- **WHEN** a section begins after 1 page-break sentinel in the full document Markdown, and the model's extraction for that section reports a field's page as `1`
- **THEN** the system records that field's evidence page as `2`, not `1`

### Requirement: Table-awareness is evaluated per section

The system SHALL determine whether a section's own Markdown body contains a table independently for each section, and SHALL only add table-evidence instructions (row/column header slots) to sections whose own body has a table, regardless of whether other sections in the same document have tables.

#### Scenario: One section has a table, a sibling section does not

- **WHEN** a document is sectioned into two sections, one containing a Markdown table and one containing only prose
- **THEN** the table-containing section's extraction call requests row/column header evidence
- **AND** the prose-only section's extraction call does not

### Requirement: Sectioning is empty-result-safe

The system SHALL exclude a section's extracted item from the final result when every value in that item is empty (empty string, null, or an empty/all-empty array or object), rather than including a placeholder record for a section that did not actually describe a record instance.

#### Scenario: A non-record section (e.g. a document's introduction folded into a heading) yields no entry

- **WHEN** a sectioned extraction call for one section returns an item whose every field is empty
- **THEN** that section contributes no entry to the final result array

### Requirement: Sectioning requires an explicit researcher-chosen Catalog strategy

The system SHALL support a reserved `_strategy: 'catalog' | 'article'` marker, read by `getExtractionStrategy`, and SHALL only attempt document sectioning when `_strategy` is exactly `'catalog'`. A document/schema with `_strategy: 'article'`, or with no `_strategy` provided, SHALL always use a single whole-document extraction call, regardless of whether the schema and heading structure would otherwise qualify for sectioning. `_strategy` SHALL never be treated as an extraction target: it SHALL be excluded from the schema's evidence-wrapped template sent to the model, from the "sole top-level key" check that determines a schema's repeated-array field, and from any extraction result the system returns.

#### Scenario: Catalog-strategy schema may be sectioned

- **WHEN** a schema has `_strategy: 'catalog'`, qualifies structurally for sectioning, and its document has a recurring heading pattern
- **THEN** extraction uses the sectioned path

#### Scenario: Article-strategy schema is never sectioned, even if it would otherwise qualify

- **WHEN** a schema has `_strategy: 'article'`, and its document's headings happen to share a recurring shape (e.g. generically numbered sections)
- **THEN** extraction always uses a single whole-document call
- **AND** no per-section extraction calls are made

#### Scenario: Unset strategy defaults to whole-document extraction

- **WHEN** a schema has no `_strategy` key set
- **THEN** extraction uses a single whole-document call

#### Scenario: `_strategy` never reaches the model or the result

- **WHEN** a template's `_strategy` key is wrapped with evidence, or an extraction result is split back into result/evidence
- **THEN** `_strategy` does not appear in the prompt sent to the model
- **AND** `_strategy` does not appear in the returned result or evidence objects

### Requirement: The researcher's Catalog/Article choice is scoped to the current document, not persisted or request-scoped

The system SHALL let a researcher choose Catalog or Article for the schema currently being worked on, defaulting to Article (never auto-section) until the researcher chooses otherwise. This choice SHALL reset only when a new source document is opened — NOT when a schema is (re)generated, whether generated explicitly by the researcher or automatically in response to a strategy change (see the regeneration requirement below) — and SHALL NOT require re-selection between an initial run and a re-run of the same schema. The system SHALL NOT require a schema-library or save/recall persistence layer to support this.

#### Scenario: Choice persists across a run and re-run of the same schema

- **WHEN** a researcher sets the strategy to Catalog, runs extraction, and re-runs extraction without changing the schema
- **THEN** both runs use the Catalog strategy without the researcher re-selecting it

#### Scenario: Choice resets on a new document, not on a regenerated schema

- **WHEN** a researcher opens a new source document after previously choosing Catalog for a prior document
- **THEN** the new document starts with the strategy defaulted to Article
- **WHEN**, instead, the researcher generates or regenerates a schema for the same still-open document
- **THEN** the previously chosen strategy is unchanged

### Requirement: Changing the strategy after a schema exists automatically regenerates it

The system SHALL automatically regenerate the schema when the researcher changes the Catalog/Article strategy while a schema already exists or a prior generation attempt failed, since the strategy shapes the schema-generation guidance itself (a schema generated under the previous strategy no longer matches the new one). The system SHALL NOT trigger regeneration when there is no schema yet to regenerate (before the researcher has generated one for the first time).

#### Scenario: Switching strategy on an existing schema triggers regeneration

- **WHEN** a researcher switches from Article to Catalog (or vice versa) while a schema is already displayed
- **THEN** the system regenerates the schema using the newly selected strategy, without the researcher needing to press "Regenerate" separately

#### Scenario: Switching strategy after a failed generation retries with the new strategy

- **WHEN** a researcher switches strategy while the schema panel shows a generation error
- **THEN** the system starts a new generation attempt using the newly selected strategy

#### Scenario: Switching strategy before any schema exists does not trigger generation

- **WHEN** a researcher switches strategy before ever generating a schema for the current document
- **THEN** the system only records the choice and does not start a generation request

### Requirement: The Catalog/Article choice is made before schema generation and shapes the generated schema's structure

The system SHALL let a researcher choose Catalog or Article before generating a schema, not only after, and SHALL pass that choice to schema generation. When the strategy is `'catalog'`, schema-generation guidance SHALL instruct the model to describe the shape of one occurrence directly, without wrapping the schema in an array to represent the repeated occurrences itself — since sectioned extraction already supplies that repetition. When the strategy is `'article'` or unset, schema-generation guidance SHALL instruct the model as it did before this capability existed: a genuine repeating sub-list within the document SHALL still be modeled as an array field, since no external per-section repetition applies.

#### Scenario: Catalog strategy produces one-occurrence-shaped guidance

- **WHEN** a researcher selects Catalog before generating a schema
- **THEN** the schema-generation request instructs the model to design the schema as the shape of one section/record, not as an array of them

#### Scenario: Article strategy (or no selection) keeps the pre-existing array guidance

- **WHEN** a researcher selects Article, or generates a schema without choosing either
- **THEN** the schema-generation request retains the pre-existing guidance to model a genuinely repeating sub-list as an array field

#### Scenario: The strategy selector is available before a schema exists

- **WHEN** the schema panel has no schema yet, is generating one, or shows a generation error
- **THEN** the Catalog/Article selector is still visible and usable, not hidden until a schema is ready
