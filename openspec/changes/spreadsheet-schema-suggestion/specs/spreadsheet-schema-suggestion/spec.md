## ADDED Requirements

### Requirement: A schema suggestion can be derived from the project's current spreadsheet before a schema exists

FREE SHALL derive a schema suggestion from a Project Context's current
spreadsheet version (`project-spreadsheet-storage`) for a Project Context
that has no Extraction Schema yet. FREE SHALL NOT require an inline file
upload as part of creating the suggestion — the spreadsheet SHALL already
have been uploaded separately.

#### Scenario: Suggestion creation with no existing schema

- **WHEN** a researcher requests a spreadsheet-derived suggestion for a
  Project Context with no Extraction Schema, whose current spreadsheet
  version is already uploaded
- **THEN** FREE derives a schema suggestion from that version's columns
  without requiring a schema to already exist

#### Scenario: No current spreadsheet is a reportable error, not a crash

- **WHEN** a researcher requests a spreadsheet-derived suggestion for a
  Project Context with no uploaded spreadsheet version
- **THEN** FREE reports that no spreadsheet has been uploaded yet, rather
  than deriving a suggestion from nothing

### Requirement: Column values are inferred into a schema-suggestion template

FREE SHALL infer a field type per spreadsheet column from its non-empty
cell values (numeric columns become `number`/`integer`; a small, repeated
set of distinct strings becomes a `string` field with `allowedValues`;
otherwise `string`), assemble the inferred columns into the flat template
shape `templateToNodes` already accepts, and reuse `templateToNodes`
(`packages/extraction/src/schema.ts`) to produce the suggested
`SchemaNode[]` — FREE SHALL NOT implement a second, separate template-to-
schema conversion.

#### Scenario: A numeric column infers a numeric field

- **WHEN** a column's non-empty values all parse as numbers
- **THEN** the suggested schema's corresponding field has a numeric type

#### Scenario: A small repeated value set infers an enum

- **WHEN** a column's non-empty values are drawn from a small, repeated set
  of distinct strings
- **THEN** the suggested schema's corresponding field is a `string` field
  with `allowedValues` set to that distinct set

### Requirement: A researcher-specified separator turns column headers into hierarchy

FREE SHALL let the researcher optionally specify a hierarchy separator
character (e.g. `.` or `_`) at suggestion-creation time — not at upload
time, so the same uploaded spreadsheet can be retried with a different
separator without re-uploading. When one is specified, FREE
SHALL split each column header on that separator into a path and group
columns sharing a path prefix into a nested object in the template handed
to `templateToNodes`, rather than treating every column as a flat
top-level field. When no separator is specified, FREE SHALL treat every
column header literally, with no splitting.

#### Scenario: A dot separator produces nested fields

- **WHEN** a researcher specifies `.` as the separator and the spreadsheet
  has columns `measurement.temperature` and `measurement.unit`
- **THEN** the suggested schema has one `measurement` object field with
  `temperature` and `unit` as its children

#### Scenario: No separator means flat fields

- **WHEN** a researcher specifies no separator and the spreadsheet has a
  column named `measurement.temperature`
- **THEN** the suggested schema has one top-level field literally named
  `measurement.temperature`, not a nested `measurement` object

#### Scenario: A column name that is both a leaf and a group prefix is an error

- **WHEN** a separator is specified and the spreadsheet has both a column
  named `measurement` and a column named `measurement.temperature`
- **THEN** FREE reports an error identifying the conflicting columns rather
  than silently choosing whether `measurement` is a scalar field or an
  object

### Requirement: The spreadsheet-derived suggestion reuses the existing suggestion draft/edit/confirm flow

FREE SHALL route a spreadsheet-derived schema suggestion through the same
draft-edit-confirm pipeline used for model-generated batch suggestions
(`useBatchSchemaSuggestion`/`batchSchemaSuggestionMachine`), as an
alternative suggestion source, not a parallel confirmation mechanism. A
researcher SHALL be able to edit a spreadsheet-derived field's name, type,
or `allowedValues` before confirming, exactly as they can for a model-
generated suggestion. Confirming a spreadsheet-derived suggestion SHALL NOT
change the behavior of confirming a model-generated one.

#### Scenario: A misinferred column type is correctable before confirming

- **WHEN** a spreadsheet-derived field's inferred type is wrong
- **THEN** the researcher can edit it in the same draft review step used
  for model-generated suggestions, before it becomes a real `SchemaRevision`

#### Scenario: Model-generated suggestions are unaffected

- **WHEN** a researcher creates a model-generated (document-grounded)
  batch suggestion
- **THEN** its draft/edit/confirm behavior is unchanged by the existence of
  the spreadsheet-derived suggestion source

### Requirement: Confirming a spreadsheet-derived suggestion does not require any document sources

FREE SHALL allow confirming a spreadsheet-derived suggestion (producing a
real `SchemaRevision`) even though it has zero document sources — the
document-grounded flow's requirement of at least one source applies only
to that flow, not to a spreadsheet-derived one.

#### Scenario: A spreadsheet-derived suggestion confirms with no sources

- **WHEN** a researcher confirms a spreadsheet-derived suggestion, which
  has no `BatchSchemaSuggestionSource` rows
- **THEN** FREE creates the corresponding `SchemaRevision` rather than
  rejecting the confirmation as not ready

### Requirement: Column-to-field identity survives edits and is exposed on confirmation

FREE SHALL track which spreadsheet column produced which suggested field
by a stable identifier through the draft/edit step, independent of the
field's current name, and SHALL expose that column-to-field mapping as
part of the confirmed result so a downstream consumer can map spreadsheet
columns to final field names/ids without re-matching by header text.

#### Scenario: A renamed field is still traceable to its column

- **WHEN** a researcher renames a spreadsheet-derived field before
  confirming
- **THEN** the confirmed result's column-to-field mapping still identifies
  which column produced that field, keyed by the tracked identifier rather
  than the original (now stale) column header text

### Requirement: A spreadsheet-derived suggestion pins the spreadsheet version it was built from

FREE SHALL record which `project-spreadsheet-storage` version a
spreadsheet-derived suggestion was built from, so a downstream consumer can
read the exact same rows later, however long after creation that happens,
even if the project's spreadsheet has since been re-uploaded.

#### Scenario: A later re-upload does not change what an existing suggestion points to

- **WHEN** a Project Context's spreadsheet is re-uploaded after a
  spreadsheet-derived suggestion already exists
- **THEN** the existing suggestion's pinned spreadsheet version is
  unchanged
- **AND** it still refers to the version that was current when it was
  created, not the new one
