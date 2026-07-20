# result-tree-navigator Specification

## Purpose

Defines direct-child result-tree navigation, breadcrumb history, and edit persistence while researchers inspect nested extraction results.

## Requirements

### Requirement: Root breadcrumb bar

When the Review sub-view is active and the researcher is at the root level, the Results tab SHALL display a breadcrumb bar showing the label "Results". History controls SHALL be hidden at a fresh root, but Forward SHALL remain available after Back returns to root with forward history.

#### Scenario: Root breadcrumb at initial state

- **WHEN** the Review view is active and no navigation has occurred
- **THEN** a breadcrumb bar is visible above the result list showing "Results"
- **AND** no back or forward button is present before navigation history exists

### Requirement: Navigate into a node

When the researcher clicks the header row of an object or array, the view SHALL navigate into that node: only that node's direct children are rendered as the new top-level list, and all sibling nodes are hidden. The breadcrumb SHALL append the node's key or item label.

#### Scenario: Click nested object header

- **WHEN** the researcher clicks an object header
- **THEN** only that object's direct children are shown
- **AND** the breadcrumb appends the object's path segment
- **AND** Back becomes available

#### Scenario: Click array header

- **WHEN** the researcher clicks an array header
- **THEN** the array's direct items are shown using one-based item labels

### Requirement: Breadcrumb ancestor navigation

Each breadcrumb segment except the current node SHALL be clickable. Clicking an ancestor SHALL navigate directly to that path and place the abandoned deeper path in forward history.

#### Scenario: Click ancestor breadcrumb segment

- **WHEN** the breadcrumb shows `Results › site_info › excavation` and the researcher clicks `site_info`
- **THEN** `site_info` becomes the current node
- **AND** the abandoned `excavation` path is available through Forward

#### Scenario: Click Results root segment

- **WHEN** the researcher clicks Results from a nested path
- **THEN** the root view is restored
- **AND** Forward remains available for the abandoned path

### Requirement: Back and forward navigation

The Results tab SHALL maintain back and forward path stacks. A new drill-in navigation SHALL clear the forward stack. Controls SHALL be hidden only when neither direction has history at root.

#### Scenario: Back and Forward traverse path history

- **WHEN** the researcher navigates into a node, goes Back, and then chooses Forward
- **THEN** Back returns to the previous path
- **AND** Forward re-enters the path that was undone

#### Scenario: New navigation clears forward history

- **WHEN** the researcher drills into a node after going Back
- **THEN** the forward stack is cleared

### Requirement: Navigation resets on new extraction

When extraction restarts or a replacement result arrives, the navigator SHALL reset its current path and both history stacks to the root.

#### Scenario: Extraction result is replaced

- **WHEN** a new extraction begins or completes
- **THEN** current path, back stack, and forward stack are cleared
- **AND** the fresh root breadcrumb is shown

### Requirement: Edited values visible after navigation

Inline edits made in Review SHALL remain visible when the researcher navigates away and returns because navigation resolves paths against the live displayed result.

#### Scenario: Edit survives navigation round-trip

- **WHEN** the researcher edits a primitive value, navigates away, and returns to its node
- **THEN** the edited value remains visible
