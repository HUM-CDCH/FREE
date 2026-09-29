## ADDED Requirements

### Requirement: Field-scoped flag action in the review grid

The review grid SHALL allow a researcher to flag a schema field (not an
individual cell/value) as problematic, scoped to that field within the
current `schemaRevisionId`.

#### Scenario: Flagging a field does not affect other fields or documents

- **WHEN** a researcher flags a field in the review grid
- **THEN** the system records a flag for that field on the current
  `schemaRevisionId`
- **AND** no other field, document, or `ReviewDecision` is affected

#### Scenario: Re-flagging the same field is idempotent

- **WHEN** a researcher flags a field that already has an open flag on the
  current revision
- **THEN** the system updates the existing flag rather than creating a
  duplicate

### Requirement: Flagging offers a jump to the schema editor with context

When a researcher flags a field, the system SHALL offer a one-click action
that navigates to the schema editor carrying that field's name and
available sample evidence as initial context.

#### Scenario: Schema editor opens with flagged-field context

- **WHEN** a researcher selects the jump action after flagging a field
- **THEN** the schema editor opens with that field's name and sample
  evidence pre-populated as context for the edit

### Requirement: Committing a schema edit re-pilots the same documents

The system SHALL re-run extraction for the same pilot documents that were
active in the round a schema-issue flag came from, against a new
`SchemaRevision` committed after the researcher jumps from that flag to the
schema editor.

#### Scenario: Same pilot documents re-extracted under new revision

- **WHEN** a researcher flags a field in an active pilot round, jumps to the
  schema editor, and commits a new `SchemaRevision`
- **THEN** the system extracts the same set of pilot documents from that
  round against the new revision
- **AND** does not require the researcher to re-select pilot documents

### Requirement: Open flags are cleared when the schema changes

The system SHALL mark open schema-issue flags for an `ExtractionSchema` as
resolved when a new `SchemaRevision` is committed for it.

#### Scenario: Flags do not persist as open across a revision change

- **WHEN** a new `SchemaRevision` is committed for an `ExtractionSchema`
  that has open schema-issue flags
- **THEN** those flags are marked resolved
- **AND** the new revision starts with no open flags
