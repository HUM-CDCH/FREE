# schema-inline-diff Specification

## Purpose
TBD - created by archiving change inline-diff-preview. Update Purpose after archive.
## Requirements
### Requirement: Schema tree renders diff state inline

When a pending chat edit exists, the schema tree SHALL render a merged "before + after" view. Each affected node SHALL be annotated with a colour overlay directly in the tree row. The tree SHALL show added nodes, removed nodes (as ghost entries at their original position), and modified nodes simultaneously.

#### Scenario: Added node appears green

- **WHEN** a pending change includes an `add` op
- **THEN** the new node appears in the schema tree with a green background
- **AND** the node name and type are rendered in green text

#### Scenario: Removed node appears red with strikethrough

- **WHEN** a pending change includes a `remove` op
- **THEN** the removed node remains visible in the tree at its original position
- **AND** its row has a red background and the name is rendered with strikethrough
- **AND** the node is not present in the schema if the researcher clicks Discard

#### Scenario: Modified node appears amber

- **WHEN** a pending change includes a `patch` op
- **THEN** the affected node appears in the tree with an amber background
- **AND** the node shows its updated name and/or type (the post-op values)

#### Scenario: Unaffected nodes render normally

- **WHEN** a pending change exists
- **THEN** nodes not referenced by any op render with no background change
- **AND** their edit and remove controls remain visible and functional

### Requirement: Diff-annotated nodes suppress editing controls

While a pending change exists, nodes that carry a diff status (added, removed, or modified) SHALL NOT display drag handles, edit buttons, or remove buttons. This prevents the researcher from editing nodes that are part of an unconfirmed preview.

#### Scenario: Edit controls hidden on diff-annotated node

- **WHEN** a node is marked `added`, `removed`, or `modified` in the current pending diff
- **THEN** its drag handle, edit icon button, and remove button are not rendered
- **AND** the row is not interactive for drag-and-drop

#### Scenario: Edit controls visible on unaffected nodes during diff preview

- **WHEN** a pending change exists but a given node has no diff status
- **THEN** that node's edit and remove controls remain visible

