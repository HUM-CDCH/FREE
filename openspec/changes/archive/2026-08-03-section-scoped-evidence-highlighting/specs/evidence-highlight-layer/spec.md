## ADDED Requirements

### Requirement: Highlight candidates stay within their evidence source scope
For Evidence that contains `source_scope`, `EvidenceHighlightLayer` SHALL resolve prose anchors only from the scope's canonical Markdown offset range and SHALL resolve table cells only from its inclusive page range. A candidate outside that range SHALL not be highlighted for that Evidence leaf.

#### Scenario: Duplicate snippet in different catalog sections
- **WHEN** two Catalog records have identical snippets in separate source scopes
- **THEN** each record's highlight resolves only to the occurrence inside its own scope
- **AND** it does not select the first document-wide occurrence

#### Scenario: Two sections share a page
- **WHEN** two source scopes occupy the same PDF page
- **THEN** anchor matching uses Markdown offsets to distinguish their snippets
- **AND** page number alone does not authorize a cross-section match

### Requirement: Unverifiable scoped evidence is not globally re-matched
When no anchor or table cell can be verified within an Evidence leaf's `source_scope`, `EvidenceHighlightLayer` SHALL omit the highlight and SHALL NOT widen matching to another source scope or the full PDF text layer.

#### Scenario: Altered snippet has no in-scope anchor
- **WHEN** an Evidence snippet is not present in its own source scope
- **THEN** the corresponding result value remains visible
- **AND** no highlight is drawn for a matching phrase elsewhere in the document

### Requirement: Scope groups resolve concurrently with deterministic drawing
`EvidenceHighlightLayer` SHALL resolve distinct evidence source scopes with bounded concurrency, reuse page viewport work within a render pass, and draw resolved entries in original result traversal order.

#### Scenario: Multiple catalog records resolve at different speeds
- **WHEN** independent scope groups complete resolution in a different order from their result records
- **THEN** the final cached and drawn highlight order follows the result traversal order
- **AND** focus selects the entry matching its result path
