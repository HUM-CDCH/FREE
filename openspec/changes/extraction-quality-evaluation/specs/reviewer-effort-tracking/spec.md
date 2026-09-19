## ADDED Requirements

### Requirement: Review decisions carry shown/decided timestamps

FREE SHALL capture, per `ReviewDecision`, when its field was first shown to
the researcher (`shownAt`) and when the decision was committed
(`decidedAt`), captured client-side and included in the existing decision-
save payload rather than requiring a new round-trip per interaction.

#### Scenario: Timestamps are present on a saved decision

- **WHEN** a researcher approves, rejects, or edits a field and the
  decision is saved
- **THEN** the saved `ReviewDecision` includes both `shownAt` and
  `decidedAt`

### Requirement: Edit distance is computed for edited decisions only

FREE SHALL compute an edit-distance value between the model's original
value and the researcher's corrected value for every `EDITED` decision.
FREE SHALL NOT compute an edit distance for `REJECTED` decisions, since a
rejection carries no replacement value.

#### Scenario: Edited decision has an edit distance

- **WHEN** a researcher submits an `EDITED` decision
- **THEN** FREE records the edit distance between the original and
  corrected values

#### Scenario: Rejected decision has no edit distance

- **WHEN** a researcher submits a `REJECTED` decision
- **THEN** FREE does not attempt to compute or record an edit distance for
  it

### Requirement: Reviewer effort aggregates into evaluation run metrics

FREE SHALL aggregate timing and edit-distance data across an
`EvaluationRun`'s documents into summary reviewer-effort metrics, alongside
precision/recall/F1.

#### Scenario: Reviewer effort appears in run metrics

- **WHEN** an `EvaluationRun`'s documents have been reviewed with timed,
  edit-distance-tracked decisions
- **THEN** the run's persisted metrics include aggregated reviewer-effort
  figures
