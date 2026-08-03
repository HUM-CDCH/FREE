## ADDED Requirements

### Requirement: Highlight resolution consumes indexed segment geometry
Before resolving highlights, `EvidenceHighlightLayer` SHALL create one
geometry index keyed by `segment_id`. A highlight SHALL use only anchors and
tables in the entry matching its Evidence source scope's ID.

#### Scenario: Same-page table values repeat across segments
- **WHEN** two segment-owned tables on one page contain the same result value
- **THEN** each highlight considers only tables from its own segment index
- **AND** the other segment's same-page cell cannot be selected

### Requirement: Parallel geometry resolution has deterministic paint order
`EvidenceHighlightLayer` SHALL resolve independent segment groups with bounded
concurrency. It SHALL cache and paint resolved entries in result traversal
order regardless of group completion order.

#### Scenario: Later segment resolves first
- **WHEN** a later segment's geometry resolution completes before an earlier
  segment's resolution
- **THEN** the final paint order still follows result traversal order
- **AND** focus resolves by the matching result path
