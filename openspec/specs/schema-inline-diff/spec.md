# schema-inline-diff Specification

## Purpose
TBD - created by archiving change inline-diff-preview. Update Purpose after archive.
## Requirements
### Requirement: Schema tree renders diff state inline
When a pending chat edit exists, the schema tree SHALL project the immutable proposal with each affected node rendered once and annotated directly on its tree row. Added, removed, and modified nodes SHALL be keyed by their real or provisional node id; modified nodes SHALL use complete before and after data and SHALL NOT create ghost nodes. Changing acceptance SHALL update replay outcomes without changing which rows or proposed values are rendered.

#### Scenario: Added node appears green
- **WHEN** a pending proposal adds a node
- **THEN** the new node appears once in the proposed tree with a green annotation
- **AND** an added group and each added child remain distinct id-addressed changes

#### Scenario: Removed node appears red with strikethrough
- **WHEN** a pending proposal removes a node
- **THEN** its complete before state remains visible once at its original position with a red annotation and strikethrough
- **AND** the node is absent only if the researcher applies the proposal while that change is accepted

#### Scenario: Modified node appears amber
- **WHEN** a pending proposal renames, retypes, or both renames and retypes one node
- **THEN** that node appears once with its proposed values and an amber annotation
- **AND** no degraded ghost copy is created

#### Scenario: Unaffected nodes render normally
- **WHEN** a pending proposal exists
- **THEN** nodes without a change record render with no diff annotation

#### Scenario: Rejected row remains a proposal row
- **WHEN** the researcher rejects a changed node
- **THEN** that row retains its diff annotation and proposed values
- **AND** only its acceptance and replay outcome presentation changes

### Requirement: Diff-annotated nodes suppress editing controls

While a pending change exists, nodes that carry a diff status (added, removed, or modified) SHALL NOT display drag handles, edit buttons, or remove buttons. Each changed row SHALL instead display its proposal acceptance control.

#### Scenario: Edit controls hidden on diff-annotated node

- **WHEN** a node is marked `added`, `removed`, or `modified` in the current pending diff
- **THEN** its drag handle, edit icon button, and remove button are not rendered
- **AND** the row is not interactive for drag-and-drop
- **AND** its proposal acceptance control remains available

#### Scenario: Edit controls visible on unaffected nodes during diff preview

- **WHEN** a pending change exists but a given node has no diff status
- **THEN** that node's edit and remove controls remain visible

