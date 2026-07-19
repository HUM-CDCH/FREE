## ADDED Requirements

### Requirement: Chat instruction produces an op list, not a replacement schema

When the researcher types an instruction in the schema chat, the system SHALL call `/api/edit_schema` and receive a structured list of field operations. The system SHALL NOT call `/api/generate_schema` for chat-initiated edits.

#### Scenario: Researcher adds a field via chat

- **WHEN** the researcher types "add a field for excavation date"
- **THEN** the system calls `POST /api/edit_schema` with the current template JSON and the instruction
- **AND** the model returns an op list such as `[{"op":"add","name":"excavation_date","type":"date","parentName":null}]`
- **AND** only that field is added to the schema; all other fields are unchanged

#### Scenario: Model returns empty op list

- **WHEN** the model determines no change is needed
- **THEN** the model returns `[]`
- **AND** the system shows "No changes needed" in the chat without modifying the schema

#### Scenario: Model returns malformed JSON

- **WHEN** the model response cannot be parsed as a JSON array
- **THEN** the system shows an error message in the chat
- **AND** the schema is not modified

### Requirement: Op list is applied to SchemaNode[] directly

The frontend SHALL apply each op in the returned list to the current `SchemaNode[]` using pure functions. The ops SHALL be applied in order. Nodes not referenced by any op SHALL remain unchanged.

#### Scenario: add op appends a root-level node

- **WHEN** an `add` op has `parentName: null`
- **THEN** a new `SchemaNode` is appended to the root nodes array
- **AND** no existing node is modified

#### Scenario: add op nests under a parent

- **WHEN** an `add` op has a `parentName` matching an existing object node's name
- **THEN** the new node is appended to that node's `children`
- **AND** if no matching parent is found, the node is appended at root instead

#### Scenario: remove op deletes a node by name

- **WHEN** a `remove` op names an existing field
- **THEN** that node is removed from the tree
- **AND** if no node with that name exists, the op is a no-op

#### Scenario: patch op updates name and type in place

- **WHEN** a `patch` op names an existing field
- **THEN** that node's `name` and `type` are updated
- **AND** the node's `id` and `children` are preserved

### Requirement: Pending-diff card shows changes before commit

After ops are applied the system SHALL compute a diff between the old and new `SchemaNode[]` and present it to the researcher as a pending-diff card with Apply and Discard actions.

#### Scenario: Researcher reviews and applies changes

- **WHEN** the op list produces one or more changes
- **THEN** the pending-diff card is shown listing each changed field with a sign (`+`, `−`, `~`)
- **AND** clicking Apply updates the schema and closes the card
- **AND** clicking Discard closes the card without modifying the schema
