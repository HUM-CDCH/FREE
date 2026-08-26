## ADDED Requirements

### Requirement: Current nodes are pinned to an acknowledged Schema Revision
When an Extraction Schema is durable, Studio SHALL track its editable ordered `SchemaNode[]` together with the acknowledged Current Schema Revision id and revision number. Editing MAY create a newer draft, but Extraction and conversational editing SHALL use only an acknowledged durable revision.

#### Scenario: Reopened schema is acknowledged
- **WHEN** Studio reopens a Project Context with an Extraction Schema
- **THEN** its ordered nodes, Schema Revision id, and revision number become the acknowledged Current Schema Revision

#### Scenario: Queued edit follows an in-flight save
- **WHEN** a researcher edits again while a schema save is in flight
- **THEN** Studio retains only the latest draft for the next append
- **AND** a save success acknowledges only the tree submitted by that request
