## MODIFIED Requirements

### Requirement: Result-path focus dims non-active highlights

`EvidenceHighlightLayer` SHALL accept a `focusPath: string[] | null` prop. When `focusPath` is non-null, highlights with a different result path SHALL be drawn once at `ctx.globalAlpha = 0.15`, and every rectangle belonging to the selected path SHALL be drawn once at `ctx.globalAlpha = 0.75`. When focus is clear, every highlight SHALL be drawn once at `ctx.globalAlpha = 0.4`.

#### Scenario: Duplicate values remain independently selectable

- **WHEN** two extracted leaves have the same display value but different result paths
- **AND** one of those paths is selected
- **THEN** only highlights belonging to the selected path use alpha `0.75`
- **AND** highlights belonging to the other path use alpha `0.15`

#### Scenario: Clear focus restores normal opacity

- **WHEN** `focusPath` changes to `null`
- **THEN** all cached highlight rectangles are painted once at alpha `0.4`

#### Scenario: Active highlight is not double-painted

- **WHEN** a selected highlight is repainted
- **THEN** each cached rectangle is filled exactly once
- **AND** no second intensifying fill obscures the PDF text

### Requirement: Position cache avoids re-searching on focus change

After the main render effect finds each highlight's page and rectangle coordinates, those positions SHALL be cached. A separate focus effect SHALL read from the cache to scroll and repaint without re-running PDF text search.

#### Scenario: Focus changes after cache is populated

- **WHEN** `focusPath` changes after the cache is populated
- **THEN** the canvas is repainted from the cached entries without another PDF text search
- **AND** the viewer scrolls to center the first rectangle whose result path matches `focusPath`

#### Scenario: Focus changes while main search is still running

- **WHEN** `focusPath` changes while entries are still being located
- **THEN** already cached entries are repainted using the new focus path
- **AND** subsequent progressive paints use the current focus path

### Requirement: Highlight source uses evidence metadata with direct-search fallback

The `EvidenceHighlightLayer` SHALL build highlights from extraction-result leaves. When a leaf has `_evidence` metadata, non-empty snippets SHALL anchor the search and a numeric page SHALL be used as the first page hint. When usable evidence metadata is absent, the component SHALL search for the scalar's displayed value directly. Evidence metadata itself SHALL NOT be painted as extracted content.

#### Scenario: Evidence-guided scalar is located

- **WHEN** a string, finite number, or boolean leaf has a non-empty evidence snippet
- **THEN** the snippet and optional page hint guide the PDF text lookup
- **AND** the highlight retains the leaf's result path and top-level field color

#### Scenario: Leaf without usable evidence falls back to direct search

- **WHEN** a searchable scalar leaf has no non-empty evidence snippet
- **THEN** the full displayed value and its existing shortened prefixes are searched directly
- **AND** failure to locate that value does not stop other highlights

#### Scenario: Evidence metadata is excluded from extracted leaves

- **WHEN** a result object contains `_evidence`
- **THEN** `_evidence` keys and their metadata fields are not emitted as standalone highlights

#### Scenario: Null and non-finite leaves are ignored

- **WHEN** a result leaf is null, undefined, or a non-finite number
- **THEN** no highlight search is created for that leaf
