# evidence-highlight-layer Delta Specification

## ADDED Requirements

### Requirement: Highlight coordinates account for the .page element's border

The `EvidenceHighlightLayer` SHALL offset each page's canvas draw origin by the `.page` element's border width so that highlight rectangles align with the PDF content area rather than the border box edge.

#### Scenario: Page has a non-zero transparent border

- **WHEN** the `.page` element has a CSS border (e.g. the 9px transparent border applied by `pdf_viewer.css`)
- **THEN** the highlight rectangles drawn on the canvas are shifted inward by `pageEl.clientTop` (vertically) and `pageEl.clientLeft` (horizontally)
- **AND** the highlights visually align with the text they reference in the PDF content area

#### Scenario: Page has no border

- **WHEN** the `.page` element has no CSS border (`clientTop === 0`, `clientLeft === 0`)
- **THEN** the coordinate calculation is unchanged from the no-border case
- **AND** highlights remain correctly positioned
