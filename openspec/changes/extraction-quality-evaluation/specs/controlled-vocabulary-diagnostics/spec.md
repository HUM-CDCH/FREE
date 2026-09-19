## ADDED Requirements

### Requirement: An out-of-vocabulary coercion is recorded, never silently invisible

FREE SHALL record a diagnostic event `{resultPath, rawValue, allowedValues}`
whenever `coerceAllowedValue` cannot match a value to a member of a field's
`allowedValues` (case/whitespace-normalized) and keeps it verbatim, recorded
alongside the extraction's existing diagnostics. FREE SHALL NOT change
`coerceAllowedValue`'s existing behavior of keeping the value verbatim.

#### Scenario: An out-of-vocabulary value is both kept and reported

- **WHEN** a closed-set field's extracted value does not match any member
  of `allowedValues`, even after case/whitespace normalization
- **THEN** the field's value remains the model's original verbatim string
- **AND** a diagnostic event for that field is recorded on the extraction

#### Scenario: A matched or normalized value produces no event

- **WHEN** a closed-set field's value exactly matches or case/whitespace-
  normalizes to an `allowedValues` member
- **THEN** no diagnostic event is recorded for that field

### Requirement: Vocabulary-violation counts are available per evaluation run

FREE SHALL aggregate controlled-vocabulary diagnostic events across an
`EvaluationRun`'s documents into a count, alongside its precision/recall/F1
metrics.

#### Scenario: Vocabulary violations surface in run metrics

- **WHEN** an `EvaluationRun`'s extractions produced controlled-vocabulary
  diagnostic events
- **THEN** the run's persisted metrics include their total count
