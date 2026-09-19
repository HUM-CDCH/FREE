## ADDED Requirements

### Requirement: A project has one versioned, append-only spreadsheet slot

FREE SHALL let a researcher upload a spreadsheet to a Project Context as
its own action, independent of any other action that consumes it.
Uploading again SHALL append a new version rather than replacing a prior
one, mirroring `SchemaRevision`'s versioning.

#### Scenario: Re-uploading appends, does not replace

- **WHEN** a researcher uploads a second spreadsheet to a Project Context
  that already has one
- **THEN** FREE creates a new version with the next revision number
- **AND** the prior version remains stored and unchanged

#### Scenario: Upload requires no existing schema or suggestion

- **WHEN** a researcher uploads a spreadsheet to a Project Context that has
  no Extraction Schema and no prior suggestion
- **THEN** FREE stores it as the project's first spreadsheet version

### Requirement: Any consumer can read the current version by project

FREE SHALL let any action resolve a Project Context's current spreadsheet
version — the most recently appended one — without needing to know about
or re-supply the original upload.

#### Scenario: Current version reflects the latest upload

- **WHEN** a Project Context has multiple spreadsheet versions
- **THEN** reading its current version returns the one with the highest
  revision number

#### Scenario: No spreadsheet uploaded yet is not an error

- **WHEN** a Project Context has never had a spreadsheet uploaded
- **THEN** reading its current version returns an explicit empty result,
  not an error

### Requirement: A stored version retains parsed columns for reuse, not just a file reference

FREE SHALL store each spreadsheet version's parsed columns (column name and
per-row values), not only a reference to the uploaded file, so a later
consumer (schema suggestion, and eventually gold-record population) can
read the data directly without re-parsing the original file.

#### Scenario: Columns are available without the original file

- **WHEN** a consumer reads a spreadsheet version some time after it was
  uploaded
- **THEN** it receives the parsed columns directly, not a pointer requiring
  the original file to be re-fetched and re-parsed
