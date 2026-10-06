## ADDED Requirements

### Requirement: An uploaded spreadsheet version carries its answer rows

Uploading a spreadsheet to a Project Context SHALL append an immutable version
that keeps the header row it already reads for schema suggestion and the data
rows below it, so one upload serves both schema suggestion and evaluation.
Uploading SHALL NOT mutate or replace a prior version.

#### Scenario: An upload appends a version with rows

- **WHEN** a researcher uploads a workbook whose first worksheet has a header
  row and answer rows
- **THEN** the appended version carries the column names and the data rows, and
  its revision number is one greater than the current version

#### Scenario: Schema suggestion still reads only the header row

- **WHEN** the uploaded version is used to suggest an Extraction Schema
- **THEN** the suggestion uses the column names exactly as before and no answer
  cell becomes a schema field or field type

#### Scenario: A malformed workbook appends no version

- **WHEN** the uploaded file is not a readable workbook or its first worksheet
  has no usable header row
- **THEN** the request is refused with an invalid-request result and no version
  is appended

### Requirement: Rows map to Source Documents by a named column

A gold corpus version SHALL identify each answer row's Source Document through
the file-name column, matched against the Project Context's Source Documents,
without treating that column as a field. A row that matches no Source Document
SHALL be reported with both the row's file name and the known documents, and
SHALL NOT be silently dropped.

#### Scenario: A row names a Source Document

- **WHEN** a row's file-name cell matches a Source Document of the Project
  Context
- **THEN** the row is associated with that document and the file-name column is
  absent from the answer fields

#### Scenario: A row names no known Source Document

- **WHEN** a row's file-name cell matches no Source Document in the Project
  Context
- **THEN** the version reports the unmatched file name and the known documents,
  and evaluation refuses or reports the row as unmapped

#### Scenario: Several rows belong to one document

- **WHEN** a document has more than one answer row, as a record collection needs
- **THEN** every row is retained for that document in row order

### Requirement: Gold corpus versions are owned, immutable and pinned

A gold corpus version SHALL belong to exactly one Project Context's owner, SHALL
be readable and usable only through that ownership, and SHALL be named by every
evaluation that reads it so a later upload cannot change a past result.

#### Scenario: A re-upload appends rather than edits

- **WHEN** a corrected answer sheet is uploaded after an earlier version
- **THEN** a new version is appended and the earlier version and its rows remain
  unchanged

#### Scenario: An evaluation names its gold version

- **WHEN** a round stores its metrics
- **THEN** it names the gold corpus version and the version's content digest it
  was scored against

#### Scenario: Another account cannot reach the corpus

- **WHEN** a different Researcher Account requests the Project Context's gold
  corpus version
- **THEN** the request is refused as not found and no rows are returned

### Requirement: Exhaustiveness is recorded with the version

A gold corpus version SHALL record whether its answers are exhaustive for the
scored documents. An exhaustive version makes a prediction with no gold
counterpart a false positive; a non-exhaustive version reports such predictions
as unscored extras.

#### Scenario: A standard answer sheet is exhaustive by default

- **WHEN** a version is uploaded without an explicit exhaustiveness choice
- **THEN** it is recorded as exhaustive and unmatched predictions count as
  false positives

#### Scenario: A partial sheet keeps extras unscored

- **WHEN** a version is recorded as non-exhaustive
- **THEN** predictions with no gold counterpart are listed as unscored extras
  and precision is reported with that convention stated
