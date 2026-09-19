## ADDED Requirements

### Requirement: Extracted records are aligned to gold records, not assumed positional

For one document, FREE SHALL align each extracted record to at most one
`GoldRecord` (and vice versa) using: an exact/normalized match on any
schema field marked `identifying`, when at least one such field is
declared; otherwise a minimum-cost assignment over a per-field similarity
score. FREE SHALL NOT assume extracted record `i` corresponds to gold
record `i` by position alone.

#### Scenario: Reordered records still align correctly

- **WHEN** a document's extracted records are in a different order than its
  `GoldRecord`s but share matching values on an `identifying` field
- **THEN** FREE aligns them by that field, not by position

#### Scenario: An omitted record is a recall miss

- **WHEN** a `GoldRecord` has no corresponding extracted record after
  alignment
- **THEN** FREE counts it as a recall miss for every one of its fields

#### Scenario: A hallucinated record is a precision miss

- **WHEN** an extracted record has no corresponding `GoldRecord` after
  alignment
- **THEN** FREE counts it as a precision miss for every one of its fields

### Requirement: Field comparison is exact by default, tolerant only where configured

FREE SHALL compare each matched record pair field by field: string/enum/
boolean fields compare exact after trim and case-fold; numeric fields
(`number`/`integer`) compare exact unless the field's `SchemaNode` declares
an `evaluationTolerance`, in which case a value within that tolerance of the
gold value counts as correct.

#### Scenario: Unconfigured numeric field requires an exact match

- **WHEN** a numeric field has no `evaluationTolerance` configured
- **THEN** a near-miss value (e.g. off by a small amount) is scored
  incorrect

#### Scenario: Configured tolerance credits a near-miss

- **WHEN** a numeric field declares an `evaluationTolerance`
- **THEN** an extracted value within that tolerance of the gold value is
  scored correct

### Requirement: Precision, recall, and F1 are computed from matched-pair and unmatched-record outcomes

FREE SHALL compute, per document and aggregated per `EvaluationRun`:
precision (correct fields over all extracted-field outcomes, including
hallucinated records' fields as incorrect), recall (correct fields over all
gold-field outcomes, including omitted records' fields as missed), and F1
from those two.

#### Scenario: Aggregate metrics reflect both matched-pair errors and unmatched records

- **WHEN** a run's documents include both fields wrong within matched
  records and entire omitted/hallucinated records
- **THEN** the aggregated precision/recall/F1 reflect all of those outcomes
  together, not only matched-pair field comparisons
