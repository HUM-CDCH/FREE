## ADDED Requirements

### Requirement: Plain-text matching disambiguates repeated values by occurrence index

When a value or value-within-snippet query matches more than one location in the searched text, `EvidenceHighlightLayer`'s plain-text search SHALL select the occurrence at the highlight's `occurrenceIndex` (computed by `computeOccurrenceIndices`, ranking the highlight among other highlights sharing the same field key, normalized value, and hint page) when that index falls within the number of occurrences found, rather than unconditionally returning the first occurrence found in the text.

#### Scenario: Repeated value across multiple records resolves to the matching occurrence

- **WHEN** a page's text contains the same value string more than once, and more than one highlight shares that exact (field key, normalized value, hint page) triple
- **THEN** each highlight's rendered highlight rect corresponds to the occurrence matching its own `occurrenceIndex`, not always the first occurrence on the page

#### Scenario: occurrenceIndex absent or out of range falls back to the first occurrence

- **WHEN** a query matches one or more locations but `occurrenceIndex` is `null` or falls outside the number of occurrences found
- **THEN** the first occurrence found is used, unchanged from today's behavior

#### Scenario: Single occurrence is unaffected

- **WHEN** a query matches exactly one location in the searched text
- **THEN** that occurrence is used regardless of `occurrenceIndex`

### Requirement: Page-anchored fallback search exhausts specificity tiers before widening to other pages

`findValueRects`'s progressive query-shortening fallback (full value, then truncated to 5 words, then 3 words) SHALL try every tier against a given page — the hint page first, when one is provided — before searching any other page, rather than trying every page at one specificity tier before moving to the next tier.

#### Scenario: Hint page matches at a shorter tier before another page matches at full specificity

- **WHEN** the full-length value query does not match on the hint page but a shortened (5-word or 3-word) query does match on the hint page, and the full-length query also happens to match on a different page
- **THEN** the highlight resolves to the hint page's shortened-tier match, not the other page's full-length match

#### Scenario: Hint page has no match at any tier

- **WHEN** none of the query tiers match anywhere on the hint page
- **THEN** the search proceeds to other pages, unchanged from today's behavior
