## ADDED Requirements

### Requirement: Anchor-supports-value judgments are independent of value correctness

FREE SHALL allow an expert to judge, for a given document and result path
within an `EvaluationCorpusVersion`, whether the claimed evidence anchor
actually supports its extracted value — independent of whether that value
matches the `GoldRecord`. FREE SHALL NOT infer this judgment automatically
from value correctness.

#### Scenario: A correct value can still have a wrong-anchor judgment

- **WHEN** an extracted value matches its `GoldRecord` field exactly
- **THEN** an expert may still judge its cited evidence anchor as not
  supporting that value

#### Scenario: Judgments do not require a full gold-value annotation pass

- **WHEN** an expert judges a sample of anchors for a document
- **THEN** FREE does not require every judged claim to also have a
  `GoldRecord` field annotated

### Requirement: Evidence Anchor accuracy aggregates into evaluation run metrics

FREE SHALL compute an Evidence Anchor accuracy score (share of judged
claims where the anchor was judged to support its value) and include it in
an `EvaluationRun`'s persisted metrics whenever judgments exist for that
run's corpus version.

#### Scenario: Accuracy reflects only judged claims

- **WHEN** only a sample of an `EvaluationRun`'s claims have anchor
  judgments
- **THEN** the accuracy score is computed over the judged sample, not
  extrapolated to unjudged claims
