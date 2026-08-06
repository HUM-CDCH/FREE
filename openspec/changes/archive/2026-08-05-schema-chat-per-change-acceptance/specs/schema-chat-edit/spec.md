## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Only one schema change awaits review at a time
The system SHALL NOT accept a new schema-change request while a prior proposal awaits a researcher decision. The pending proposal SHALL preserve complete before and after node data, SHALL expose one acceptance decision per changed node, SHALL apply the accepted materialisable subset atomically, and SHALL leave the schema unchanged when discarded.

#### Scenario: A proposed change is awaiting a decision
- **WHEN** a schema-change proposal has not been applied or discarded
- **THEN** the system does not send another schema-change request
- **AND** every changed node starts accepted
- **AND** Apply commits the accepted materialisable subset in one update
- **AND** Discard leaves the pre-request schema unchanged

### Requirement: Review header and rows expose proposal outcomes
The review surface SHALL show counts for accepted, rejected, applied, unresolved, and conflicting changes. It SHALL show rowless `missing`, `invalid`, and `unknown-key` diagnostics in the header, attach unresolved or conflict information to a row when a change has a node id, and expose exactly one acceptance decision on every changed-node row.

#### Scenario: Mixed proposal is reviewed
- **WHEN** a proposal contains applied changes plus rejected changes, unresolved additions, conflicts, or coverage diagnostics
- **THEN** the header shows the corresponding counts before Apply
- **AND** node-specific conflicts appear on their annotated rows
- **AND** a rename and retype of the same node share one decision
- **AND** an added group and each added child have separate decisions
