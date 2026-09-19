## ADDED Requirements

### Requirement: An evaluation run pins one schema revision and one corpus version, and persists computed metrics

FREE SHALL create an `EvaluationRun` by re-extracting an
`EvaluationCorpus`'s documents at a specific `SchemaRevision` (reusing the
batch-retry capability against that fixed document set rather than
not-yet-reviewed production members), scoring the result against that
specific `EvaluationCorpusVersion`'s `GoldRecord`s (per
`record-alignment-scoring`), and persisting the resulting metrics on the
`EvaluationRun` itself. FREE SHALL NOT recompute an existing
`EvaluationRun`'s metrics from current corpus/schema state.

#### Scenario: A later gold correction does not change a past run's reported metrics

- **WHEN** an `EvaluationCorpusVersion` referenced by an existing
  `EvaluationRun` is superseded by a corrected version
- **THEN** the existing `EvaluationRun`'s persisted metrics are unchanged

#### Scenario: Running the same corpus at a new schema revision produces a new, comparable run

- **WHEN** a researcher creates a new `SchemaRevision` and runs an
  evaluation against the same `EvaluationCorpusVersion` used by a prior run
- **THEN** FREE creates a new `EvaluationRun` referencing the new
  `SchemaRevision` and the same `EvaluationCorpusVersion`
- **AND** both runs' metrics remain independently available for comparison

### Requirement: A single document can be validated without running a full batch

FREE SHALL support creating an `EvaluationRun` for one extraction attempt of
one document (not a whole `EvaluationCorpus` batch), when that document
belongs to an `EvaluationCorpusVersion`, using the same scoring computation
`record-alignment-scoring` uses for a batch run. FREE SHALL present the same
metrics shape (precision/recall/F1, and every other metric category this
change adds) for a single-document run as for a batch run, computed over
one document instead of a corpus.

#### Scenario: Validating one document does not require a corpus batch run

- **WHEN** a researcher validates a single extraction attempt whose
  document belongs to an `EvaluationCorpusVersion`
- **THEN** FREE computes and persists an `EvaluationRun` for that one
  document without extracting or scoring any other corpus document

#### Scenario: Single-document and batch runs report the same metric shape

- **WHEN** comparing a single-document `EvaluationRun` to a batch
  `EvaluationRun` against the same `EvaluationCorpusVersion`
- **THEN** both expose the same metric categories (precision, recall, F1,
  and the other categories this change defines), differing only in how many
  documents were scored

### Requirement: Metrics are viewable across cycles for the same corpus version

FREE SHALL allow listing every `EvaluationRun` that references a given
`EvaluationCorpusVersion`, ordered by the `SchemaRevision`'s sequence, so
metric trends across refinement cycles can be read directly.

#### Scenario: Trend across three refinement cycles

- **WHEN** three `EvaluationRun`s exist against the same
  `EvaluationCorpusVersion`, from three successive `SchemaRevision`s
- **THEN** FREE returns all three with their metrics and revision ordering
  intact
