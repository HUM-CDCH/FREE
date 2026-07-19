# evidence-highlight-layer Delta Specification

## CHANGED Requirements

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
