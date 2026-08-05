## ADDED Requirements

### Requirement: Researcher can reorder schema fields by dragging
The schema field list SHALL provide a drag handle (⠿) on each field row. The researcher SHALL be able to press and hold the handle to initiate a drag. While dragging, a floating overlay chip SHALL follow the cursor showing the field name. A blue drop-line indicator SHALL appear between items as the researcher moves over insertion slots. On release, the field SHALL be inserted at the indicated slot.

#### Scenario: Reorder within root level
- **WHEN** the researcher drags a root-level field over a slot between two other root-level fields and releases
- **THEN** the field is moved to that position in the schema and the schema panel reflects the new order immediately

#### Scenario: Reorder within a nested group
- **WHEN** the researcher drags a child field within a group over a slot between two other children of the same group and releases
- **THEN** the child is moved to that position within the group without affecting sibling fields outside the group

### Requirement: Researcher can re-nest a field into a group by dragging
The system SHALL allow dragging a root-level leaf field (non-group) onto a group row. While hovering over a group row, the system SHALL display an "into [group name]" badge on that row. On release over a group, the field SHALL be appended as the last child of that group.

#### Scenario: Nest a leaf field into a group
- **WHEN** the researcher drags a root-level non-group field and releases it while hovering over a group row
- **THEN** the field is moved inside the group as its last child

#### Scenario: Groups cannot be nested into other groups
- **WHEN** the researcher drags a group (field with children) and releases it while hovering over another group row
- **THEN** the "into [group]" badge does NOT appear and the drop is ignored; the group remains at the root level

### Requirement: Researcher can lift a child field out of a group by dragging
The system SHALL allow dragging a child field out of its parent group to the root level. Drop slots SHALL be shown between root-level items while a child field is being dragged.

#### Scenario: Lift a child field to root
- **WHEN** the researcher drags a child field and releases it on a drop slot at the root level
- **THEN** the field is removed from its parent group and inserted at the indicated root-level position

### Requirement: Schema field list auto-scrolls during drag
When the researcher drags near the top or bottom edge of the schema field list scroll container, the list SHALL scroll automatically in that direction to expose items outside the visible area.

#### Scenario: Auto-scroll down while dragging
- **WHEN** the drag cursor is within 60px of the bottom edge of the scroll container
- **THEN** the container scrolls downward at a constant speed (~7px per animation frame) until the cursor moves away from the edge or drag ends

#### Scenario: Auto-scroll up while dragging
- **WHEN** the drag cursor is within 60px of the top edge of the scroll container
- **THEN** the container scrolls upward until the cursor moves away from the edge or drag ends

### Requirement: Empty group shows a drop placeholder
A group with no children SHALL display a "drag a field in here" placeholder inside the group's nested area while a drag is in progress.

#### Scenario: Empty group placeholder visible during drag
- **WHEN** a drag is in progress and a group has no children
- **THEN** a dashed placeholder reading "drag a field in here" is visible inside the group
