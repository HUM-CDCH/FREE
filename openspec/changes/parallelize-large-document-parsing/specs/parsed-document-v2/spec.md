## MODIFIED Requirements

### Requirement: Parser and table authority

Docling SHALL provide canonical table semantics. Camelot SHALL be used only
for exact-match monotonic geometry enrichment of a Docling table.
Camelot-only candidates SHALL remain diagnostics and SHALL NOT be published
as canonical tables. PaddleOCR SHALL be the page-level text fallback; a
PyMuPDF text fallback SHALL NOT be introduced by this change. PyMuPDF MAY be
used internally, limited to partition split-point placement and
boundary-table-continuation geometry checks for large-document parallel
parsing; its output SHALL NOT be published as canonical table or text
content and SHALL NOT substitute for Docling's table semantics or
PaddleOCR's text fallback.

#### Scenario: Camelot has no matching Docling inventory

- **WHEN** Camelot returns a table without an exact Docling semantic match
- **THEN** the candidate is retained only as an internal diagnostic and no
  canonical table is published from it

#### Scenario: PyMuPDF geometry informs a partition boundary decision

- **WHEN** PyMuPDF's table-detection geometry is used to place a partition
  split point or to decide whether two boundary-adjacent tables should be
  stitched
- **THEN** the published table's cell content and structure still come only
  from Docling, and no PyMuPDF-derived text or cell is published
