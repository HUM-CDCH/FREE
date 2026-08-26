# schema-node-persistence Specification

## Purpose
The editable Extraction Schema lives as ordered `SchemaNode[]` with stable ids, pinned to an acknowledged Current Schema Revision.

## Requirements

### Requirement: SchemaNode is the canonical schema representation

The system SHALL store the active schema as `SchemaNode[]` in `App.tsx` state. Plain template JSON (`Record<string, unknown>`) SHALL only be derived at API call boundaries.

#### Scenario: Schema generation result is stored as nodes

- **WHEN** `/api/generate_schema` returns a template JSON object
- **THEN** `App.tsx` converts it to `SchemaNode[]` via `templateToNodes` and stores the nodes in `TemplateState`
- **AND** `SchemaPanel` receives nodes directly without an additional conversion step

#### Scenario: Extraction uses template JSON derived from current nodes

- **WHEN** the researcher triggers extraction
- **THEN** `App.tsx` calls `nodesToTemplate` on the current `SchemaNode[]` and passes the result to the extraction API
- **AND** the `SchemaNode[]` in state is not modified

### Requirement: Node ids are stable across edits

A `SchemaNode`'s `id` SHALL remain unchanged when the node is not the target of an edit operation. Only newly created nodes receive a freshly generated id.

#### Scenario: Unrelated nodes keep their ids after a chat edit

- **WHEN** a chat edit adds one field to the schema
- **THEN** all pre-existing nodes that were not added, removed, or patched retain their original ids
- **AND** only the newly added node has a new id

#### Scenario: Patched node keeps its id

- **WHEN** a chat edit renames or retypes an existing field
- **THEN** the node's `id` is unchanged
- **AND** only `name` and/or `type` are updated

### Requirement: Current nodes are pinned to an acknowledged Schema Revision
When an Extraction Schema is durable, Studio SHALL track its editable ordered `SchemaNode[]` together with the acknowledged Current Schema Revision id and revision number. Editing MAY create a newer draft, but Extraction and conversational editing SHALL use only an acknowledged durable revision.

#### Scenario: Reopened schema is acknowledged
- **WHEN** Studio reopens a Project Context with an Extraction Schema
- **THEN** its ordered nodes, Schema Revision id, and revision number become the acknowledged Current Schema Revision

#### Scenario: Queued edit follows an in-flight save
- **WHEN** a researcher edits again while a schema save is in flight
- **THEN** Studio retains only the latest draft for the next append
- **AND** a save success acknowledges only the tree submitted by that request
