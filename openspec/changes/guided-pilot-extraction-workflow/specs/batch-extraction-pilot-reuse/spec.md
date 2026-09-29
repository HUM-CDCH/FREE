## ADDED Requirements

### Requirement: Batch extraction reuses an already-reviewed pilot result without re-running it

The system SHALL reuse an already-reviewed `Extraction`'s result (value,
evidence, and review decisions) for a new `BatchExtraction`'s member
instead of re-running extraction, whenever a selected source document
already has a reviewed `Extraction` (`reviewedAt` set) against that same
`schemaRevisionId`, source representation, and strategy. Reuse SHALL be
implemented by creating a new `Extraction` record for the new batch that
carries the same result, rather than moving the original record, so that
the original's own Batch Extraction remains independently readable.

#### Scenario: Already-reviewed pilot document is reused without re-extraction

- **WHEN** a batch extraction is created for a document that already has a
  reviewed `Extraction` under the batch's `schemaRevisionId`
- **THEN** the batch member's result carries that reviewed value and
  evidence
- **AND** no model call is made for that document as part of the batch

#### Scenario: Reused result's review decisions are preserved

- **WHEN** a reused document's original `Extraction` was reviewed with
  edited (corrected) values
- **THEN** reading the new batch member's result reflects those same
  corrected values, not the original unreviewed model output

#### Scenario: Reusing a result does not disturb its original Batch Extraction

- **WHEN** a document's reviewed result is reused into a new
  `BatchExtraction`
- **THEN** the `BatchExtraction` the original `Extraction` belongs to
  remains fully readable, unaffected by the reuse

#### Scenario: Documents without a prior reviewed extraction are extracted normally

- **WHEN** a batch extraction is created for a document with no reviewed
  `Extraction` under the batch's `schemaRevisionId`
- **THEN** the system creates a new `Extraction` for that document as part
  of the batch, as it does today

#### Scenario: Batch is a mix of reused and fresh extractions

- **WHEN** a batch extraction's selected documents include both
  already-reviewed pilot documents and documents never before extracted
  under the current revision
- **THEN** the resulting `BatchExtraction` contains reused results for the
  former and freshly created `Extraction`s for the latter
- **AND** both kinds of members are reported consistently in the batch's
  results and snapshot views
