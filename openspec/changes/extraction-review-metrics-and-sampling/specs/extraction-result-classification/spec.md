## ADDED Requirements

### Requirement: Single-pass three-way leaf classification

FREE SHALL classify every leaf field of an extraction's schema into exactly
one of three categories — `grounded` (has a value and an evidence link),
`ungroundedWithValue` (has a value, no evidence link), `missing` (no value)
— using one traversal over the schema's leaf nodes cross-referenced against
that extraction's `result` payload and evidence/grounded-paths set. The sum
of the three counts SHALL equal the total leaf field count for that
extraction.

#### Scenario: All three categories present

- **WHEN** an extraction's result has some leaf fields with grounded values,
  some with values but no evidence link, and some with no value at all
- **THEN** the classification reports non-zero counts in the corresponding
  categories
- **AND** `grounded + ungroundedWithValue + missing` equals the schema's
  total leaf field count

#### Scenario: Empty array leaf

- **WHEN** a leaf field's value is an empty array
- **THEN** it is classified as `missing`
- **AND** it is counted exactly once, not duplicated or omitted from the
  total

#### Scenario: Classification is independent of resultStats/grounding internals

- **WHEN** `resultStats.ts`'s missing count or `grounding.ts`'s
  ungrounded-paths count would disagree with each other on a given result
  (e.g. due to their differing array-traversal rules)
- **THEN** the three-way classification is unaffected, since it is computed
  directly from schema leaves and does not derive any category by
  subtracting those two metrics from each other

### Requirement: Single-document finished dialog shows the three-way breakdown

`ExtractionFinishedDialog` SHALL display the three category counts (grounded,
ungrounded-with-value, missing) for the completed extraction, replacing the
prior two-bucket (grounded / could-not-be-grounded) display.

#### Scenario: Dialog renders three counts

- **WHEN** a single-document extraction finishes and the dialog opens
- **THEN** the dialog shows the field count and the grounded,
  ungrounded-with-value, and missing counts for that extraction
