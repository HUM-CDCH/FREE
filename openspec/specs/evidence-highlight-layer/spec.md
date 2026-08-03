# Spec: Evidence Highlight Layer

## Purpose

Defines the behaviour of the `EvidenceHighlightLayer` component, which overlays colour-coded highlight markers on a rendered PDF to visually link evidence spans to their corresponding schema fields.
## Requirements
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

### Requirement: Text evidence is located via canonical-Markdown anchors before falling back to PDF text search

`EvidenceHighlightLayer` SHALL attempt to locate a field's evidence by finding its verbatim `snippet` in the canonical Markdown already fetched for the open document and looking up the anchor(s) (see the `evidence-anchor-index` capability) covering that character range, for any evidence not already resolved by the existing table-cell-coordinate lookup. Only when no anchor is found (no anchors available for the document, or the snippet isn't present in the Markdown) SHALL the component fall back to the existing PDF text-search path.

#### Scenario: Anchor lookup resolves a text field's highlight

- **WHEN** a field's snippet is found at some character range in the document's canonical Markdown, and the document's evidence index has an anchor covering that range
- **THEN** the field's highlight is drawn at that anchor's bounding box, on that anchor's page
- **AND** the PDF text-search path is not used for that field

#### Scenario: No anchors available falls back to PDF text search unchanged

- **WHEN** the open document has no anchors (e.g. the bundled demo document, or a task parsed before anchors existed)
- **THEN** evidence location falls back to the existing PDF text-search behavior, unchanged from before this capability existed

#### Scenario: Anchor lookup never uses the field's value directly

- **WHEN** locating a field's evidence via anchors
- **THEN** only the field's `snippet` is used to find a position in the canonical Markdown — the field's `value` is not searched for directly by this lookup tier

### Requirement: Text-position matching tolerates dash-variant characters

`EvidenceHighlightLayer`'s PDF text search (the fallback path used when no anchor is found) SHALL treat en dash, em dash, minus sign, and other common dash-like Unicode characters as equivalent to a plain hyphen when comparing a value or snippet against the page's extracted text, in addition to the existing case-insensitive comparison.

#### Scenario: Value uses a plain hyphen, source PDF uses an en dash

- **WHEN** an evidence value or snippet contains a plain hyphen (`-`) and the corresponding PDF text extracts the visually identical character as an en dash (`–`) or similar dash variant
- **THEN** the text search still locates and highlights the value

### Requirement: A value that cannot be located within its snippet falls back to the snippet's own location

When the PDF text-search fallback path is used and a field's evidence `snippet` is found on a page but the field's exact `value` cannot be located within that snippet's text range or elsewhere on the same page, `EvidenceHighlightLayer` SHALL highlight the snippet's own matched location rather than showing no highlight for that field.

#### Scenario: A normalized/typed field value is not a verbatim substring of its snippet

- **WHEN** a field's snippet is a verbatim excerpt located on page N, but the field's value (e.g. a reformatted number or date) does not appear verbatim within that snippet or elsewhere on page N
- **THEN** the field's highlight is drawn at the snippet's matched location on page N
- **AND** no highlight is silently omitted for that field

#### Scenario: The snippet itself is not found on any page

- **WHEN** a field's snippet cannot be located verbatim on any page (not just the exact value)
- **THEN** the existing whole-document value-search fallback still applies unchanged
- **AND** if that also fails, no highlight is drawn for that field (unchanged from today)

### Requirement: Table-cell value matching tolerates minor textual mismatches

`tableCellMatch.ts`'s candidate collection SHALL fall back to a tolerant comparison — dash-variant and whitespace/punctuation normalization, then a length-gated substring containment match (the shorter of the two normalized strings must be at least 4 characters to be accepted as contained within the longer one) between the extracted value and a cell's text — when no table cell exactly matches the extracted value under today's normalized-equality comparison. The tolerant comparison SHALL only be attempted after the exact comparison finds zero candidates for a table, so behavior is unchanged wherever exact matching already succeeds.

#### Scenario: Minor formatting difference between extracted value and cell text

- **WHEN** an extracted value does not exactly equal any table cell's normalized text, but a cell's text equals the value plus a trailing unit or minor formatting difference (e.g. value `"42"` vs. cell text `"42 cm"`)
- **THEN** that cell becomes a match candidate
- **AND** row/column header disambiguation (existing behavior) runs against this widened candidate set

#### Scenario: Short numeric value does not spuriously match inside a longer number

- **WHEN** an extracted value is a short numeric string under 4 characters (e.g. `"42"`) and a cell contains a longer number that merely contains those digits as a substring (e.g. `"420"`)
- **THEN** that cell is NOT considered a match, because the shorter string falls below the length threshold required for the containment check to apply

#### Scenario: Exact match already succeeds — no behavior change

- **WHEN** a table cell's normalized text already exactly equals the extracted value
- **THEN** candidate collection behaves exactly as before, and the tolerant comparison is never attempted

### Requirement: Table geometry supplied as a new prop

`EvidenceHighlightLayer` SHALL accept a `tables: ParsedTable[]` prop carrying per-document table cell geometry, used only for the coordinate-lookup step described below. Existing props (`pdfViewer`, `result`, `evidence`, `schemaTemplate`, `containerEl`, `focusPath`) SHALL remain unchanged in meaning and behavior.

#### Scenario: Prop omitted or empty

- **WHEN** a caller does not pass `tables`, or passes an empty array
- **THEN** the layer behaves identically to its implementation before this change

### Requirement: Table-cell coordinate lookup precedes text search

For each highlight, `EvidenceHighlightLayer` SHALL attempt to resolve it to a table cell via the table-cell-coordinate-matching logic before running the existing PDF text search. When a match is found, the highlight SHALL be drawn from the matched cell's bounding box (converted from PDF points to viewport pixels using the target page's current viewport scale) instead of searching page text. When no match is found, the highlight SHALL fall back to the pre-existing text-search behavior (snippet-anchored search, then full-text search with progressive query shortening), unchanged.

#### Scenario: Table cell match found

- **WHEN** a highlight's value resolves to a `TableCell` via table-cell-coordinate-matching
- **THEN** the highlight is drawn using that cell's bounding box scaled to the current viewport
- **AND** no PDF text search runs for that highlight

#### Scenario: No table cell match

- **WHEN** table-cell-coordinate-matching returns no match for a highlight (including when the document has no tables)
- **THEN** the highlight is resolved exactly as it was before this change: snippet-anchored search falling back to full-text search

