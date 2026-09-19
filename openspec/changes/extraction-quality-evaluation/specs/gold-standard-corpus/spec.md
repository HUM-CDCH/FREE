## ADDED Requirements

### Requirement: Evaluation corpora are named, versioned, and held fixed

FREE SHALL support a named `EvaluationCorpus` whose membership (which
documents belong to it) and `GoldRecord`s are captured as an append-only
`EvaluationCorpusVersion`, mirroring `SchemaRevision`'s versioning: editing
a gold annotation or the document set SHALL append a new version, never
mutate an existing one. An `EvaluationRun` (see `evaluation-run-tracking`)
SHALL reference one specific `EvaluationCorpusVersion`, so correcting a gold
annotation later never changes what an already-computed run reported.

#### Scenario: Correcting a gold record appends a new version

- **WHEN** an expert corrects a `GoldRecord`'s field value
- **THEN** FREE creates a new `EvaluationCorpusVersion` with the correction
- **AND** every prior `EvaluationCorpusVersion` and any `EvaluationRun` that
  referenced it remain unchanged

#### Scenario: Corpus documents are referenced, not duplicated

- **WHEN** a document is added to an `EvaluationCorpus`
- **THEN** FREE stores a reference to its existing `sourceDocumentId`/
  `sourceRepresentationRevisionId`
- **AND** no separate copy of the document's content is created

### Requirement: Gold records are curated per document, shaped like the target schema

FREE SHALL store one or more `GoldRecord`s per document in an
`EvaluationCorpusVersion`, each holding expert-curated field values shaped
to match the `SchemaRevision` the corpus is being evaluated against.

#### Scenario: A document with multiple gold records

- **WHEN** a document's gold annotation includes several distinct records
  (e.g. one per species in a multi-species table)
- **THEN** FREE stores each as its own `GoldRecord` under that document
  within the `EvaluationCorpusVersion`

### Requirement: An upload declares whether it seeds gold data, alongside seeding a schema

FREE SHALL let the researcher choose, when creating a schema suggestion
from the project's current spreadsheet (via `spreadsheet-schema-
suggestion`), whether that suggestion also populates an
`EvaluationCorpusVersion` once it is confirmed (`purpose:
SCHEMA_AND_VALIDATE`) or seeds the schema only (`purpose: SCHEMA`). FREE
SHALL NOT infer this choice from whether cells are filled in. This choice
is independent of uploading the spreadsheet itself — uploading
(`project-spreadsheet-storage`) is purpose-agnostic; purpose applies to
what a given suggestion does with the project's current version.

#### Scenario: Schema-only suggestion never creates gold records

- **WHEN** a researcher creates a spreadsheet-derived suggestion with
  purpose `SCHEMA`
- **THEN** no `GoldRecord`s or `EvaluationCorpusVersion` are created from
  the spreadsheet's row values, even if cells contain values

#### Scenario: Schema-and-validate suggestion populates gold data after confirmation

- **WHEN** a researcher creates a spreadsheet-derived suggestion with
  purpose `SCHEMA_AND_VALIDATE`
- **THEN**, once that suggestion is confirmed into a `SchemaRevision`, FREE
  populates an `EvaluationCorpusVersion` from its pinned
  `projectSpreadsheetVersionId`'s rows against the confirmed schema

### Requirement: A corpus version can be populated from the project's pinned spreadsheet version

FREE SHALL populate an `EvaluationCorpusVersion` (columns are schema field
names, each row is one `GoldRecord`) from the `project-spreadsheet-
storage` version pinned on the confirmed `SCHEMA_AND_VALIDATE` suggestion
(`projectSpreadsheetVersionId`), reading it however long after
confirmation that happens — not from a fresh upload made at confirm time.
FREE SHALL map columns to fields using `spreadsheet-schema-suggestion`'s
confirmed column-to-field mapping, not by re-matching raw column header
text. FREE SHALL NOT require exactly one row per document — multiple rows
sharing the same filename column value SHALL each become their own
`GoldRecord` under that document, so a multi-record document is
representable.

#### Scenario: Population reads the pinned version, not the current one

- **WHEN** a confirmed `SCHEMA_AND_VALIDATE` suggestion's pinned spreadsheet
  version is no longer the project's current version (a newer one was
  uploaded since)
- **THEN** FREE populates the `EvaluationCorpusVersion` from the pinned
  version's rows, not the project's now-current version

#### Scenario: Multiple rows for one filename become multiple gold records

- **WHEN** an uploaded spreadsheet has several rows sharing the same
  filename column value
- **THEN** FREE creates one `GoldRecord` per row, all under that filename's
  document, rather than merging or rejecting the rows

### Requirement: A reserved "filename" column identifies each row's document, and is never a schema field

FREE SHALL treat the spreadsheet column named `filename` (matched
case-and-whitespace-insensitively) as identifying which project document a
row is about, rather than as a value to extract from that document's
content. FREE SHALL exclude this column from schema-seeding (D1b) — it
SHALL NOT appear as a field in the template a suggestion is built from —
regardless of whether the upload's purpose is `SCHEMA` or
`SCHEMA_AND_VALIDATE`.

#### Scenario: A "filename" column never becomes a schema field

- **WHEN** an uploaded spreadsheet has a column named `filename` (in any
  case, with any surrounding whitespace)
- **THEN** the suggestion's proposed schema has no field for that column,
  whether the upload's purpose is `SCHEMA` or `SCHEMA_AND_VALIDATE`

### Requirement: A spreadsheet row's filename resolves to exactly one project document

FREE SHALL resolve each row's filename column against the project's
`SourceDocument`s. Because `source-document-ingestion` makes
`originalName` unique per project, a filename SHALL match at most one
document — FREE SHALL NOT implement any disambiguation path for a
multiple-match case, since it cannot occur. A filename matching zero
documents, or a row with no filename column value, SHALL be reported as an
error, not silently skipped — and SHALL fail the confirmation as a whole
(no `SchemaRevision`, `BatchExtraction`, or partial `GoldRecord` set is
created), rather than a resolvable row's data being persisted alongside a
skipped one. A row with no value in *any* column (e.g. a trailing blank
row from the source spreadsheet) is not treated as an error — it carries
no data to resolve or lose.

#### Scenario: A filename resolves automatically

- **WHEN** a row's filename matches a `SourceDocument` in the project
- **THEN** FREE resolves it without further input

#### Scenario: An unmatched filename fails the whole confirmation, not just that row

- **WHEN** a row's filename matches no `SourceDocument` in the project
- **THEN** FREE reports it as an error identifying the row and filename
- **AND** creates no `SchemaRevision`, `BatchExtraction`, or `GoldRecord`
  from that confirmation attempt, including for the spreadsheet's other,
  resolvable rows

#### Scenario: A wholly blank row is skipped, not an error

- **WHEN** a spreadsheet row has no value in any column, including the
  filename column
- **THEN** FREE does not create a `GoldRecord` for it and does not report
  it as an error

#### Scenario: Multiple spreadsheet rows sharing a filename is not a resolution ambiguity

- **WHEN** a spreadsheet has several rows sharing the same filename column
  value, each resolving to the one project document with that name
- **THEN** FREE resolves every row to that document and creates one
  `GoldRecord` per row (see "A corpus version can be populated from the
  project's pinned spreadsheet version" above) — this is an
  expert-authored choice (e.g. several independent annotations of the same
  document), not a system-side naming collision
