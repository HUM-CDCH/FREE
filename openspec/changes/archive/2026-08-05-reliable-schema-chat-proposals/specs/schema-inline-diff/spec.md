## MODIFIED Requirements

### Requirement: Schema tree renders diff state inline
When a pending chat edit exists, the schema tree SHALL project the proposal with each affected node rendered once and annotated directly on its tree row. Added, removed, and modified nodes SHALL be keyed by their real or provisional node id; modified nodes SHALL use complete before and after data and SHALL NOT create ghost nodes.

#### Scenario: Added node appears green
- **WHEN** a pending proposal adds a node
- **THEN** the new node appears once in the proposed tree with a green annotation
- **AND** an added group and each added child remain distinct id-addressed changes

#### Scenario: Removed node appears red with strikethrough
- **WHEN** a pending proposal removes a node
- **THEN** its complete before state remains visible once at its original position with a red annotation and strikethrough
- **AND** the node is absent only if the researcher applies the proposal

#### Scenario: Modified node appears amber
- **WHEN** a pending proposal renames, retypes, or both renames and retypes one node
- **THEN** that node appears once with its proposed values and an amber annotation
- **AND** no degraded ghost copy is created

#### Scenario: Unaffected nodes render normally
- **WHEN** a pending proposal exists
- **THEN** nodes without a change record render with no diff annotation
