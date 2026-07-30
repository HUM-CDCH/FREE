## ADDED Requirements

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
