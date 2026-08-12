## ADDED Requirements

### Requirement: Coincident highlight geometry is painted once
`EvidenceHighlightLayer` SHALL coalesce resolved rectangles that have the same
page, rendered geometry, and highlight color before both its initial paint and
its focus redraw. It SHALL retain every logical result-path entry for tracing
and focus selection.

#### Scenario: Duplicate same-color highlights share a rectangle
- **WHEN** two resolved highlights have the same page, color, and rendered
  rectangle
- **THEN** the canvas fills that rectangle once during a normal render pass
- **AND** the resulting opacity equals one highlight fill rather than
  compounded overlapping fills

#### Scenario: Focus redraw does not compound opacity
- **WHEN** a focused result causes the layer to redraw cached entries
- **THEN** coincident same-color rectangles are filled at most once in that
  redraw pass
- **AND** the focused result remains scrollable by its own result path

### Requirement: Segment geometry resolves concurrently with deterministic paint order
`EvidenceHighlightLayer` SHALL resolve independent source-scope geometry inputs
with bounded concurrency. It SHALL collect resolved entries and perform canvas
painting in original result traversal order, irrespective of individual
segment completion order.

#### Scenario: Later segment resolves first
- **WHEN** a later source scope completes geometry resolution before an earlier
  source scope
- **THEN** the layer retains the later result without immediately painting it
- **AND** the final paint order follows result traversal order


### Requirement: Cross-page prose highlights render one fragment per page
When a scoped prose match covers anchors on multiple PDF pages,
`EvidenceHighlightLayer` SHALL draw each page fragment under the same result
path and SHALL scroll focus to the first fragment.

#### Scenario: One result spans two pages
- **WHEN** a scoped prose match covers anchors on two PDF pages
- **THEN** the layer draws a fragment on each page
- **AND** selecting the result scrolls to its first-page fragment
