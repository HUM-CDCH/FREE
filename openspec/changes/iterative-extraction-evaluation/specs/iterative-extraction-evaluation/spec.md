## ADDED Requirements

### Requirement: Readiness starts the fixed three-round pipeline

FREE SHALL start the evaluation pipeline once a Project Context has both the
uploaded gold spreadsheet (with answer rows) and at least one ingested source
document, without any further developer action. The pipeline SHALL run a pilot
over two documents, a second pilot over the same two documents, then a batch
over every uploaded document. It SHALL require no surface action such as
registering a round, starting a run, reviewing, or finalizing, and SHALL add no
authenticated evaluation route to the Parsing Service.

#### Scenario: A ready Project Context starts the pipeline

- **WHEN** a Project Context has the uploaded gold sheet and at least one
  ingested source document
- **THEN** the watcher runs the three rounds and their metrics become readable
  without any further action

#### Scenario: Both pilots use the same two documents

- **WHEN** the pipeline runs its pilot rounds
- **THEN** both pilots use the same two documents and the batch uses every
  uploaded document

#### Scenario: No run, register or review action exists

- **WHEN** the pipeline is enabled
- **THEN** starting, reviewing and reporting are automatic, and the developer
  surface offers no run, register or finalize action

#### Scenario: A missing input starts nothing

- **WHEN** documents are uploaded without a gold spreadsheet, or the reverse
- **THEN** the watcher does not start and the missing input is named as required

### Requirement: The schema comes from the gold header row

The pipeline SHALL build its Extraction Schema from the gold sheet's field
columns: each column becomes a plain string field in sheet order, with the
record scope following the configured strategy (`document` for Article,
`records` for Catalog). Column names SHALL map to fields deterministically, so
the gold columns and the extracted values line up without a hand-authored
schema.

#### Scenario: Gold columns become the schema

- **WHEN** the pipeline starts for an Article Project Context
- **THEN** the schema has one document-level record whose fields are the gold
  field columns in order, and no column is invented or dropped

### Requirement: Each round pins its inputs and its read cuts

A round SHALL pin the Project Context, the gold corpus version and its content
digest, the documents it read, the Schema Revision and Extraction Method, and
the result snapshot and decision version the metrics read. A later run SHALL
append a new evaluation revision rather than change a stored one.

#### Scenario: A round records its pins

- **WHEN** a round stores metrics
- **THEN** it names the gold version, documents, Schema Revision, Extraction
  Method and the result and decision versions it read

#### Scenario: A later run appends

- **WHEN** the pipeline runs again for the same Project Context
- **THEN** the new rounds are appended and the earlier evaluation revisions
  remain readable

### Requirement: The pipeline runs automatically and resumably

With the developer switch enabled, readiness SHALL start the pipeline with no
further human action, and an interrupted run SHALL continue from its completed
cells instead of repeating finished model work. With the switch off, no watcher
runs and no panel is registered.

#### Scenario: An interrupted run resumes

- **WHEN** the pipeline is interrupted after completing some documents
- **THEN** a continued run reuses the completed cells and extracts only the
  remaining work

#### Scenario: The switch off changes nothing

- **WHEN** the developer switch is off
- **THEN** no evaluation runs and no evaluation panel is registered

### Requirement: Value metrics are scored from aligned records

A round's report SHALL include micro, macro and per-field precision, recall and
F1 for populated values, scored after record alignment. Records SHALL be aligned
before values are compared: one-to-one and mutually by the record-identity field
(the configured `identity`, defaulting to `amino_acid_hydroxyproline_value` when
that field exists and to the first field otherwise). A record that does not
align SHALL be reported and SHALL NOT be counted as correct. A failed or missing
member SHALL be reported and SHALL NOT be counted as a correct prediction.

#### Scenario: A populated value differs

- **WHEN** an aligned field's predicted values differ from the gold values after
  normalization
- **THEN** the shared values are true positives, the prediction-only values are
  false positives and the gold-only values are false negatives

#### Scenario: Records align before comparison

- **WHEN** a Catalog result has several records
- **THEN** predicted records align one-to-one and mutually to gold rows by the
  record-identity field before fields are compared, and an unmatched record is
  reported separately rather than scored as a match

#### Scenario: An ambiguous identity aligns nothing

