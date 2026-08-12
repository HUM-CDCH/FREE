## ADDED Requirements

### Requirement: Exact single-candidate match resolves directly

Given an extracted evidence value V and a set of `ParsedTable`s, the matcher SHALL search all `TableCell`s for normalized (trimmed, whitespace-collapsed, case-insensitive) text equality with V. When exactly one candidate cell is found, that cell SHALL be returned as the match with no further disambiguation.

#### Scenario: Unique value in table

- **WHEN** normalized V equals the text of exactly one `TableCell` across all supplied tables
- **THEN** that cell is returned as the match

#### Scenario: No candidates

- **WHEN** no `TableCell`'s normalized text equals normalized V
- **THEN** the matcher returns no match

### Requirement: Row/column header hints disambiguate duplicate candidates

When more than one candidate cell matches V's text, and the evidence carries a non-empty `rowHeader` and/or `columnHeader` hint, the matcher SHALL narrow candidates to those whose row's row-header cell (role `row_header` or `row_header_hint`) and/or column's header cell (role `header` or `column_header`) has normalized text matching the corresponding hint. When narrowing leaves exactly one candidate, it SHALL be returned as the match.

#### Scenario: Both hints uniquely identify the cell

- **WHEN** multiple `TableCell`s share V's text, and exactly one candidate's row-header and column-header cell text both match the given `rowHeader`/`columnHeader` hints
- **THEN** that candidate is returned as the match

#### Scenario: One hint is enough

- **WHEN** only `rowHeader` (or only `columnHeader`) is provided and non-empty, and filtering on that hint alone narrows candidates to exactly one
- **THEN** that candidate is returned as the match

#### Scenario: Header hints do not narrow to one

- **WHEN** header-hint filtering leaves zero or more than one candidate (including when no hints are provided)
- **THEN** the matcher proceeds to the reading-order positional fallback instead of guessing

### Requirement: Reading-order positional fallback by occurrence index

When header-hint disambiguation does not resolve to exactly one candidate, the matcher SHALL accept an externally-computed occurrence index — the 0-based rank of this evidence value among *other* evidence values sharing the same field key, normalized value, and hint page, counted in document/traversal order (not the value's raw index within a `records` array). The matcher SHALL sort the remaining candidates in reading order — ascending page number, then ascending bbox `y0`, then ascending bbox `x0` — and select the candidate at that occurrence index when it is within range.

A `records` array's raw index is NOT a valid substitute: when `records` is flattened across multiple unrelated tables (e.g. one table per grave), most records don't share the ambiguous value at all, so a raw array index overcounts relative to the actual tied candidates. (Confirmed against a real extraction: two records at array indices 1 and 2 shared a value, but the correct table cells were the 1st and 2nd occurrences of that value — not indices 1 and 2 into the 2-candidate list.)

#### Scenario: Positional fallback picks the Nth tied occurrence

- **WHEN** a value's occurrence index among ties (same field key, value, and hint page) is i, and header-hint filtering did not narrow candidates to exactly one
- **THEN** the remaining candidates are sorted in reading order and the candidate at index i is returned as the match, if i is within range

#### Scenario: Occurrence index is grouped per hint page

- **WHEN** two separate tied pairs for the same field and value exist on different pages
- **THEN** each pair's occurrence indices restart at 0 for its own page, matching how candidates are narrowed to a single page before indexing

#### Scenario: Index out of range

- **WHEN** the occurrence index is greater than or equal to the number of remaining candidates after sorting
- **THEN** the matcher returns no match

#### Scenario: No occurrence index available

- **WHEN** the caller has no occurrence index to supply for this value
- **THEN** the matcher returns no match instead of guessing a candidate

### Requirement: No match is a valid, non-throwing outcome

The matcher SHALL return "no match" (never throw) whenever zero candidates are found, or when disambiguation is inconclusive and no usable occurrence index is available. Callers rely on this to fall back to existing text-search behavior.

#### Scenario: Value not present in any table

- **WHEN** no `TableCell`'s text equals normalized V and no tables are supplied
- **THEN** the matcher returns no match without throwing
