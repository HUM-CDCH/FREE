## ADDED Requirements

### Requirement: A pilot round is a pilot-sized Batch Extraction

The system SHALL treat a `BatchExtraction` at or under the pilot batch size
limit as a pilot round: it uses the same creation, review, and read paths
as any other `BatchExtraction`, with no separate pilot-specific entity or
storage.

#### Scenario: Pilot round creation reuses batch extraction creation

- **WHEN** a researcher selects a pilot-sized set of source documents and
  starts pilot extraction against the current `SchemaRevision`
- **THEN** the system creates a `BatchExtraction` for that selection, the
  same way it would for any batch at that size

### Requirement: Pilot rounds are listed by filtering existing batches

The system SHALL make a `SchemaRevision`'s pilot rounds discoverable by
filtering the existing Batch Extraction listing to that `schemaRevisionId`
and to a pilot-sized member count, without a separate query or storage.

#### Scenario: Round list reflects prior pilot batches

- **WHEN** a researcher has created two pilot-sized `BatchExtraction`s
  against the same `SchemaRevision`
- **THEN** both are included when listing that revision's pilot rounds
- **AND** a batch exceeding the pilot batch size limit is not included

### Requirement: A prior pilot round remains independently viewable

The system SHALL keep every prior pilot `BatchExtraction` fully readable
(including its members' results) after a later Batch Extraction is created,
regardless of whether that later batch reuses any of the same documents'
results.

#### Scenario: Opening an older pilot round after a later batch reuses its result

- **WHEN** a document's reviewed result from an earlier pilot
  `BatchExtraction` is reused in a later `BatchExtraction`
- **THEN** the earlier pilot `BatchExtraction` can still be opened and its
  own member result read without error

### Requirement: Soft stabilise-readiness signal

After a pilot round is reviewed, the system SHALL compare that round's mean
per-document issue score to the immediately preceding pilot round's mean
issue score, if one exists, and SHALL display a dismissible suggestion that
the researcher may be ready to stabilise when the score has not increased.
This signal SHALL be advisory only and SHALL NOT block or gate further
pilot rounds or the stabilise action.

#### Scenario: Declining issue score shows a suggestion

- **WHEN** a completed pilot round's mean issue score is less than or equal
  to the immediately preceding pilot round's mean issue score
- **THEN** the system displays a dismissible "you may be ready to
  stabilise" suggestion

#### Scenario: Signal never blocks further action

- **WHEN** the suggestion is shown or not shown
- **THEN** the researcher can still start another pilot round or attempt to
  stabilise the schema without restriction from this signal
