# schema-chat-edit Specification

## Purpose

Schema editing through chat with one reviewable proposal awaiting a researcher decision.
## Requirements
### Requirement: Schema panel includes an inline chat area for describing changes
The SchemaPanel SHALL include a collapsible chat area below the field list. The chat area SHALL show a scrollable message history and a text input with a send button. The researcher SHALL be able to type a free-form request (e.g., "rename sagsnummer to case_id") and send it.

#### Scenario: Chat area is visible after schema is generated
- **WHEN** the schema panel is in the `ready` state
- **THEN** the chat area is visible at the bottom of the panel, below the field list

#### Scenario: Researcher types and sends a message
- **WHEN** the researcher types text in the chat input and presses Enter or clicks the send button
- **THEN** the message appears in the chat history as a user turn, the input clears, and a loading indicator appears

### Requirement: Only one schema change awaits review at a time
The system SHALL NOT accept a new schema-change request while a prior proposal awaits a researcher decision. The pending proposal SHALL preserve complete before and after node data, SHALL expose one acceptance decision per changed node, SHALL apply the accepted materialisable subset atomically, and SHALL leave the schema unchanged when discarded.

#### Scenario: A proposed change is awaiting a decision
- **WHEN** a schema-change proposal has not been applied or discarded
- **THEN** the system does not send another schema-change request
- **AND** every changed node starts accepted
- **AND** Apply commits the accepted materialisable subset in one update
- **AND** Discard leaves the pre-request schema unchanged

### Requirement: Schema chat response is total over existing field paths
The system SHALL enumerate every existing field from `SchemaNode` data and require one response entry for every enumerated opaque field key. Each entry SHALL contain exactly a proposed name, proposed type, and removed flag. Additions SHALL be returned separately with a structural path in the post-edit namespace.

#### Scenario: Model covers every existing field
- **WHEN** a schema contains nested fields and the researcher requests a schema-wide edit
- **THEN** one structured model call requests an entry for every enumerated field key
- **AND** unchanged fields are echoed with their current name and type
- **AND** dotted field keys are compared as opaque keys rather than parsed as paths

#### Scenario: Duplicate field key exists before generation
- **WHEN** node enumeration produces the same opaque field key more than once
- **THEN** the request is `refused` before the model is called
- **AND** the existing schema remains unchanged

#### Scenario: Initial response omits or invalidates expected keys
- **WHEN** expected field entries are missing or invalid after the first response
- **THEN** the system makes one scoped retry for only those expected keys
- **AND** any entries still missing or invalid after the retry are excluded from the proposal and reported

### Requirement: Schema chat reports factual outcomes
Every schema-edit request SHALL result in `refused`, `failed`, or `proposed`. A proposed outcome SHALL carry fixed `missing`, `invalid`, and `unknown-key` diagnostics where applicable. The system SHALL report what happened without claiming whether the schema already matches the instruction.

#### Scenario: Valid response makes no changes
- **WHEN** every existing field is returned unchanged and there are no additions or removals
- **THEN** the result is a `proposed` outcome with zero changes
- **AND** the chat does not conflate it with malformed, invalid, or unmatched output

#### Scenario: Model output cannot form a proposal
- **WHEN** the model transport fails, the response is truncated, the JSON cannot be parsed, or no usable proposal entries remain
- **THEN** the result is `failed`
- **AND** the existing schema remains unchanged

#### Scenario: Response includes unknown keys
- **WHEN** the response contains field keys outside the enumerated key set or addition paths that do not resolve in the proposed tree
- **THEN** those entries do not change the schema
- **AND** they are reported as `unknown-key`

### Requirement: Schema edit generation uses bounded JSON output
The schema-edit model call SHALL request JSON output, disable model reasoning for that call, and reject a length-truncated response before parsing or repair. It SHALL NOT use provider-managed object-schema retries.

#### Scenario: Provider finishes because of length
- **WHEN** the schema-edit generation finish reason is `length`
- **THEN** the request is `failed` before JSON repair or completeness checks

### Requirement: Proposed changes preserve node identity and structure
The system SHALL derive one id-addressed change record per affected node with complete `before` and `after` data. Existing nodes SHALL retain their ids. Addition parents SHALL resolve once against the fully proposed tree using post-edit paths, and every addition SHALL receive a provisional id before review.

#### Scenario: Addition targets a renamed parent
- **WHEN** an existing `group` is proposed as `renamed` and an addition targets `renamed/child`
- **THEN** the addition resolves beneath the renamed parent and receives a provisional id
- **AND** an addition targeting `group/child` is reported as `unknown-key`

