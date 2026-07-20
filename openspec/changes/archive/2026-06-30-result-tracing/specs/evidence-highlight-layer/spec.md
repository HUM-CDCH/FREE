## MODIFIED Requirements

### Requirement: Schema-reactive highlight colors
The `EvidenceHighlightLayer` component SHALL assign highlight colors based on **top-level key order in the extraction schema template**, cycling through a fixed 4-color palette, so that each top-level schema field receives a distinct color that is consistent across all extracted records. Color assignment SHALL use a `fieldColorMap` built from `schemaTemplate` keys and SHALL remain stable when the extraction result changes without a schema change.

#### Scenario: Each schema field gets a unique palette slot
- **WHEN** the extraction schema has N top-level keys
- **THEN** the k-th key (0-indexed) is assigned `PALETTE[k % 4]`
- **AND** no two adjacent schema keys share the same color

#### Scenario: Schema prop changes after result is displayed
- **WHEN** the `schemaTemplate` prop value changes without a new extraction
- **THEN** highlight colors are NOT redrawn (schemaTemplate is read via ref, not effect dep)

#### Scenario: Result key not found in schema
- **WHEN** the model returns result keys that differ from schema keys
- **THEN** colors fall back to palette index by iteration order within the record

## ADDED Requirements

### Requirement: Colorblind-accessible highlight palette
The 4-color `PALETTE` used for evidence highlights SHALL use colours from Paul Tol's Muted set: sky blue `rgba(148, 203, 236, 0.55)`, olive `rgba(220, 205, 125, 0.55)`, rose `rgba(194, 106, 119, 0.45)`, and teal `rgba(93, 168, 153, 0.45)`. These four SHALL remain distinguishable under deuteranopia, protanopia, and tritanopia.

#### Scenario: Palette constants match Paul Tol's Muted values
- **WHEN** `PALETTE` is imported from `evidenceHighlights.ts`
- **THEN** index 0 is sky blue, index 1 is olive, index 2 is rose, index 3 is teal

### Requirement: Focus value dims non-active highlights
`EvidenceHighlightLayer` SHALL accept a `focusValue: string | null` prop. When `focusValue` is non-null, all highlights whose `value` differs from `focusValue` SHALL be drawn with `ctx.globalAlpha = 0.25` (dimmed). The active highlight SHALL be drawn at `ctx.globalAlpha = 1.0` followed by a second draw at `ctx.globalAlpha = 0.6` to increase its effective opacity.

#### Scenario: Non-active highlights are dimmed
- **WHEN** `focusValue` is set to a value matching one highlight
- **THEN** all other highlights are drawn with `ctx.globalAlpha = 0.25`

#### Scenario: Active highlight is intensified
- **WHEN** `focusValue` matches a highlight's value
- **THEN** that highlight is drawn twice (globalAlpha 1.0 then 0.6) for increased opacity

#### Scenario: No focus — all highlights at normal opacity
- **WHEN** `focusValue` is null
- **THEN** all highlights are drawn with `ctx.globalAlpha = 1.0`

### Requirement: Position cache avoids re-searching on focus change
After the main render effect finds each highlight's page and rect coordinates, those positions SHALL be cached in a ref (`cachedEntriesRef`). A separate focus effect with deps `[focusValue, cacheVersion, containerEl]` SHALL read from the cache to scroll and redraw without re-running `findValueRects`.

#### Scenario: Focus changes after cache is populated
- **WHEN** `focusValue` changes after `cacheVersion` has been incremented
- **THEN** the canvas is redrawn from `cachedEntriesRef` (no PDF text search)
- **AND** `containerEl.scrollTo` is called to center the active value's rect

#### Scenario: Focus changes while main search is still running
- **WHEN** `focusValue` changes before `cacheVersion` increments
- **THEN** the focus effect is a no-op (cache is empty; early return on `entries.length === 0`)
- **AND** the main effect's progressive draw respects `focusValueRef.current` when painting each rect
