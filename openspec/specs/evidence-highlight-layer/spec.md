<!-- markdownlint-disable MD013 -->

# Spec: Evidence Highlight Layer

## Purpose

Defines how the Studio overlays color-coded, path-selectable evidence markers on rendered PDF pages.

## Requirements

### Requirement: Schema-reactive highlight colors

The `EvidenceHighlightLayer` component SHALL assign highlight colors based on top-level key order in the extraction schema template, cycling through a fixed four-color palette. Color assignment SHALL remain stable when only the extraction result changes.

#### Scenario: Each schema field gets a palette slot

- **WHEN** the extraction schema has N top-level keys
- **THEN** the k-th key is assigned `PALETTE[k % 4]`
- **AND** adjacent schema keys use adjacent palette slots

#### Scenario: Schema prop changes after result is displayed

- **WHEN** `schemaTemplate` changes without a new extraction or viewer redraw
- **THEN** existing cached highlights retain their colors until the main render effect next runs

#### Scenario: Result key is not found in schema

- **WHEN** the model returns a top-level key absent from the schema
- **THEN** its color falls back to the record's top-level iteration order

### Requirement: Colorblind-accessible highlight palette

The four-color `PALETTE` SHALL use Paul Tol's Muted colors: sky blue `rgba(148, 203, 236, 0.55)`, olive `rgba(220, 205, 125, 0.55)`, rose `rgba(194, 106, 119, 0.45)`, and teal `rgba(93, 168, 153, 0.45)`.

#### Scenario: Palette constants match the selected values

- **WHEN** `PALETTE` is imported from `evidenceHighlights.ts`
- **THEN** indexes zero through three contain sky blue, olive, rose, and teal in that order

### Requirement: Result-path focus dims non-active highlights

`EvidenceHighlightLayer` SHALL accept a `focusPath: string[] | null` prop. With focus, highlights at other paths SHALL be painted once at alpha `0.15`, and rectangles at the selected path SHALL be painted once at alpha `0.75`. With no focus, all highlights SHALL be painted once at alpha `0.4`.

#### Scenario: Duplicate values remain independently selectable

- **WHEN** two leaves have the same value but different paths
- **AND** one path is selected
- **THEN** only the selected path uses alpha `0.75`
- **AND** the duplicate at the other path uses alpha `0.15`

#### Scenario: Clear focus restores normal opacity

- **WHEN** `focusPath` is `null`
- **THEN** every cached rectangle is painted once at alpha `0.4`

#### Scenario: Active highlight is not double-painted

- **WHEN** the canvas is repainted with a selected path
- **THEN** every cached rectangle receives exactly one fill

### Requirement: Position cache avoids re-searching on focus change

After the main render effect locates each highlight's page and rectangles, those positions SHALL be cached. Focus changes SHALL scroll and repaint from the cache without re-running PDF text search.

#### Scenario: Focus changes after cache is populated

- **WHEN** `focusPath` changes after cached entries exist
- **THEN** the canvas is repainted from the cache
- **AND** the viewer scrolls to center the first rectangle at the selected path

#### Scenario: Focus changes during progressive search

- **WHEN** `focusPath` changes while highlight locations are still being found
- **THEN** cached entries and subsequent progressive paints use the current path

### Requirement: Highlight source uses evidence metadata with direct-search fallback

The layer SHALL build highlights from extraction-result leaves. Non-empty `_evidence` snippets and numeric page hints SHALL guide lookup when present. When usable evidence is absent, the displayed scalar value SHALL be searched directly. Evidence metadata itself SHALL NOT be painted as extracted content.

#### Scenario: Evidence-guided scalar is located

- **WHEN** a string, finite number, or boolean leaf has a non-empty evidence snippet
- **THEN** that snippet and optional page hint guide lookup
- **AND** the highlight retains the leaf path and top-level color

#### Scenario: Scalar without usable evidence falls back to direct search

- **WHEN** a searchable scalar lacks a non-empty snippet
- **THEN** its full value and existing shortened prefixes are searched
- **AND** a failed lookup does not stop other values

#### Scenario: Evidence metadata is excluded

- **WHEN** a result contains `_evidence`
- **THEN** metadata fields are not emitted as standalone highlights

#### Scenario: Non-searchable leaves are ignored

- **WHEN** a leaf is null, undefined, or a non-finite number
- **THEN** no search is created for it

### Requirement: Highlight coordinates account for CSS units

The layer SHALL multiply `pdfViewer.currentScale` by `96 / 72` when creating the PDF page viewport, matching PDF.js CSS rendering units.

#### Scenario: Viewport scale matches the rendered page

- **WHEN** text coordinates are converted to CSS pixel positions
- **THEN** highlight rectangles align with the rendered glyphs

### Requirement: Highlight coordinates account for page borders

The layer SHALL add the page element's `clientTop` and `clientLeft` offsets so rectangles align with the PDF content area rather than the border box.

#### Scenario: Page has a non-zero border

- **WHEN** the PDF.js page element has a border
- **THEN** rectangle origins are shifted inward by the page's client offsets

#### Scenario: Page has no border

- **WHEN** both client offsets are zero
- **THEN** coordinate placement is unchanged