#### Scenario: One node is renamed and retyped
- **WHEN** the response changes both name and type for one existing node
- **THEN** one change record contains the complete node before and after both changes
- **AND** the preview does not split the node into independent decisions

### Requirement: Schema chat changes names and types only
Schema chat SHALL NOT change field descriptions or allowed values. Retypes SHALL be sanitised before change records are produced so that closed sets stay strings and container-crossing retypes remove metadata they orphan.

#### Scenario: Closed-set field is renamed and retyped
- **WHEN** a field with allowed values receives a new name and a non-string type
- **THEN** the proposed rename is retained
- **AND** the type remains `string`
- **AND** the rejected retype is reported as a conflict on that node

#### Scenario: Retype crosses the container boundary
- **WHEN** a leaf becomes an object or array, or a container becomes a leaf
- **THEN** `children` is materialised or removed to match the proposed type
- **AND** orphaned description or allowed-value metadata is removed
- **AND** an applied change carries a researcher-facing note with no failure reason

#### Scenario: Schema contains metadata outside chat reach
- **WHEN** a proposed outcome is reviewed for a schema containing descriptions or allowed-value lists
- **THEN** the review header conditionally reports their counts as unchanged by chat
- **AND** the count is derived from the pre-edit schema rather than the instruction text

### Requirement: Repeating scalar lists round-trip through SchemaNode
A repeating string list SHALL be represented as `type: 'array'` without `children` and serialized as `["string"]`. An array with `children` SHALL remain a repeating group, and the existing allowed-values discriminator SHALL remain unchanged.

#### Scenario: Repeating string list is loaded and saved
- **WHEN** `["string"]` is converted to nodes and back to an extraction schema
- **THEN** it remains `["string"]`
- **AND** it is not converted to a scalar string or a closed set

### Requirement: Review header and rows expose proposal outcomes
The review surface SHALL show counts for accepted, rejected, applied, unresolved, and conflicting changes. It SHALL show rowless `missing`, `invalid`, and `unknown-key` diagnostics in the header, attach unresolved or conflict information to a row when a change has a node id, and expose exactly one acceptance decision on every changed-node row.

#### Scenario: Mixed proposal is reviewed
- **WHEN** a proposal contains applied changes plus rejected changes, unresolved additions, conflicts, or coverage diagnostics
- **THEN** the header shows the corresponding counts before Apply
- **AND** node-specific conflicts appear on their annotated rows
- **AND** a rename and retype of the same node share one decision
- **AND** an added group and each added child have separate decisions

### Requirement: Accepted schema changes replay from the original schema
The system SHALL derive the materialised candidate from the original pre-request schema, immutable change records, and the currently accepted node ids. Every change SHALL start accepted. Replay SHALL recompute each change outcome after every decision, SHALL address existing nodes and resolved addition parents by id, and SHALL NOT mutate the proposal records or projected proposal tree.

#### Scenario: One change is rejected
- **WHEN** the researcher rejects one change in a multi-change proposal
- **THEN** replay starts from the original schema and materialises the other accepted, resolvable changes
- **AND** the rejected change is absent from the materialised candidate

#### Scenario: Parent rename is rejected while its child change is accepted
- **WHEN** a parent rename is rejected and an accepted child change targets that parent's stable id
- **THEN** replay applies the child change beneath the original parent name
- **AND** no descendant data or description is degraded

#### Scenario: Accepted addition depends on a rejected added parent
- **WHEN** an accepted added child references an added parent that is rejected
- **THEN** replay reports the child as unresolved
- **AND** Apply does not materialise that child

### Requirement: Schema chat uses the acknowledged Current Schema Revision
Before conversational schema editing, Studio SHALL flush a pending researcher edit and SHALL select the resulting acknowledged Current Schema Revision id as the conversational edit base. A failed or conflicted save SHALL block the conversational request.

#### Scenario: Researcher edit is queued before chat
- **WHEN** the researcher requests a conversational edit while a direct edit is dirty, saving, or queued
- **THEN** Studio waits until the latest draft is durably acknowledged
- **AND** submits that Schema Revision id as the conversational edit base

#### Scenario: Direct edit conflicts before chat
- **WHEN** the required direct-edit flush returns a revision conflict
- **THEN** Studio does not send the conversational edit request
- **AND** the pending chat instruction remains available after the researcher resolves the conflict
