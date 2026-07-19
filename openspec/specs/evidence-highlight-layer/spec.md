<!-- markdownlint-disable MD013 -->

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
- **AND** the main effect's progressive draw respects the current focus path when painting each rect

### Requirement: Highlight source uses direct text-layer search, not model-provided evidence

The `EvidenceHighlightLayer` SHALL accept the clean extraction result object and locate each extracted string value by searching the PDF text layer directly, rather than relying on model-provided `{snippet, page}` evidence fields.

#### Scenario: Extracted string value found in text layer

- **WHEN** the extraction result contains a string leaf value
- **AND** that string (or a prefix of it) is found in `pdfPage.getTextContent()` on any page
- **THEN** the component draws a highlight rectangle over the matching text items on the canvas overlay
- **AND** the highlight color corresponds to the top-level key that contains this leaf value (cycling through a 4-color palette)

#### Scenario: Value not found after progressive shortening

- **WHEN** neither the full value, its 5-word prefix, nor its 3-word prefix is found in the text layer
- **THEN** no rectangle is drawn for that value
- **AND** other values continue to be processed

#### Scenario: Result contains non-string leaves

- **WHEN** a result leaf is a number, boolean, or null
- **THEN** that leaf is skipped (not searchable as text)

### Requirement: Highlight coordinates account for CSS_UNITS scale factor

The `EvidenceHighlightLayer` SHALL multiply `pdfViewer.currentScale` by `96.0 / 72.0` (CSS_UNITS) when calling `pdfPage.getViewport()`, matching the scale factor PDF.js uses internally when rendering pages.

#### Scenario: Viewport scale matches rendered page

- **WHEN** text-content coordinates are converted to CSS pixel positions
- **THEN** the resulting rectangles are the same size and position as the corresponding rendered glyphs
- **AND** highlights do not appear shrunk or displaced towards the upper-left

### Requirement: Highlight coordinates account for the .page element's border

The `EvidenceHighlightLayer` SHALL offset each page's canvas draw origin by the `.page` element's border width so that highlight rectangles align with the PDF content area rather than the border-box edge.

#### Scenario: Page has a non-zero transparent border

- **WHEN** the `.page` element has a CSS border (e.g. the 9px transparent border applied by `pdf_viewer.css`)
- **THEN** the highlight rectangles drawn on the canvas are shifted inward by `pageEl.clientTop` (vertically) and `pageEl.clientLeft` (horizontally)
- **AND** the highlights visually align with the text they reference in the PDF content area

#### Scenario: Page has no border

- **WHEN** the `.page` element has no CSS border (`clientTop === 0`, `clientLeft === 0`)
- **THEN** the coordinate calculation is unchanged from the no-border case
- **AND** highlights remain correctly positioned