- **WHEN** two gold rows or two predicted records share one identity value
- **THEN** that key aligns no pair and both sides are reported as unmatched

#### Scenario: A member fails

- **WHEN** a member Extraction has no readable result
- **THEN** the report identifies that member and does not attribute its gold
  values as a correct prediction

#### Scenario: Gold is not exhaustive

- **WHEN** the pinned gold version is not exhaustive and a prediction has no
  gold counterpart
- **THEN** the prediction is reported as an unscored extra and the convention is
  stated with the metrics

### Requirement: Evidence-anchor coverage is reported per round

A round's report SHALL include evidence-anchor coverage: the share of populated,
grounding-eligible record leaves that carry at least one locatable Evidence
anchor, with the eligible denominator reported beside the raw one. The metric
SHALL be named coverage and SHALL NOT be presented as semantic correctness.

#### Scenario: A populated eligible value has an anchor

- **WHEN** a populated record leaf is eligible for grounding and carries a
  locatable Evidence anchor
- **THEN** it counts in the coverage numerator and denominator

#### Scenario: A policy-skipped value is excluded

- **WHEN** a populated record leaf is not eligible for grounding under its
  schema evidence policy
- **THEN** it is excluded from the eligible denominator and reported separately

#### Scenario: Coverage is not correctness

- **WHEN** a round's report presents evidence-anchor coverage
- **THEN** it states that a link is coverage, not independent proof that the
  value is entailed

### Requirement: Shadow-reviewer effort is counted without writing review state

A round SHALL report shadow-reviewer effort as the number of value changes
needed to turn the round's saved values into the gold answers, classified as
edited, rejected, added and deleted, with their sum as the effort. A shadow
review SHALL write no Review Decision, correction or finalization and SHALL
leave durable review state unchanged.

#### Scenario: A value is replaced

- **WHEN** a field keeps values but a value differs from gold
- **THEN** the change is counted as an edit

#### Scenario: A field must be emptied

- **WHEN** a field has predicted values and gold has none
- **THEN** the change is counted as a rejection

#### Scenario: A value must be supplied

- **WHEN** a field has no predicted values and gold supplies values
- **THEN** the change is counted as an addition

#### Scenario: An extra value must be dropped

- **WHEN** a field keeps some values and gold has fewer
- **THEN** each dropped value is counted as a deletion

#### Scenario: Shadow review leaves review state untouched

- **WHEN** a round is evaluated
- **THEN** no review decision, correction, decision version or finalization is
  created or changed

### Requirement: Each round's shadow review feeds the next round

FREE SHALL carry pilot-1's shadow-review differences into pilot-2 as
evaluation-only guidance and pilot-2's into the batch, without writing a durable
correction or Project guidance. The report SHALL label the review-fed rounds and
separate the same-pair change from the batch's transfer to the remaining
documents.

#### Scenario: The second pilot carries the first pilot's review

- **WHEN** pilot-1 has been shadow-reviewed against the gold version
- **THEN** pilot-2 extracts with those value differences as guidance and writes
  no durable correction

#### Scenario: The batch carries the second pilot's review

- **WHEN** pilot-2 has been shadow-reviewed against the gold version
- **THEN** the batch extracts with pilot-2's value differences as guidance

#### Scenario: Review-fed rounds are labelled

- **WHEN** a report presents pilot-2 or the batch
- **THEN** it labels that round as review-fed and does not present it as an
  independent measurement

### Requirement: The developer surface stays owned and switch-gated

The evaluation surface SHALL be registered only when the developer switch is
enabled, and then SHALL list and read only rounds of Project Contexts owned by
the authenticated Researcher Account. Round history SHALL remain readable with
the gold version and cuts each revision used.

#### Scenario: An owner reads their rounds

- **WHEN** an authenticated account requests the rounds of a Project Context it
  owns
- **THEN** it receives that Project Context's rounds with their metrics and pins

#### Scenario: A non-owner cannot read rounds

- **WHEN** an account requests rounds of a Project Context it does not own
- **THEN** the request is refused as not found

#### Scenario: Round history is retained

- **WHEN** a round is evaluated again at a new decision cut
- **THEN** the earlier evaluation revision remains readable with its own gold
  version and cuts
