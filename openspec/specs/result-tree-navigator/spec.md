# result-tree-navigator Specification

## Purpose
Defines hierarchical Extraction Result navigation with breadcrumbs and browser-like history.
## Requirements
### Requirement: Root breadcrumb bar

When the Review sub-view is active and the researcher is at the root level, the Results tab SHALL display a breadcrumb bar showing only the label "Results". No back or forward button SHALL be shown at the root level.

#### Scenario: Root breadcrumb at initial state

- **WHEN** the Review view is active and no navigation has occurred
- **THEN** a breadcrumb bar is visible above the result list showing "Results"
- **AND** no back or forward button is present

### Requirement: Navigate into a node

When the researcher clicks the header row of an ObjectSection or ArraySection, the view SHALL navigate into that node: only that node's direct children are rendered as the new top-level list, and all sibling nodes are hidden. The breadcrumb appends the node's key.

#### Scenario: Click top-level ObjectSection header

- **WHEN** the researcher clicks the header of a top-level ObjectSection (e.g. `site_info`)
- **THEN** only `site_info`'s children are shown in the content area
- **AND** the breadcrumb updates to `Results › site_info`
- **AND** the back button becomes visible

#### Scenario: Click nested ObjectSection header

- **WHEN** the researcher is already inside `site_info` and clicks the header of a nested ObjectSection (e.g. `excavation`)
- **THEN** only `excavation`'s children are shown
- **AND** the breadcrumb updates to `Results › site_info › excavation`

#### Scenario: Click ArraySection header

- **WHEN** the researcher clicks the header of an ArraySection
- **THEN** navigation into that array works identically to ObjectSection navigation

### Requirement: Breadcrumb ancestor navigation

Each segment in the breadcrumb except the last (current node) SHALL be a clickable control that navigates directly to that ancestor. Clicking an ancestor records the current path in the back stack and clears the forward stack.

#### Scenario: Click ancestor breadcrumb segment

- **WHEN** the breadcrumb shows `Results › site_info › excavation` and the researcher clicks `site_info`
- **THEN** the view shows `site_info`'s children as the top-level list
- **AND** the breadcrumb updates to `Results › site_info`
- **AND** the previous path (`excavation`) is available via the forward button

#### Scenario: Click "Results" root segment

- **WHEN** the breadcrumb shows any path deeper than root and the researcher clicks "Results"
- **THEN** the full root view is restored (identical to the initial state)
- **AND** back/forward buttons are hidden

### Requirement: Back and forward navigation

The Results tab SHALL maintain a navigation history. A back button SHALL step to the previous path; a forward button SHALL step to the next path if available. Both buttons are hidden at root.

#### Scenario: Back button returns to previous node

- **WHEN** the researcher has navigated into a node and presses the back button
- **THEN** the view returns to the previous path
- **AND** the forward button becomes visible

#### Scenario: Forward button re-enters the next node

- **WHEN** the researcher has gone back and presses the forward button
- **THEN** the view advances to the path that was undone

#### Scenario: New navigation clears forward stack

- **WHEN** the researcher navigates into a node after having gone back
- **THEN** the forward stack is cleared and the forward button is hidden

### Requirement: Navigation resets on new extraction

When a new extraction result arrives (or extraction restarts), the navigator SHALL reset to the root view, clearing the back stack, forward stack, and current path.

#### Scenario: Extraction result replaced

- **WHEN** a new extraction completes or the extraction state changes from `ready` back to `running`
- **THEN** `navPath`, `backStack`, and `forwardStack` are all reset to empty
- **AND** the root breadcrumb is shown with no back/forward buttons

### Requirement: Edited values visible after navigation

Inline edits made while inside a navigated node SHALL remain visible when the researcher navigates away and returns, because the navigator always reads from the live `displayResult` object.

#### Scenario: Edit survives navigation round-trip

- **WHEN** the researcher edits a primitive field while inside a navigated node, then navigates back to root and re-enters the same node
- **THEN** the edited value is still displayed

