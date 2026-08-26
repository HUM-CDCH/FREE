## ADDED Requirements

### Requirement: Researcher edits append immutable Schema Revisions
FREE SHALL append each acknowledged researcher edit as one immutable Schema Revision containing the exact ordered `SchemaNode[]`, stable node ids, a server-assigned researcher origin, and the next owner-scoped revision number.

#### Scenario: Generated first schema starts durable history
- **WHEN** schema generation finishes for a durable Project Context without an Extraction Schema
- **THEN** FREE creates the shared Extraction Schema and suggestion revision 1 atomically
- **AND** Studio installs its durable identity before allowing edits
- **AND** the history entry point becomes available

#### Scenario: Edit is saved
- **WHEN** a researcher changes the Current Schema Revision and the expected revision number still identifies the head
- **THEN** PostgreSQL contains one new Schema Revision with the submitted ordered tree
- **AND** the response identifies both its Schema Revision id and revision number

#### Scenario: Stale edit loses a race
- **WHEN** two writes use the same expected revision number
- **THEN** exactly one append succeeds
- **AND** the other returns the Current Schema Revision as a conflict
- **AND** no partial Schema Revision is written

### Requirement: Schema history is bounded and owner scoped
FREE SHALL list Schema Revisions only for an Extraction Schema owned by the supplied Project Context, newest revision first, with a required bounded limit. FREE SHALL get a Historical Schema Revision only when the same ownership relationship holds.

#### Scenario: Timeline is reopened in a fresh browser context
- **WHEN** a Project Context is reopened after a schema edit was durably saved
- **THEN** the bounded timeline includes that Schema Revision with its number, origin, timestamp, and derived structural summary

#### Scenario: Schema identity belongs to another Project Context
- **WHEN** a list or get request combines identities that do not share ownership
- **THEN** the request fails without returning Schema Revision metadata or trees

### Requirement: Historical restoration is append-only
FREE SHALL restore a selected Historical Schema Revision by preserving any pending current draft, installing the selected exact ordered `SchemaNode[]` as the editable schema, and appending it as a new Current Schema Revision without modifying an existing row.

#### Scenario: Historical tree is restored
- **WHEN** a researcher selects a Historical Schema Revision
- **THEN** Studio loads its exact ordered `SchemaNode[]` including stable ids
- **AND** durably acknowledges any pending current draft before installing the historical tree
- **AND** immediately appends the installed tree as the next Current Schema Revision
- **AND** schema editing controls remain available

#### Scenario: Selection already represents the current tree
- **WHEN** a researcher selects the Current Schema Revision or a historical tree identical to the acknowledged current tree
- **THEN** the editable tree remains current
- **AND** no Schema Revision is appended

#### Scenario: Restoration cannot be prepared
- **WHEN** the selected revision cannot be loaded or the pending current draft cannot be acknowledged
- **THEN** the visible editable tree remains unchanged
- **AND** no restoration append is attempted

### Requirement: Browser revision DTOs expose only research history
Schema Revision browser DTOs SHALL contain only owner and revision identities, revision number, origin, timestamp, derived summary, and the exact schema tree when requested for restoration. They SHALL exclude raw model output, internal provenance, model attribution, and attempt failure records.

#### Scenario: Timeline and restoration tree are returned
- **WHEN** Studio receives list and get responses
- **THEN** neither response contains raw model output, internal provenance, model attribution, or failure data

### Requirement: Structural summaries are derived
FREE SHALL derive each concise timeline summary from adjacent Schema Revision trees and SHALL NOT persist prose summaries.

#### Scenario: Adjacent revisions differ structurally
- **WHEN** stable-id nodes are added, removed, renamed, retyped, described, or moved between adjacent revisions
- **THEN** the newer revision receives a concise summary of those changes
- **AND** no summary column or parallel history record is written
